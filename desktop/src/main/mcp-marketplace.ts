import { createHash } from "node:crypto";

import type {
  McpExtensionInstallInput,
  McpMarketplaceInstallPlan,
  McpMarketplaceSearchInput,
  McpMarketplaceServerView,
} from "../shared/mcp-extension-api";

const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 18;
const MAX_LIMIT = 50;

export async function searchMcpMarketplace(
  input: McpMarketplaceSearchInput,
): Promise<McpMarketplaceServerView[]> {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const url = new URL("/v0.1/servers", REGISTRY_BASE_URL);
  if (query) url.searchParams.set("search", query);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(limit));

  const payload = await requestJson(url);
  if (!isRecord(payload) || !Array.isArray(payload.servers)) {
    throw new Error("Official MCP Registry returned an invalid server list");
  }

  return payload.servers
    .map((entry) => parseServerResponse(entry))
    .filter((value): value is McpMarketplaceServerView => value !== null)
    .slice(0, limit);
}

export async function planMcpMarketplaceInstall(
  serverName: string,
): Promise<McpMarketplaceInstallPlan> {
  validateServerName(serverName);
  const url = new URL(
    `/v0.1/servers/${encodeURIComponent(serverName)}/versions/latest`,
    REGISTRY_BASE_URL,
  );
  const payload = await requestJson(url);
  const detail = unwrapServer(payload);
  if (!detail) throw new Error("Official MCP Registry returned invalid server metadata");
  return buildInstallPlan(detail);
}

async function requestJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "SourceNerve-Desktop/0.1 MCP-Marketplace",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Official MCP Registry response exceeded the SourceNerve size limit");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Official MCP Registry response exceeded the SourceNerve size limit");
  }
  if (!response.ok) {
    throw new Error(`Official MCP Registry request failed with HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Official MCP Registry returned invalid JSON");
  }
}

function parseServerResponse(value: unknown): McpMarketplaceServerView | null {
  const detail = unwrapServer(value);
  if (!detail) return null;
  return serverView(detail);
}

function unwrapServer(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.server)) return value.server;
  if (typeof value.name === "string") return value;
  return null;
}

function serverView(detail: Record<string, unknown>): McpMarketplaceServerView {
  const registryName = boundedString(detail.name, 200) ?? "unknown/unknown";
  const version = boundedString(detail.version, 255) ?? "unknown";
  const title = boundedString(detail.title, 100) ?? displayName(registryName);
  const description = boundedString(detail.description, 500) ?? "No description provided.";
  const repositoryUrl = isRecord(detail.repository)
    ? safeHttpsUrl(detail.repository.url)
    : undefined;
  const websiteUrl = safeHttpsUrl(detail.websiteUrl);
  const packages = Array.isArray(detail.packages) ? detail.packages.filter(isRecord) : [];
  const remotes = Array.isArray(detail.remotes) ? detail.remotes.filter(isRecord) : [];
  const preferredPackage = packages.find((item) => packageInstallKind(item) !== "manual");
  const preferredRemote = remotes.find((item) => item.type === "streamable-http");

  if (preferredPackage) {
    const installKind = packageInstallKind(preferredPackage);
    const blockers = packageBlockers(preferredPackage, installKind);
    return {
      registryName,
      title,
      description,
      version,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      installKind,
      transport: "stdio",
      ...(boundedString(preferredPackage.registryType, 32)
        ? { packageType: boundedString(preferredPackage.registryType, 32)! }
        : {}),
      ...(boundedString(preferredPackage.identifier, 512)
        ? { packageIdentifier: boundedString(preferredPackage.identifier, 512)! }
        : {}),
      installHint: installHint(preferredPackage, installKind),
      canAutoInstall: blockers.length === 0,
      requiresConfiguration: blockers.length > 0,
    };
  }

  if (preferredRemote) {
    const blockers = remoteBlockers(preferredRemote);
    return {
      registryName,
      title,
      description,
      version,
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      installKind: "remote",
      transport: "streamable-http",
      installHint: boundedString(preferredRemote.url, 2048) ?? "Remote Streamable HTTP MCP",
      canAutoInstall: blockers.length === 0,
      requiresConfiguration: blockers.length > 0,
    };
  }

  return {
    registryName,
    title,
    description,
    version,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    installKind: "manual",
    transport: "unknown",
    installHint: "Manual installation metadata review required",
    canAutoInstall: false,
    requiresConfiguration: true,
  };
}

function buildInstallPlan(detail: Record<string, unknown>): McpMarketplaceInstallPlan {
  const server = serverView(detail);
  const packages = Array.isArray(detail.packages) ? detail.packages.filter(isRecord) : [];
  const remotes = Array.isArray(detail.remotes) ? detail.remotes.filter(isRecord) : [];
  const preferredPackage = packages.find((item) => packageInstallKind(item) !== "manual");

  if (preferredPackage) {
    const installKind = packageInstallKind(preferredPackage);
    const blockers = packageBlockers(preferredPackage, installKind);
    const identifier = boundedString(preferredPackage.identifier, 512);
    const packageVersion = boundedString(preferredPackage.version, 255) ?? server.version;
    if (!identifier) blockers.push("Package identifier is missing.");
    if (!packageVersion || packageVersion === "unknown") blockers.push("Package version is missing.");

    if (blockers.length === 0 && identifier && packageVersion) {
      const runtime = installKind === "npm" ? "npx" : "uvx";
      const packageSpec =
        installKind === "npm"
          ? `${identifier}@${packageVersion}`
          : `${identifier}==${packageVersion}`;
      const args = installKind === "npm" ? ["-y", packageSpec] : [packageSpec];
      const input = installInput(server, {
        transport: "stdio",
        command: runtime,
        args,
      });
      return {
        server,
        input,
        commandPreview: [runtime, ...args].join(" "),
        blockers: [],
      };
    }

    return { server, blockers };
  }

  const remote = remotes.find((item) => item.type === "streamable-http");
  if (remote) {
    const blockers = remoteBlockers(remote);
    const url = boundedString(remote.url, 2048);
    if (!url) blockers.push("Remote MCP URL is missing.");
    if (blockers.length === 0 && url) {
      return {
        server,
        input: installInput(server, { transport: "streamable-http", url }),
        commandPreview: url,
        blockers: [],
      };
    }
    return { server, blockers };
  }

  return {
    server,
    blockers: [
      "This registry entry does not expose an npm/PyPI stdio package or a directly usable Streamable HTTP endpoint.",
    ],
  };
}

function installInput(
  server: McpMarketplaceServerView,
  transport: McpExtensionInstallInput["transport"],
): McpExtensionInstallInput {
  const slug = extensionSlug(server.registryName);
  return {
    id: slug,
    name: server.title,
    version: server.version,
    namespace: slug.slice(0, 48),
    source: `registry:${server.registryName}`,
    transport,
    authType: "none",
    required: false,
    updateChannel: "stable",
  };
}

function extensionSlug(serverName: string): string {
  const leaf = serverName.split("/").pop() ?? "mcp";
  const clean = leaf
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38) || "mcp";
  const hash = createHash("sha256").update(serverName).digest("hex").slice(0, 7);
  const slug = `${clean}-${hash}`;
  return slug === "sourcenerve" ? `mcp-${hash}` : slug;
}

function packageInstallKind(value: Record<string, unknown>): "npm" | "pypi" | "manual" {
  if (!isRecord(value.transport) || value.transport.type !== "stdio") return "manual";
  if (value.registryType === "npm") return "npm";
  if (value.registryType === "pypi") return "pypi";
  return "manual";
}

function packageBlockers(
  value: Record<string, unknown>,
  installKind: "npm" | "pypi" | "manual",
): string[] {
  const blockers: string[] = [];
  if (installKind === "manual") {
    blockers.push("This package type is not yet eligible for one-click installation.");
    return blockers;
  }
  if (Array.isArray(value.environmentVariables) && value.environmentVariables.length > 0) {
    blockers.push("This package declares environment variables that must be reviewed before install.");
  }
  if (Array.isArray(value.runtimeArguments) && value.runtimeArguments.length > 0) {
    blockers.push("This package declares runtime arguments that must be reviewed before install.");
  }
  if (Array.isArray(value.packageArguments) && value.packageArguments.length > 0) {
    blockers.push("This package declares package arguments that must be reviewed before install.");
  }
  if (!boundedString(value.identifier, 512)) blockers.push("Package identifier is missing.");
  return blockers;
}

function remoteBlockers(value: Record<string, unknown>): string[] {
  const blockers: string[] = [];
  const url = boundedString(value.url, 2048);
  if (!url || !isFixedHttpsUrl(url)) {
    blockers.push("Remote URL contains variables or is not a fixed HTTPS endpoint.");
  }
  if (Array.isArray(value.variables) || isRecord(value.variables)) {
    blockers.push("Remote endpoint requires variables that must be configured before install.");
  }
  if (Array.isArray(value.headers) && value.headers.length > 0) {
    blockers.push("Remote endpoint declares authentication/configuration headers that require review.");
  }
  return blockers;
}

function installHint(value: Record<string, unknown>, kind: "npm" | "pypi" | "manual"): string {
  const identifier = boundedString(value.identifier, 512) ?? "unknown package";
  const version = boundedString(value.version, 255);
  if (kind === "npm") return `npx -y ${identifier}${version ? `@${version}` : ""}`;
  if (kind === "pypi") return `uvx ${identifier}${version ? `==${version}` : ""}`;
  return identifier;
}

function displayName(serverName: string): string {
  const leaf = serverName.split("/").pop() ?? serverName;
  return leaf
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || serverName;
}

function validateServerName(value: string): void {
  if (
    value.length < 3 ||
    value.length > 200 ||
    !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new Error("MCP Registry server name is invalid");
  }
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const text = boundedString(value, 2048);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isFixedHttpsUrl(value: string): boolean {
  if (value.includes("{") || value.includes("}")) return false;
  return Boolean(safeHttpsUrl(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
