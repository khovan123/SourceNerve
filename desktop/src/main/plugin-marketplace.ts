import { lookup } from "node:dns/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_PLUGINS = 128;
const MAX_FILES_PER_PLUGIN = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

export const DEFAULT_PLUGIN_REGISTRY_URL =
  "https://raw.githubusercontent.com/khovan123/SourceNerve/main/.agents/plugins/public-registry.json";

export interface RemotePluginCatalogEntry {
  catalogId: string;
  category?: string;
  baseUrl: string;
  files: string[];
}

export interface StagedRemotePluginEntry {
  catalogId: string;
  category?: string;
  sourcePath: string;
  blocker?: string;
}

export async function stageRemotePluginCatalog(
  registryUrl: string,
  cacheRoot: string,
): Promise<StagedRemotePluginEntry[]> {
  const registry = await publicHttpsUrl(registryUrl, "Plugin registry URL");
  const response = await safeFetch(registry);
  const raw = await readBounded(response, MAX_REGISTRY_BYTES, "Plugin registry response");
  if (!response.ok) throw new Error(`Plugin registry request failed with HTTP ${response.status}`);

  const entries = parseRemotePluginRegistry(raw);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const result: StagedRemotePluginEntry[] = [];
  for (const entry of entries) {
    try {
      const sourcePath = await stageRemotePackage(entry, cacheRoot);
      result.push({
        catalogId: entry.catalogId,
        ...(entry.category ? { category: entry.category } : {}),
        sourcePath,
      });
    } catch (error) {
      result.push({
        catalogId: entry.catalogId,
        ...(entry.category ? { category: entry.category } : {}),
        sourcePath: entry.baseUrl,
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Plugin registry returned invalid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins)) {
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
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized)
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
      accept: "application/json, text/markdown, text/plain;q=0.9",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 1024) : "Remote plugin package could not be staged";
}
