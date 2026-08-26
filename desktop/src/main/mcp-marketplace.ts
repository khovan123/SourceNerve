import { createHash } from "node:crypto";

import type {
  McpAuthDiscoveryView,
  McpExtensionInstallInput,
  McpMarketplaceArtifactVerificationView,
  McpMarketplaceConfigurationField,
  McpMarketplaceInstallPlan,
  McpMarketplaceRegistryStatus,
  McpMarketplaceSearchInput,
  McpMarketplaceServerView,
  McpMarketplaceTrustView,
} from "../shared/mcp-extension-api";
import {
  artifactVerificationBlockers,
  parsePublisherSignatureDeclaration,
  previewMcpArtifactVerification,
  verifyMcpMarketplaceArtifact,
  type McpPublisherSignatureDeclaration,
} from "./mcp-artifact-verification";
import { discoverMcpAuthorization } from "./mcp-auth-discovery";

const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 18;
const MAX_LIMIT = 50;

interface RegistryEnvelope {
  server: Record<string, unknown>;
  meta: Record<string, unknown>;
}

interface PackageVerificationDeclaration {
  signature?: McpPublisherSignatureDeclaration;
  signatureRequired: boolean;
}

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
  const envelope = unwrapServer(payload);
  if (!envelope) throw new Error("Official MCP Registry returned invalid server metadata");
  return buildInstallPlan(envelope);
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
  const envelope = unwrapServer(value);
  if (!envelope) return null;
  return serverView(envelope);
}

function unwrapServer(value: unknown): RegistryEnvelope | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.server)) {
    return {
      server: value.server,
      meta: isRecord(value._meta) ? value._meta : {},
    };
  }
  if (typeof value.name === "string") return { server: value, meta: {} };
  return null;
}

function serverView(envelope: RegistryEnvelope): McpMarketplaceServerView {
  const detail = envelope.server;
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
    const configurationFields = packageConfigurationFields(preferredPackage);
    const trust = trustView(
      envelope,
      Boolean(preferredPackage),
      blockers.length > 0 || configurationFields.length > 0,
      "stdio",
    );
    let verification: McpMarketplaceArtifactVerificationView;
    try {
      const declaration = packageVerificationDeclaration(preferredPackage);
      verification = previewMcpArtifactVerification(installKind, declaration.signature);
      if (declaration.signatureRequired && !declaration.signature) {
        verification = {
          ...verification,
          status: "failed",
          required: true,
          notes: [
            ...verification.notes,
            "Publisher signature verification is required by package metadata, but no signature was declared.",
          ],
        };
      }
    } catch (error) {
      verification = failedVerification(
        `Artifact verification metadata is invalid: ${error instanceof Error ? error.message : "invalid metadata"}`,
      );
    }
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
      requiresConfiguration: configurationFields.length > 0,
      configurationFields,
      trust,
      verification,
    };
  }

  if (preferredRemote) {
    const blockers = remoteBlockers(preferredRemote);
    const trust = trustView(envelope, false, blockers.length > 0, "streamable-http");
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
      configurationFields: [],
      trust,
      verification: previewMcpArtifactVerification("remote"),
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
    configurationFields: [],
    trust: trustView(envelope, false, true, "unknown"),
    verification: previewMcpArtifactVerification("manual"),
  };
}

async function buildInstallPlan(envelope: RegistryEnvelope): Promise<McpMarketplaceInstallPlan> {
  const detail = envelope.server;
  const baseServer = serverView(envelope);
  const packages = Array.isArray(detail.packages) ? detail.packages.filter(isRecord) : [];
  const remotes = Array.isArray(detail.remotes) ? detail.remotes.filter(isRecord) : [];
  const preferredPackage = packages.find((item) => packageInstallKind(item) !== "manual");

  if (preferredPackage) {
    const installKind = packageInstallKind(preferredPackage);
    const blockers = packageBlockers(preferredPackage, installKind);
    const identifier = boundedString(preferredPackage.identifier, 512);
    const packageVersion = boundedString(preferredPackage.version, 255) ?? baseServer.version;
    if (!identifier) blockers.push("Package identifier is missing.");
    if (!packageVersion || packageVersion === "unknown") blockers.push("Package version is missing.");

    let declaration: PackageVerificationDeclaration = { signatureRequired: false };
    try {
      declaration = packageVerificationDeclaration(preferredPackage);
    } catch (error) {
      blockers.push(
        `Artifact verification metadata is invalid: ${error instanceof Error ? error.message : "invalid metadata"}`,
      );
    }

    let verification = baseServer.verification;
    if (identifier && packageVersion && blockers.length === 0) {
      verification = await verifyMcpMarketplaceArtifact({
        registryName: baseServer.registryName,
        version: packageVersion,
        installKind,
        packageIdentifier: identifier,
        ...(declaration.signature ? { signature: declaration.signature } : {}),
        signatureRequired: declaration.signatureRequired,
      });
      blockers.push(...artifactVerificationBlockers(verification));
    }
    const server: McpMarketplaceServerView = {
      ...baseServer,
      verification,
      canAutoInstall: baseServer.canAutoInstall && blockers.length === 0,
    };

    if (blockers.length === 0 && identifier && packageVersion) {
      const runtime = installKind === "npm" ? "npx" : "uvx";
      const packageSpec =
        installKind === "npm"
          ? `${identifier}@${packageVersion}`
          : `${identifier}==${packageVersion}`;
      const args = installKind === "npm" ? ["-y", packageSpec] : [packageSpec];
      const environmentNames = server.configurationFields.map((field) => field.name);
      const input = installInput(server, {
        transport: "stdio",
        command: runtime,
        args,
        ...(environmentNames.length > 0 ? { environment: environmentNames } : {}),
      });
      return {
        server,
        input,
        commandPreview: [runtime, ...args].join(" "),
        blockers: [],
        auth: {
          status: "not-required",
          source: "none",
          registration: "preconfigured",
          scopes: [],
          notes: server.configurationFields.length > 0
            ? ["Registry-declared environment values are collected by SourceNerve and stored outside the extension registry; secret values stay in OS-backed secure storage."]
            : ["No separate authentication recipe is declared for this package."],
        },
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
      let auth: McpAuthDiscoveryView;
      try {
        auth = await discoverMcpAuthorization(url);
      } catch (error) {
        auth = {
          status: "manual",
          source: "none",
          registration: "unsupported",
          scopes: [],
          notes: [error instanceof Error ? error.message : "OAuth discovery failed."],
        };
      }
      if (auth.status === "manual") {
        return {
          server: baseServer,
          commandPreview: url,
          blockers: ["Authentication is required but cannot yet be completed automatically for this provider."],
          auth,
        };
      }
      const input = installInput(baseServer, { transport: "streamable-http", url });
      if (auth.status === "oauth" && auth.config) {
        input.authType = "oauth";
        input.oauth = auth.config;
      }
      return {
        server: baseServer,
        input,
        commandPreview: url,
        blockers: [],
        auth,
      };
    }
    return { server: baseServer, blockers };
  }

  return {
    server: baseServer,
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
  if (Array.isArray(value.runtimeArguments) && value.runtimeArguments.length > 0) {
    blockers.push("This package declares runtime arguments that require a reviewed install recipe.");
  }
  if (Array.isArray(value.packageArguments) && value.packageArguments.length > 0) {
    blockers.push("This package declares package arguments that require a reviewed install recipe.");
  }
  if (!boundedString(value.identifier, 512)) blockers.push("Package identifier is missing.");
  return blockers;
}

function packageVerificationDeclaration(
  value: Record<string, unknown>,
): PackageVerificationDeclaration {
  const raw = value.artifactVerification;
  if (raw === undefined) return { signatureRequired: false };
  if (!isRecord(raw)) throw new Error("artifactVerification must be an object");
  const allowed = new Set(["signature", "signatureRequired"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error("artifactVerification contains unsupported fields");
  }
  if (raw.signatureRequired !== undefined && typeof raw.signatureRequired !== "boolean") {
    throw new Error("artifactVerification.signatureRequired must be boolean");
  }
  const signature = parsePublisherSignatureDeclaration(raw.signature);
  return {
    ...(signature ? { signature } : {}),
    signatureRequired: raw.signatureRequired === true || signature?.required === true,
  };
}

function packageConfigurationFields(value: Record<string, unknown>): McpMarketplaceConfigurationField[] {
  if (!Array.isArray(value.environmentVariables)) return [];
  const result: McpMarketplaceConfigurationField[] = [];
  for (const candidate of value.environmentVariables.slice(0, 32)) {
    if (!isRecord(candidate)) continue;
    const name = boundedString(candidate.name, 128);
    if (!name || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) continue;
    const description = boundedString(candidate.description, 500);
    const defaultValue = boundedString(candidate.default, 2048);
    result.push({
      name,
      ...(description ? { description } : {}),
      required: candidate.isRequired === true,
      secret:
        candidate.isSecret === true ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name),
      ...(defaultValue ? { defaultValue } : {}),
    });
  }
  return result;
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
    blockers.push("Remote endpoint declares custom headers that require explicit review.");
  }
  return blockers;
}

function trustView(
  envelope: RegistryEnvelope,
  hasPackage: boolean,
  requiresConfiguration: boolean,
  transport: "stdio" | "streamable-http" | "unknown",
): McpMarketplaceTrustView {
  const meta = registryMeta(envelope.meta);
  const status = registryStatus(meta.status);
  const repositoryUrl = isRecord(envelope.server.repository)
    ? safeHttpsUrl(envelope.server.repository.url)
    : undefined;
  const namespaceVerified = true;
  const packageOwnershipVerified = hasPackage;
  let score = 45;
  const reasons: string[] = [
    "Published through the Official MCP Registry, which authenticates publisher namespaces.",
  ];

  if (hasPackage) {
    score += 20;
    reasons.push("Official Registry package ownership validation applies to the referenced package.");
  }
  if (status === "active") {
    score += 10;
    reasons.push("Registry status is active.");
  } else if (status === "deprecated") {
    score -= 20;
    reasons.push("Registry status is deprecated.");
  } else if (status === "deleted") {
    score -= 45;
    reasons.push("Registry status is deleted.");
  }
  if (repositoryUrl) {
    score += 10;
    reasons.push("An HTTPS source repository is declared.");
  }
  if (transport === "streamable-http") {
    score += 5;
    reasons.push("Remote transport is required to use a fixed HTTPS endpoint for one-click install.");
  }
  if (!requiresConfiguration) score += 5;
  else {
    reasons.push(
      "The extension requests additional configuration or runtime permissions that require review.",
    );
  }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    level: score >= 80 ? "high" : score >= 55 ? "medium" : "low",
    registryStatus: status,
    namespaceVerified,
    packageOwnershipVerified,
    signingStatus: hasPackage ? "registry-provenance" : "publisher-metadata",
    ...(boundedIsoDate(meta.publishedAt) ? { publishedAt: boundedIsoDate(meta.publishedAt)! } : {}),
    ...(boundedIsoDate(meta.updatedAt) ? { updatedAt: boundedIsoDate(meta.updatedAt)! } : {}),
    reasons,
  };
}

function registryMeta(value: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(value["io.modelcontextprotocol.registry/official"])) {
    return value["io.modelcontextprotocol.registry/official"] as Record<string, unknown>;
  }
  return value;
}

function registryStatus(value: unknown): McpMarketplaceRegistryStatus {
  return value === "active" || value === "deprecated" || value === "deleted"
    ? value
    : "unknown";
}

function boundedIsoDate(value: unknown): string | undefined {
  const text = boundedString(value, 64);
  if (!text || Number.isNaN(Date.parse(text))) return undefined;
  return text;
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
  return (
    leaf
      .split(/[-_.]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || serverName
  );
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
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
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

function failedVerification(note: string): McpMarketplaceArtifactVerificationView {
  return {
    status: "failed",
    required: true,
    digest: { status: "unverified" },
    signature: { status: "invalid" },
    notes: [note],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
