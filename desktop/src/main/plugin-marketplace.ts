import { lookup } from "node:dns/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_PLUGINS = 512;
const MAX_FILES_PER_PLUGIN = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_CONTENTS_BYTES = 1024 * 1024;
const MAX_SKILLS_PER_PLUGIN = 64;

export const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://raw.githubusercontent.com/openai/plugins/main/.agents/plugins/marketplace.json";

const SOURCENERVE_PLUGIN_BASE_URL =
  "https://raw.githubusercontent.com/khovan123/SourceNerve/main/plugins/sourcenerve/";

export interface RemotePluginCatalogEntry {
  catalogId: string;
  category?: string;
  baseUrl: string;
  files: string[];
}

export interface RemotePluginIndexEntry {
  catalogId: string;
  category?: string;
  sourcePath: string;
}

export interface StagedRemotePluginEntry {
  catalogId: string;
  category?: string;
  sourcePath: string;
  blocker?: string;
}

interface CodexMarketplaceEntry {
  catalogId: string;
  category?: string;
  packagePath: string;
}

interface GitHubMarketplaceLocation {
  owner: string;
  repo: string;
  ref: string;
}

interface GitHubContentsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export async function discoverRemotePluginCatalog(
  registryUrl: string,
): Promise<RemotePluginIndexEntry[]> {
  const { registry, raw, parsed } = await fetchRegistry(registryUrl);
  let entries: RemotePluginIndexEntry[];

  if (parsed.schemaVersion === 1) {
    entries = parseRemotePluginRegistry(raw).map((entry) => ({
      catalogId: entry.catalogId,
      ...(entry.category ? { category: entry.category } : {}),
      sourcePath: `remote:${entry.catalogId}`,
    }));
  } else {
    entries = parseCodexMarketplaceIndex(parsed).map((entry) => ({
      catalogId: entry.catalogId,
      ...(entry.category ? { category: entry.category } : {}),
      sourcePath: `remote:${entry.catalogId}`,
    }));
  }

  if (
    registry.toString() === DEFAULT_PLUGIN_REGISTRY_URL
    && !entries.some((entry) => entry.catalogId === "sourcenerve")
  ) {
    entries.push({
      catalogId: "sourcenerve",
      category: "Developer Tools",
      sourcePath: "remote:sourcenerve",
    });
  }

  return entries;
}

export async function stageRemotePluginPackage(
  registryUrl: string,
  cacheRoot: string,
  catalogId: string,
): Promise<StagedRemotePluginEntry> {
  identifier(catalogId, "marketplace plugin name");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });

  if (registryUrl === DEFAULT_PLUGIN_REGISTRY_URL && catalogId === "sourcenerve") {
    const sourcePath = await stageRemotePackage(sourceNervePluginEntry(), cacheRoot);
    return {
      catalogId,
      category: "Developer Tools",
      sourcePath,
    };
  }

  const { registry, raw, parsed } = await fetchRegistry(registryUrl);
  if (parsed.schemaVersion === 1) {
    const entry = parseRemotePluginRegistry(raw).find((item) => item.catalogId === catalogId);
    if (!entry) throw new Error(`Plugin ${catalogId} is no longer present in the public registry`);
    return {
      catalogId,
      ...(entry.category ? { category: entry.category } : {}),
      sourcePath: await stageRemotePackage(entry, cacheRoot),
    };
  }

  const location = rawGitHubMarketplaceLocation(registry);
  if (!location) {
    throw new Error(
      "Standard Codex marketplace review currently requires a public raw.githubusercontent.com marketplace URL",
    );
  }
  const entry = parseCodexMarketplaceIndex(parsed).find((item) => item.catalogId === catalogId);
  if (!entry) throw new Error(`Plugin ${catalogId} is no longer present in the public marketplace`);
  return stageCodexPluginPackage(entry, location, cacheRoot);
}

/**
 * Compatibility helper retained for callers/tests that still expect eager staging.
 * Explore no longer calls this function; Desktop discovers the index first and
 * stages only the package selected for review.
 */
export async function stageRemotePluginCatalog(
  registryUrl: string,
  cacheRoot: string,
): Promise<StagedRemotePluginEntry[]> {
  const entries = await discoverRemotePluginCatalog(registryUrl);
  const result: StagedRemotePluginEntry[] = [];
  for (const entry of entries) {
    try {
      result.push(await stageRemotePluginPackage(registryUrl, cacheRoot, entry.catalogId));
    } catch (error) {
      result.push({
        catalogId: entry.catalogId,
        ...(entry.category ? { category: entry.category } : {}),
        sourcePath: entry.sourcePath,
        blocker: safeMessage(error),
      });
    }
  }
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

export function parseCodexMarketplaceIndex(parsed: Record<string, unknown>): CodexMarketplaceEntry[] {
  if (!Array.isArray(parsed.plugins)) throw new Error("Codex plugin marketplace has invalid schema");
  if (parsed.plugins.length > MAX_PLUGINS) {
    throw new Error("Codex plugin marketplace exceeds the Desktop plugin limit");
  }

  const result: CodexMarketplaceEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.plugins) {
    if (!isRecord(candidate) || !isRecord(candidate.source)) continue;
    if (candidate.source.source !== "local" || typeof candidate.source.path !== "string") continue;
    if (
      isRecord(candidate.policy)
      && candidate.policy.installation !== undefined
      && candidate.policy.installation !== "AVAILABLE"
    ) {
      continue;
    }

    const catalogId = identifier(candidate.name, "marketplace plugin name");
    if (seen.has(catalogId)) throw new Error(`Codex marketplace contains duplicate plugin ${catalogId}`);
    seen.add(catalogId);
    const category = optionalText(candidate.category, 128);
    result.push({
      catalogId,
      ...(category ? { category } : {}),
      packagePath: repositoryRelativePath(candidate.source.path, catalogId),
    });
  }
  return result;
}

async function fetchRegistry(registryUrl: string): Promise<{
  registry: URL;
  raw: string;
  parsed: Record<string, unknown>;
}> {
  const registry = await publicHttpsUrl(registryUrl, "Plugin registry URL");
  const response = await safeFetch(registry);
  const raw = await readBounded(response, MAX_REGISTRY_BYTES, "Plugin registry response");
  if (!response.ok) throw new Error(`Plugin registry request failed with HTTP ${response.status}`);
  return { registry, raw, parsed: parseJson(raw, "Plugin registry") };
}

async function stageCodexPluginPackage(
  entry: CodexMarketplaceEntry,
  location: GitHubMarketplaceLocation,
  cacheRoot: string,
): Promise<StagedRemotePluginEntry> {
  const destination = cachePath(cacheRoot, entry.catalogId);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true, mode: 0o700 });

  let totalBytes = 0;
  try {
    const manifestRelative = ".codex-plugin/plugin.json";
    const manifestRaw = await fetchRequiredRawFile(
      location,
      entry.packagePath,
      manifestRelative,
      `Plugin ${entry.catalogId} manifest`,
    );
    totalBytes = await writePackageFile(temporary, manifestRelative, manifestRaw, totalBytes, entry.catalogId);
    const manifest = parseJson(manifestRaw, `Plugin ${entry.catalogId} manifest`);

    if (manifest.apps !== undefined && manifest.mcpServers === undefined) {
      throw new Error(
        `Plugin ${entry.catalogId} depends on an OpenAI app connector that SourceNerve cannot install yet`,
      );
    }

    if (manifest.mcpServers !== undefined) {
      const mcpRelative = declaredPackagePath(manifest.mcpServers, "mcpServers", entry.catalogId);
      const mcpRaw = await fetchRequiredRawFile(
        location,
        entry.packagePath,
        mcpRelative,
        `Plugin ${entry.catalogId} MCP config`,
      );
      totalBytes = await writePackageFile(temporary, mcpRelative, mcpRaw, totalBytes, entry.catalogId);
    }

    if (manifest.skills !== undefined) {
      const skillsRelative = declaredPackagePath(manifest.skills, "skills", entry.catalogId).replace(/\/$/, "");
      const skills = await listGitHubDirectory(location, `${entry.packagePath}/${skillsRelative}`);
      const directories = skills.filter((item) => item.type === "dir");
      if (directories.length > MAX_SKILLS_PER_PLUGIN) {
        throw new Error(`Plugin ${entry.catalogId} exceeds the SourceNerve skill limit`);
      }
      for (const skill of directories) {
        const skillRelative = `${skillsRelative}/${skill.name}/SKILL.md`;
        const content = await fetchOptionalRawFile(location, entry.packagePath, skillRelative);
        if (content === undefined) continue;
        totalBytes = await writePackageFile(temporary, skillRelative, content, totalBytes, entry.catalogId);
      }
    }

    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return {
      catalogId: entry.catalogId,
      ...(entry.category ? { category: entry.category } : {}),
      sourcePath: destination,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function stageRemotePackage(entry: RemotePluginCatalogEntry, cacheRoot: string): Promise<string> {
  const base = await publicHttpsUrl(entry.baseUrl, `Plugin ${entry.catalogId} base URL`);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  const destination = cachePath(cacheRoot, entry.catalogId);
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
      const content = await readBounded(response, MAX_FILE_BYTES, `Plugin ${entry.catalogId} file ${relative}`);
      if (!response.ok) throw new Error(`Plugin ${entry.catalogId} file ${relative} returned HTTP ${response.status}`);
      totalBytes = await writePackageFile(temporary, relative, content, totalBytes, entry.catalogId);
    }
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function writePackageFile(
  root: string,
  relative: string,
  content: string,
  currentBytes: number,
  pluginId: string,
): Promise<number> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new Error(`Plugin ${pluginId} file ${relative} exceeds the size limit`);
  const next = currentBytes + bytes;
  if (next > MAX_PACKAGE_BYTES) throw new Error(`Plugin ${pluginId} package exceeds the Desktop size limit`);
  const output = inside(root, relative);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, content, { encoding: "utf8", mode: 0o600 });
  return next;
}

async function listGitHubDirectory(
  location: GitHubMarketplaceLocation,
  repositoryPath: string,
): Promise<GitHubContentsEntry[]> {
  const encodedPath = repositoryPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = await publicHttpsUrl(
    `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(location.ref)}`,
    "Plugin marketplace package directory",
  );
  const response = await safeFetch(url);
  const raw = await readBounded(response, MAX_CONTENTS_BYTES, "Plugin marketplace package directory");
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Plugin marketplace directory returned HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Plugin marketplace directory returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("Plugin marketplace directory response is invalid");
  const result: GitHubContentsEntry[] = [];
  for (const candidate of parsed) {
    if (!isRecord(candidate)) continue;
    if (candidate.type !== "file" && candidate.type !== "dir") continue;
    if (typeof candidate.name !== "string" || typeof candidate.path !== "string") continue;
    result.push({ name: candidate.name, path: candidate.path, type: candidate.type });
  }
  return result;
}

async function fetchRequiredRawFile(
  location: GitHubMarketplaceLocation,
  packagePath: string,
  relative: string,
  label: string,
): Promise<string> {
  const content = await fetchOptionalRawFile(location, packagePath, relative);
  if (content === undefined) throw new Error(`${label} is missing`);
  return content;
}

async function fetchOptionalRawFile(
  location: GitHubMarketplaceLocation,
  packagePath: string,
  relative: string,
): Promise<string | undefined> {
  const base = new URL(rawPackageBase(location, packagePath));
  const target = new URL(relative, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new Error("Plugin package file escaped its marketplace package root");
  }
  const response = await safeFetch(target);
  if (response.status === 404) return undefined;
  const content = await readBounded(response, MAX_FILE_BYTES, `Plugin package file ${relative}`);
  if (!response.ok) throw new Error(`Plugin package file ${relative} returned HTTP ${response.status}`);
  return content;
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
  const marker = parts.findIndex((part, index) =>
    part === ".agents" && parts[index + 1] === "plugins" && parts[index + 2] === "marketplace.json",
  );
  if (marker < 3) return null;
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts.slice(2, marker).join("/");
  if (!owner || !repo || !ref) return null;
  return { owner, repo, ref };
}

function rawPackageBase(location: GitHubMarketplaceLocation, packagePath: string): string {
  const encodedPath = packagePath.split("/").map(encodeURIComponent).join("/");
  const encodedRef = location.ref.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/${encodedRef}/${encodedPath}/`;
}

function declaredPackagePath(value: unknown, field: string, pluginId: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error(`Plugin ${pluginId} ${field} path is invalid`);
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
    throw new Error(`Plugin ${pluginId} ${field} path escapes the package root`);
  }
  return normalized;
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
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
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
  if (!isRecord(parsed)) throw new Error(`${label} has invalid schema`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 1024) : "Remote plugin package could not be staged";
}
