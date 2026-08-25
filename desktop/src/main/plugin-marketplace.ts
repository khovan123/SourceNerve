import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 12 * 1024 * 1024;
const MAX_PLUGINS = 128;
const MAX_FILES_PER_PLUGIN = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const STAGE_CONCURRENCY = 8;
const CACHE_MARKER = ".sourcenerve-marketplace.json";

export const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://raw.githubusercontent.com/openai/plugins/main/.agents/plugins/marketplace.json";

const SOURCENERVE_PLUGIN_BASE_URL =
  "https://raw.githubusercontent.com/khovan123/SourceNerve/main/plugins/sourcenerve/";

export interface RemotePluginCatalogEntry {
  catalogId: string;
  category?: string;
  baseUrl: string;
  files: string[];
  fingerprint?: string;
}

export interface StagedRemotePluginEntry {
  catalogId: string;
  category?: string;
  sourcePath: string;
  blocker?: string;
}

interface GitHubMarketplaceLocation {
  owner: string;
  repo: string;
  ref: string;
}

interface GitHubTreeFile {
  path: string;
  sha: string;
  size?: number;
}

export async function stageRemotePluginCatalog(
  registryUrl: string,
  cacheRoot: string,
): Promise<StagedRemotePluginEntry[]> {
  const registry = await publicHttpsUrl(registryUrl, "Plugin registry URL");
  const response = await safeFetch(registry);
  const raw = await readBounded(response, MAX_REGISTRY_BYTES, "Plugin registry response");
  if (!response.ok) throw new Error(`Plugin registry request failed with HTTP ${response.status}`);

  let entries: RemotePluginCatalogEntry[];
  const parsed = parseJson(raw, "Plugin registry");
  if (parsed.schemaVersion === 1) {
    entries = parseRemotePluginRegistry(raw);
  } else {
    entries = await expandCodexMarketplace(parsed, registry);
  }

  if (registry.toString() === DEFAULT_PLUGIN_REGISTRY_URL && !entries.some((entry) => entry.catalogId === "sourcenerve")) {
    entries.push(sourceNervePluginEntry());
  }
  if (entries.length > MAX_PLUGINS) entries = entries.slice(0, MAX_PLUGINS);

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const result = new Array<StagedRemotePluginEntry>(entries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(STAGE_CONCURRENCY, Math.max(1, entries.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      try {
        const sourcePath = await stageRemotePackage(entry, cacheRoot);
        result[index] = {
          catalogId: entry.catalogId,
          ...(entry.category ? { category: entry.category } : {}),
          sourcePath,
        };
      } catch (error) {
        result[index] = {
          catalogId: entry.catalogId,
          ...(entry.category ? { category: entry.category } : {}),
          sourcePath: entry.baseUrl,
          blocker: safeMessage(error),
        };
      }
    }
  });
  await Promise.all(workers);
  return result;
}

export function parseRemotePluginRegistry(raw: string): RemotePluginCatalogEntry[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Plugin registry response exceeds the Desktop size limit");
  }
  const parsed = parseJson(raw, "Plugin registry");
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
    throw new Error("Plugin registry has invalid schema");
  }
  if (parsed.plugins.length > MAX_PLUGINS) {
    throw new Error("Plugin registry exceeds the Desktop plugin limit");
  }

  const result: RemotePluginCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.plugins) {
    if (!isRecord(candidate) || !isRecord(candidate.source)) continue;
    if (candidate.source.source !== "https") continue;
    const catalogId = identifier(candidate.name, "registry plugin name");
    if (seen.has(catalogId)) throw new Error(`Plugin registry contains duplicate plugin ${catalogId}`);
    seen.add(catalogId);
    const category = optionalText(candidate.category, 128);
    const baseUrl = httpsUrl(candidate.source.baseUrl, `Plugin ${catalogId} base URL`).toString();
    const files = remoteFiles(candidate.source.files, catalogId);
    result.push({
      catalogId,
      ...(category ? { category } : {}),
      baseUrl,
      files,
    });
  }
  return result;
}

async function expandCodexMarketplace(
  parsed: Record<string, unknown>,
  registry: URL,
): Promise<RemotePluginCatalogEntry[]> {
  if (!Array.isArray(parsed.plugins)) throw new Error("Codex plugin marketplace has invalid schema");
  if (parsed.plugins.length > MAX_PLUGINS) throw new Error("Codex plugin marketplace exceeds the Desktop plugin limit");

  const location = rawGitHubMarketplaceLocation(registry);
  if (!location) {
    throw new Error(
      "Standard Codex marketplace discovery currently requires a public raw.githubusercontent.com marketplace URL",
    );
  }
  const tree = await fetchGitHubTree(location);
  const result: RemotePluginCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const candidate of parsed.plugins) {
    if (!isRecord(candidate) || !isRecord(candidate.source)) continue;
    if (candidate.source.source !== "local" || typeof candidate.source.path !== "string") continue;
    if (isRecord(candidate.policy) && candidate.policy.installation !== undefined && candidate.policy.installation !== "AVAILABLE") {
      continue;
    }

    const catalogId = identifier(candidate.name, "marketplace plugin name");
    if (seen.has(catalogId)) throw new Error(`Codex marketplace contains duplicate plugin ${catalogId}`);
    seen.add(catalogId);
    const packagePath = repositoryRelativePath(candidate.source.path, catalogId);
    const prefix = `${packagePath}/`;
    const selected = tree.filter((file) => {
      if (!file.path.startsWith(prefix)) return false;
      const relative = file.path.slice(prefix.length);
      return relative === ".codex-plugin/plugin.json"
        || relative === ".mcp.json"
        || (relative.startsWith("skills/") && relative.endsWith("/SKILL.md"));
    });
    const manifest = selected.find((file) => file.path === `${packagePath}/.codex-plugin/plugin.json`);
    if (!manifest) {
      result.push({
        catalogId,
        ...(optionalText(candidate.category, 128) ? { category: optionalText(candidate.category, 128) } : {}),
        baseUrl: rawPackageBase(location, packagePath),
        files: [".codex-plugin/plugin.json"],
        fingerprint: `missing:${catalogId}`,
      });
      continue;
    }

    const files = selected
      .map((file) => file.path.slice(prefix.length))
      .sort((left, right) => left.localeCompare(right));
    if (files.length > MAX_FILES_PER_PLUGIN) {
      result.push({
        catalogId,
        ...(optionalText(candidate.category, 128) ? { category: optionalText(candidate.category, 128) } : {}),
        baseUrl: rawPackageBase(location, packagePath),
        files: [".codex-plugin/plugin.json"],
        fingerprint: `oversized:${catalogId}`,
      });
      continue;
    }
    const fingerprint = createHash("sha256")
      .update(selected.map((file) => `${file.path}\0${file.sha}`).sort().join("\n"), "utf8")
      .digest("hex");
    const category = optionalText(candidate.category, 128);
    result.push({
      catalogId,
      ...(category ? { category } : {}),
      baseUrl: rawPackageBase(location, packagePath),
      files,
      fingerprint,
    });
  }
  return result;
}

async function fetchGitHubTree(location: GitHubMarketplaceLocation): Promise<GitHubTreeFile[]> {
  const url = await publicHttpsUrl(
    `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/git/trees/${encodeURIComponent(location.ref)}?recursive=1`,
    "Codex marketplace repository tree",
  );
  const response = await safeFetch(url);
  const raw = await readBounded(response, MAX_TREE_BYTES, "Codex marketplace repository tree");
  if (!response.ok) throw new Error(`Codex marketplace repository tree returned HTTP ${response.status}`);
  const parsed = parseJson(raw, "Codex marketplace repository tree");
  if (parsed.truncated === true || !Array.isArray(parsed.tree)) {
    throw new Error("Codex marketplace repository tree is incomplete");
  }
  const files: GitHubTreeFile[] = [];
  for (const candidate of parsed.tree) {
    if (!isRecord(candidate) || candidate.type !== "blob") continue;
    if (typeof candidate.path !== "string" || typeof candidate.sha !== "string") continue;
    const size = typeof candidate.size === "number" && Number.isSafeInteger(candidate.size) ? candidate.size : undefined;
    files.push({ path: candidate.path, sha: candidate.sha, ...(size !== undefined ? { size } : {}) });
  }
  return files;
}

async function stageRemotePackage(entry: RemotePluginCatalogEntry, cacheRoot: string): Promise<string> {
  const base = await publicHttpsUrl(entry.baseUrl, `Plugin ${entry.catalogId} base URL`);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;

  const destination = cachePath(cacheRoot, entry.catalogId);
  if (entry.fingerprint && await cacheMatches(destination, entry)) return destination;

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });

  let totalBytes = 0;
  try {
    for (const relative of entry.files) {
      const target = new URL(relative, base);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
        throw new Error(`Plugin ${entry.catalogId} file escaped its declared package base URL`);
      }
      const response = await safeFetch(target);
      const content = await readBounded(
        response,
        MAX_FILE_BYTES,
        `Plugin ${entry.catalogId} file ${relative}`,
      );
      if (!response.ok) {
        throw new Error(`Plugin ${entry.catalogId} file ${relative} returned HTTP ${response.status}`);
      }
      totalBytes += Buffer.byteLength(content, "utf8");
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw new Error(`Plugin ${entry.catalogId} package exceeds the Desktop size limit`);
      }
      const output = inside(temporary, relative);
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, content, { encoding: "utf8", mode: 0o600 });
    }
    if (!entry.files.includes(".codex-plugin/plugin.json")) {
      throw new Error(`Plugin ${entry.catalogId} package does not contain .codex-plugin/plugin.json`);
    }
    await writeFile(
      path.join(temporary, CACHE_MARKER),
      `${JSON.stringify({ fingerprint: entry.fingerprint ?? null, baseUrl: entry.baseUrl, files: entry.files })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function cacheMatches(destination: string, entry: RemotePluginCatalogEntry): Promise<boolean> {
  if (!entry.fingerprint) return false;
  try {
    await access(path.join(destination, ".codex-plugin", "plugin.json"));
    const raw = await readFile(path.join(destination, CACHE_MARKER), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed)
      && parsed.fingerprint === entry.fingerprint
      && parsed.baseUrl === entry.baseUrl;
  } catch {
    return false;
  }
}

function sourceNervePluginEntry(): RemotePluginCatalogEntry {
  return {
    catalogId: "sourcenerve",
    category: "Developer Tools",
    baseUrl: SOURCENERVE_PLUGIN_BASE_URL,
    files: [
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "skills/repository-change-workflow/SKILL.md",
    ],
  };
}

function rawGitHubMarketplaceLocation(url: URL): GitHubMarketplaceLocation | null {
  if (url.hostname.toLowerCase() !== "raw.githubusercontent.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, ref] = parts;
  if (!owner || !repo || !ref) return null;
  return { owner, repo, ref };
}

function rawPackageBase(location: GitHubMarketplaceLocation, packagePath: string): string {
  return `https://raw.githubusercontent.com/${location.owner}/${location.repo}/${location.ref}/${packagePath}/`;
}

function repositoryRelativePath(value: string, pluginId: string): string {
  if (!value || value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error(`Plugin ${pluginId} marketplace path is invalid`);
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, "").replace(/\\/g, "/"));
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new Error(`Plugin ${pluginId} marketplace path escapes the repository root`);
  }
  return normalized;
}

function remoteFiles(value: unknown, pluginId: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES_PER_PLUGIN) {
    throw new Error(`Plugin ${pluginId} registry entry must declare 1-${MAX_FILES_PER_PLUGIN} files`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 512 || /[\0\r\n]/.test(candidate)) {
      throw new Error(`Plugin ${pluginId} contains an invalid registry file path`);
    }
    const normalized = path.posix.normalize(candidate.replace(/^\.\//, ""));
    if (
      normalized === "."
      || normalized === ".."
      || normalized.startsWith("../")
      || normalized.startsWith("/")
      || /^[A-Za-z]:\//.test(normalized)
    ) {
      throw new Error(`Plugin ${pluginId} registry file path escapes the package root`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  if (!result.includes(".codex-plugin/plugin.json")) {
    throw new Error(`Plugin ${pluginId} registry entry must include .codex-plugin/plugin.json`);
  }
  return result;
}

async function safeFetch(url: URL): Promise<Response> {
  await assertPublicHost(url);
  return fetch(url, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json, application/json, text/markdown, text/plain;q=0.9",
      "user-agent": "SourceNerve-Desktop/0.1 Plugin-Registry",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function publicHttpsUrl(value: string, label: string): Promise<URL> {
  const url = httpsUrl(value, label);
  await assertPublicHost(url);
  return url;
}

function httpsUrl(value: unknown, label: string): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new Error(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS`);
  }
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Plugin registry refuses local/private hosts");
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("Plugin registry refuses local/private addresses");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("Plugin registry refuses hosts resolving to local/private addresses");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0.0.0.0" || normalized === "::") return true;
  if (normalized.startsWith("127.") || normalized.startsWith("10.") || normalized.startsWith("192.168.")) return true;
  if (normalized.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice("::ffff:".length));
  return false;
}

async function readBounded(response: Response, limit: number, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${label} exceeds the size limit`);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeds the size limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function cachePath(root: string, pluginId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pluginId)) throw new Error("Plugin id is invalid");
  return inside(root, pluginId);
}

function inside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Plugin registry path escaped the managed cache");
  }
  return resolved;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Plugin registry text field is invalid");
  }
  return value.trim();
}

function parseJson(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 1024) : "Remote plugin package could not be staged";
}
