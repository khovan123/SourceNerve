import { createHash } from "node:crypto";

import type {
  McpExtensionInstallInput,
  McpExtensionOAuthConfig,
  McpMarketplaceConfigurationField,
  McpMarketplaceInstallPlan,
  McpMarketplaceSearchInput,
  McpMarketplaceServerView,
} from "../shared/mcp-extension-api";
import {
  enterpriseCatalogs,
  evaluateMcpEnterpriseExtension,
  governedExtensionFromInstall,
  loadMcpEnterpriseGovernance,
  type McpEnterpriseCatalog,
  type McpEnterpriseGovernancePolicy,
} from "./mcp-enterprise-governance";
import { planMcpMarketplaceInstall, searchMcpMarketplace } from "./mcp-marketplace";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_SERVERS = 256;
const DEFAULT_LIMIT = 18;
const MAX_LIMIT = 50;

interface EnterpriseCatalogEntry {
  id: string;
  publisher: string;
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  transport: McpExtensionInstallInput["transport"];
  oauth?: McpExtensionOAuthConfig;
  configurationFields: McpMarketplaceConfigurationField[];
}

interface EnterpriseCatalogDocument {
  entries: EnterpriseCatalogEntry[];
}

export async function searchGovernedMcpMarketplace(
  input: McpMarketplaceSearchInput,
): Promise<McpMarketplaceServerView[]> {
  const policy = loadMcpEnterpriseGovernance();
  const query = input.query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const official = await searchMcpMarketplace({ ...input, limit });
  const officialGoverned = official.map((server) => applyServerGovernance(server, policy));

  if (!policy.managed || policy.catalogs.length === 0) {
    return officialGoverned.slice(0, limit);
  }

  const privateResults: McpMarketplaceServerView[] = [];
  for (const catalog of enterpriseCatalogs(policy)) {
    const document = await fetchEnterpriseCatalog(catalog);
    for (const entry of document.entries) {
      const server = enterpriseServerView(catalog, entry, policy);
      if (
        query &&
        ![
          server.registryName,
          server.title,
          server.description,
          entry.publisher,
          catalog.name,
        ].some((candidate) => candidate.toLowerCase().includes(query))
      ) {
        continue;
      }
      privateResults.push(server);
    }
  }

  return [...officialGoverned, ...privateResults].slice(0, limit);
}

export async function planGovernedMcpMarketplaceInstall(
  serverName: string,
): Promise<McpMarketplaceInstallPlan> {
  const policy = loadMcpEnterpriseGovernance();
  const privateReference = parseEnterpriseServerReference(serverName);
  if (!privateReference) {
    const plan = await planMcpMarketplaceInstall(serverName);
    return applyPlanGovernance(plan, policy, "install");
  }

  const catalog = enterpriseCatalogs(policy).find(
    (candidate) => candidate.id === privateReference.catalogId && candidate.kind === privateReference.kind,
  );
  if (!catalog) {
    throw new Error(`Enterprise MCP catalog ${privateReference.catalogId} is not configured`);
  }
  const document = await fetchEnterpriseCatalog(catalog);
  const entry = document.entries.find(
    (candidate) => enterpriseServerReference(catalog, candidate) === serverName,
  );
  if (!entry) {
    throw new Error(`Enterprise MCP catalog ${catalog.name} no longer contains ${serverName}`);
  }
  return buildEnterpriseInstallPlan(catalog, entry, policy);
}

export function applyPlanGovernance(
  plan: McpMarketplaceInstallPlan,
  policy: McpEnterpriseGovernancePolicy,
  operation: "install" | "update" | "rollback" = "install",
): McpMarketplaceInstallPlan {
  if (!plan.input) return plan;
  const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(plan.input), policy);
  const blockers = decision.allowed
    ? [...plan.blockers]
    : [
        ...plan.blockers,
        ...decision.blockers.map((blocker) => `Enterprise governance: ${blocker}`),
      ];
  return {
    ...plan,
    server: {
      ...plan.server,
      canAutoInstall: plan.server.canAutoInstall && decision.allowed,
      trust: {
        ...plan.server.trust,
        reasons: [
          ...plan.server.trust.reasons,
          ...(decision.managed
            ? [
                decision.approved
                  ? "Organization policy explicitly approves this extension or publisher."
                  : "Organization policy applies to this extension.",
              ]
            : []),
        ],
      },
    },
    blockers,
    ...(blockers.length > 0 && operation !== "install"
      ? { commandPreview: plan.commandPreview }
      : {}),
  };
}

export function parseEnterpriseCatalogDocument(value: unknown): EnterpriseCatalogDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.servers)) {
    throw new Error("Enterprise MCP catalog must use schemaVersion 1 and a servers array");
  }
  if (value.servers.length > MAX_CATALOG_SERVERS) {
    throw new Error(`Enterprise MCP catalog may contain at most ${MAX_CATALOG_SERVERS} servers`);
  }
  const entries = value.servers.map(parseEnterpriseCatalogEntry);
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = `${entry.publisher}/${entry.id}`.toLowerCase();
    if (identities.has(identity)) {
      throw new Error(`Enterprise MCP catalog contains duplicate server identity ${identity}`);
    }
    identities.add(identity);
  }
  return { entries };
}

function applyServerGovernance(
  server: McpMarketplaceServerView,
  policy: McpEnterpriseGovernancePolicy,
): McpMarketplaceServerView {
  if (server.transport === "unknown") return server;
  const preview: McpExtensionInstallInput = {
    id: extensionSlug(server.registryName),
    name: server.title,
    version: server.version,
    namespace: extensionSlug(server.registryName).slice(0, 48),
    source: `registry:${server.registryName}`,
    transport:
      server.transport === "streamable-http"
        ? { transport: "streamable-http", url: "https://governance-preview.invalid/mcp" }
        : { transport: "stdio", command: "governance-preview", args: [] },
    authType: "none",
    required: false,
    updateChannel: "stable",
  };
  const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(preview), policy);
  return {
    ...server,
    canAutoInstall: server.canAutoInstall && decision.allowed,
    trust: {
      ...server.trust,
      reasons: [
        ...server.trust.reasons,
        ...(decision.managed
          ? decision.allowed
            ? [
                decision.approved
                  ? "Organization policy explicitly approves this extension or publisher."
                  : "Organization policy allows this extension under centrally enforced rules.",
              ]
            : decision.blockers.map((blocker) => `Organization policy: ${blocker}`)
          : []),
      ],
    },
  };
}

function enterpriseServerView(
  catalog: McpEnterpriseCatalog,
  entry: EnterpriseCatalogEntry,
  policy: McpEnterpriseGovernancePolicy,
): McpMarketplaceServerView {
  const registryName = enterpriseServerReference(catalog, entry);
  const input = enterpriseInstallInput(catalog, entry);
  const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(input), policy);
  const kindLabel = catalog.kind === "organization" ? "Organization catalog" : "Private catalog";
  const transport = entry.transport.transport;
  return {
    registryName,
    title: entry.title,
    description: entry.description,
    version: entry.version,
    ...(entry.repositoryUrl ? { repositoryUrl: entry.repositoryUrl } : {}),
    ...(entry.websiteUrl ? { websiteUrl: entry.websiteUrl } : {}),
    installKind: transport === "stdio" ? "manual" : "remote",
    transport,
    installHint:
      transport === "stdio"
        ? `${kindLabel} · ${catalog.name} · ${entry.transport.command} ${entry.transport.args.join(" ")}`.trim()
        : `${kindLabel} · ${catalog.name} · ${entry.transport.url}`,
    canAutoInstall: decision.allowed,
    requiresConfiguration: entry.configurationFields.length > 0,
    configurationFields: entry.configurationFields,
    trust: {
      score: decision.approved ? 75 : 60,
      level: decision.approved ? "high" : "medium",
      registryStatus: "active",
      namespaceVerified: false,
      packageOwnershipVerified: false,
      signingStatus: "publisher-metadata",
      reasons: [
        `${kindLabel} ${catalog.name} is centrally configured by SourceNerve enterprise policy.`,
        `Catalog publisher identity: ${entry.publisher}.`,
        "Catalog provenance is separate from behavioral safety; SourceNerve policy remains authoritative.",
        ...(decision.approved
          ? ["Organization policy explicitly approves this extension or publisher."]
          : []),
        ...decision.blockers.map((blocker) => `Organization policy: ${blocker}`),
      ],
    },
  };
}

function buildEnterpriseInstallPlan(
  catalog: McpEnterpriseCatalog,
  entry: EnterpriseCatalogEntry,
  policy: McpEnterpriseGovernancePolicy,
): McpMarketplaceInstallPlan {
  const server = enterpriseServerView(catalog, entry, policy);
  const input = enterpriseInstallInput(catalog, entry);
  const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(input), policy);
  const blockers = decision.allowed
    ? []
    : decision.blockers.map((blocker) => `Enterprise governance: ${blocker}`);
  return {
    server: { ...server, canAutoInstall: server.canAutoInstall && blockers.length === 0 },
    input,
    commandPreview:
      input.transport.transport === "stdio"
        ? [input.transport.command, ...input.transport.args].join(" ")
        : input.transport.url,
    blockers,
    auth: entry.oauth
      ? {
          status: "oauth",
          source: "well-known",
          registration: entry.oauth.clientId ? "preconfigured" : "dynamic",
          scopes: entry.oauth.scopes,
          config: entry.oauth,
          notes: [
            `${catalog.name} supplies centrally reviewed OAuth metadata; SourceNerve still owns PKCE, token storage, refresh and revoke.`,
          ],
        }
      : {
          status: "not-required",
          source: "none",
          registration: "preconfigured",
          scopes: [],
          notes: ["This enterprise catalog entry does not require downstream OAuth."],
        },
  };
}

function enterpriseInstallInput(
  catalog: McpEnterpriseCatalog,
  entry: EnterpriseCatalogEntry,
): McpExtensionInstallInput {
  const reference = enterpriseServerReference(catalog, entry);
  const slug = extensionSlug(reference);
  return {
    id: slug,
    name: entry.title,
    version: entry.version,
    namespace: slug.slice(0, 48),
    source: `registry:${reference}`,
    transport: entry.transport,
    authType: entry.oauth ? "oauth" : "none",
    ...(entry.oauth ? { oauth: entry.oauth } : {}),
    required: false,
    updateChannel: "stable",
  };
}

function enterpriseServerReference(
  catalog: McpEnterpriseCatalog,
  entry: Pick<EnterpriseCatalogEntry, "id" | "publisher">,
): string {
  const prefix = catalog.kind === "organization" ? "org" : "private";
  return `${prefix}-${catalog.id}/${entry.publisher}.${entry.id}`;
}

function parseEnterpriseServerReference(
  serverName: string,
): { kind: McpEnterpriseCatalog["kind"]; catalogId: string } | null {
  const match = serverName.match(/^(org|private)-([a-z0-9][a-z0-9_-]{0,47})\/[A-Za-z0-9._-]+$/);
  if (!match) return null;
  return {
    kind: match[1] === "org" ? "organization" : "private",
    catalogId: match[2],
  };
}

async function fetchEnterpriseCatalog(
  catalog: McpEnterpriseCatalog,
): Promise<EnterpriseCatalogDocument> {
  const response = await fetch(catalog.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": "SourceNerve-Desktop/0.1 Enterprise-MCP-Catalog",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`Enterprise MCP catalog ${catalog.name} exceeds the SourceNerve size limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`Enterprise MCP catalog ${catalog.name} exceeds the SourceNerve size limit`);
  }
  if (!response.ok) {
    throw new Error(`Enterprise MCP catalog ${catalog.name} failed with HTTP ${response.status}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Enterprise MCP catalog ${catalog.name} returned invalid JSON`);
  }
  return parseEnterpriseCatalogDocument(value);
}

function parseEnterpriseCatalogEntry(value: unknown): EnterpriseCatalogEntry {
  if (!isRecord(value)) throw new Error("Enterprise MCP catalog server entry is invalid");
  const allowed = new Set([
    "id",
    "publisher",
    "title",
    "description",
    "version",
    "repositoryUrl",
    "websiteUrl",
    "transport",
    "oauth",
    "configurationFields",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Enterprise MCP catalog server contains unsupported fields");
  }
  const id = token(value.id, 80);
  const publisher = token(value.publisher, 80);
  const title = text(value.title, 128);
  const description = text(value.description, 500) ?? "No description provided.";
  const version = text(value.version, 64);
  if (!id || !publisher || !title || !version) {
    throw new Error("Enterprise MCP catalog server identity, title or version is invalid");
  }
  const repositoryUrl = optionalHttpsUrl(value.repositoryUrl);
  const websiteUrl = optionalHttpsUrl(value.websiteUrl);
  const transport = parseTransport(value.transport);
  const oauth = value.oauth === undefined ? undefined : parseOAuth(value.oauth);
  if (oauth && transport.transport !== "streamable-http") {
    throw new Error("Enterprise MCP OAuth metadata is only supported for Streamable HTTP entries");
  }
  const configurationFields = parseConfigurationFields(value.configurationFields);
  return {
    id,
    publisher,
    title,
    description,
    version,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    transport,
    ...(oauth ? { oauth } : {}),
    configurationFields,
  };
}

function parseTransport(value: unknown): McpExtensionInstallInput["transport"] {
  if (!isRecord(value)) throw new Error("Enterprise MCP catalog transport is invalid");
  if (value.transport === "streamable-http") {
    if (Object.keys(value).some((key) => !["transport", "url"].includes(key))) {
      throw new Error("Enterprise MCP Streamable HTTP transport contains unsupported fields");
    }
    const url = httpsUrl(value.url);
    if (!url) throw new Error("Enterprise MCP Streamable HTTP URL must be fixed HTTPS");
    return { transport: "streamable-http", url };
  }
  if (value.transport === "stdio") {
    if (Object.keys(value).some((key) => !["transport", "command", "args", "environment"].includes(key))) {
      throw new Error("Enterprise MCP stdio transport contains unsupported fields");
    }
    const command = text(value.command, 1024);
    if (!command || !/^[\x20-\x7e]+$/.test(command)) {
      throw new Error("Enterprise MCP stdio command is invalid");
    }
    if (
      !Array.isArray(value.args) ||
      value.args.length > 64 ||
      value.args.some((arg) => !text(arg, 1024))
    ) {
      throw new Error("Enterprise MCP stdio arguments are invalid");
    }
    let environment: string[] | undefined;
    if (value.environment !== undefined) {
      if (
        !Array.isArray(value.environment) ||
        value.environment.length > 32 ||
        value.environment.some(
          (name) => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name),
        )
      ) {
        throw new Error("Enterprise MCP stdio environment declaration is invalid");
      }
      environment = [...new Set(value.environment as string[])];
    }
    return {
      transport: "stdio",
      command,
      args: value.args as string[],
      ...(environment && environment.length > 0 ? { environment } : {}),
    };
  }
  throw new Error("Enterprise MCP catalog transport type is unsupported");
}

function parseOAuth(value: unknown): McpExtensionOAuthConfig {
  if (!isRecord(value)) throw new Error("Enterprise MCP OAuth metadata is invalid");
  const allowed = new Set([
    "authorizationEndpoint",
    "tokenEndpoint",
    "clientId",
    "registrationEndpoint",
    "scopes",
    "revokeEndpoint",
    "resource",
    "issuer",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Enterprise MCP OAuth metadata contains unsupported fields");
  }
  const authorizationEndpoint = httpsUrl(value.authorizationEndpoint);
  const tokenEndpoint = httpsUrl(value.tokenEndpoint);
  const clientId = value.clientId === undefined ? undefined : text(value.clientId, 512);
  const registrationEndpoint = optionalHttpsUrl(value.registrationEndpoint);
  if (!authorizationEndpoint || !tokenEndpoint || (!clientId && !registrationEndpoint)) {
    throw new Error("Enterprise MCP OAuth endpoints/client registration are invalid");
  }
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.length > 32 ||
    value.scopes.some(
      (scope) => typeof scope !== "string" || !/^[A-Za-z0-9:._/-]{1,128}$/.test(scope),
    )
  ) {
    throw new Error("Enterprise MCP OAuth scopes are invalid");
  }
  const revokeEndpoint = optionalHttpsUrl(value.revokeEndpoint);
  const resource = optionalHttpsUrl(value.resource);
  const issuer = optionalHttpsUrl(value.issuer);
  return {
    authorizationEndpoint,
    tokenEndpoint,
    ...(clientId ? { clientId } : {}),
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    scopes: value.scopes as string[],
    ...(revokeEndpoint ? { revokeEndpoint } : {}),
    ...(resource ? { resource } : {}),
    ...(issuer ? { issuer } : {}),
  };
}

function parseConfigurationFields(value: unknown): McpMarketplaceConfigurationField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Enterprise MCP configuration fields are invalid");
  }
  const names = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Enterprise MCP configuration field is invalid");
    const allowed = new Set(["name", "description", "required", "secret", "defaultValue"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new Error("Enterprise MCP configuration field contains unsupported fields");
    }
    const name = typeof candidate.name === "string" && /^[A-Z_][A-Z0-9_]{0,127}$/.test(candidate.name)
      ? candidate.name
      : undefined;
    if (!name || names.has(name)) throw new Error("Enterprise MCP configuration field name is invalid or duplicated");
    names.add(name);
    if (typeof candidate.required !== "boolean" || typeof candidate.secret !== "boolean") {
      throw new Error("Enterprise MCP configuration field flags are invalid");
    }
    const description = candidate.description === undefined ? undefined : text(candidate.description, 500);
    const defaultValue = candidate.defaultValue === undefined ? undefined : text(candidate.defaultValue, 2048);
    if (candidate.description !== undefined && !description) {
      throw new Error("Enterprise MCP configuration field description is invalid");
    }
    if (candidate.defaultValue !== undefined && !defaultValue) {
      throw new Error("Enterprise MCP configuration field default is invalid");
    }
    return {
      name,
      required: candidate.required,
      secret: candidate.secret,
      ...(description ? { description } : {}),
      ...(defaultValue ? { defaultValue } : {}),
    };
  });
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

function token(value: unknown, max: number): string | undefined {
  const candidate = text(value, max);
  return candidate && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate) ? candidate : undefined;
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const url = httpsUrl(value);
  if (!url) throw new Error("Enterprise MCP catalog URL metadata must be fixed HTTPS");
  return url;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
