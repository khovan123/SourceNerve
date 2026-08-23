import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import type {
  McpAuthDiscoveryView,
  McpExtensionOAuthConfig,
} from "../shared/mcp-extension-api";

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MCP_PROTOCOL_VERSION = "2025-11-25";

interface ChallengeInfo {
  resourceMetadata?: string;
  scopes: string[];
}

export async function discoverMcpAuthorization(
  mcpUrl: string,
): Promise<McpAuthDiscoveryView> {
  const endpoint = await publicHttpsUrl(mcpUrl, "MCP endpoint");
  const challenge = await requestAuthorizationChallenge(endpoint);

  if (!challenge.challenge && challenge.status !== 401 && challenge.status !== 403) {
    return {
      status: "not-required",
      source: "none",
      registration: "preconfigured",
      scopes: [],
      notes: ["The remote MCP endpoint did not advertise an OAuth authorization challenge."],
    };
  }

  const resourceMetadataCandidates = challenge.challenge.resourceMetadata
    ? [await publicHttpsUrl(challenge.challenge.resourceMetadata, "OAuth resource metadata")]
    : await resourceWellKnownCandidates(endpoint);

  let resourceMetadata: Record<string, unknown> | null = null;
  let metadataSource: "challenge" | "well-known" = challenge.challenge.resourceMetadata
    ? "challenge"
    : "well-known";
  for (const candidate of resourceMetadataCandidates) {
    try {
      const value = await fetchJson(candidate);
      if (isRecord(value) && Array.isArray(value.authorization_servers)) {
        resourceMetadata = value;
        break;
      }
    } catch {
      // Try the next standards-defined well-known location.
    }
  }

  if (!resourceMetadata) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes: challenge.challenge.scopes,
      notes: [
        "The server requires authorization but SourceNerve could not discover valid OAuth Protected Resource Metadata.",
      ],
    };
  }

  const authorizationServers = stringArray(resourceMetadata.authorization_servers).slice(0, 4);
  if (authorizationServers.length === 0) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes: challenge.challenge.scopes,
      notes: ["Protected Resource Metadata did not declare an authorization server."],
    };
  }

  let issuer: URL | null = null;
  let authorizationMetadata: Record<string, unknown> | null = null;
  for (const candidateIssuer of authorizationServers) {
    try {
      const parsed = await publicHttpsUrl(candidateIssuer, "OAuth authorization server");
      const metadata = await discoverAuthorizationServerMetadata(parsed);
      if (metadata) {
        issuer = parsed;
        authorizationMetadata = metadata;
        break;
      }
    } catch {
      // A resource may advertise multiple authorization servers. Try the next one.
    }
  }

  if (!issuer || !authorizationMetadata) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes: challenge.challenge.scopes,
      notes: ["No advertised authorization server exposed usable OAuth/OIDC metadata."],
    };
  }

  const authorizationEndpoint = await safeMetadataEndpoint(
    authorizationMetadata.authorization_endpoint,
    "authorization endpoint",
  );
  const tokenEndpoint = await safeMetadataEndpoint(
    authorizationMetadata.token_endpoint,
    "token endpoint",
  );
  if (!authorizationEndpoint || !tokenEndpoint) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes: challenge.challenge.scopes,
      notes: ["Authorization server metadata is missing a safe authorization or token endpoint."],
    };
  }

  const codeChallengeMethods = stringArray(authorizationMetadata.code_challenge_methods_supported);
  if (!codeChallengeMethods.includes("S256")) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes: challenge.challenge.scopes,
      notes: ["The authorization server does not advertise PKCE S256, so SourceNerve refuses automatic OAuth."],
    };
  }

  const registrationEndpoint = await safeMetadataEndpoint(
    authorizationMetadata.registration_endpoint,
    "dynamic client registration endpoint",
  );
  const scopes = chooseScopes(
    challenge.challenge.scopes,
    stringArray(resourceMetadata.scopes_supported),
    stringArray(authorizationMetadata.scopes_supported),
  );
  const resource =
    typeof resourceMetadata.resource === "string"
      ? (await safeMetadataEndpoint(resourceMetadata.resource, "OAuth resource"))?.toString()
      : endpoint.toString();
  const revokeEndpoint = await safeMetadataEndpoint(
    authorizationMetadata.revocation_endpoint,
    "revocation endpoint",
  );

  if (!registrationEndpoint) {
    return {
      status: "manual",
      source: metadataSource,
      registration: "unsupported",
      scopes,
      notes: [
        "OAuth endpoints were discovered automatically, but the provider does not expose Dynamic Client Registration. A provider-specific public client ID or Client ID Metadata Document is still required.",
      ],
    };
  }

  const config: McpExtensionOAuthConfig = {
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    registrationEndpoint: registrationEndpoint.toString(),
    scopes,
    ...(revokeEndpoint ? { revokeEndpoint: revokeEndpoint.toString() } : {}),
    ...(resource ? { resource } : {}),
    issuer: issuer.toString(),
  };

  return {
    status: "oauth",
    source: metadataSource,
    registration: "dynamic",
    scopes,
    config,
    notes: [
      "OAuth Protected Resource Metadata and authorization-server metadata were discovered automatically.",
      "SourceNerve will register a public native client for the loopback callback immediately before the browser PKCE flow.",
    ],
  };
}

async function requestAuthorizationChallenge(endpoint: URL): Promise<{
  status: number;
  challenge: ChallengeInfo;
}> {
  const response = await safeFetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "SourceNerve", version: "0.1.0" },
      },
    }),
  });
  await discardBounded(response, 32 * 1024);
  return {
    status: response.status,
    challenge: parseBearerChallenge(response.headers.get("www-authenticate")),
  };
}

function parseBearerChallenge(value: string | null): ChallengeInfo {
  if (!value || !/\bBearer\b/i.test(value)) return { scopes: [] };
  const resourceMetadata = quotedParameter(value, "resource_metadata");
  const scopeText = quotedParameter(value, "scope");
  return {
    ...(resourceMetadata ? { resourceMetadata } : {}),
    scopes: scopeText ? normalizeScopes(scopeText.split(/\s+/g)) : [],
  };
}

function quotedParameter(value: string, name: string): string | undefined {
  const expression = new RegExp(`(?:^|[,\\s])${name}="([^"\\r\\n]{1,2048})"`, "i");
  return expression.exec(value)?.[1];
}

async function resourceWellKnownCandidates(endpoint: URL): Promise<URL[]> {
  const path = endpoint.pathname.replace(/^\/+/, "");
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${path ? `/${path}` : ""}`, endpoint.origin),
    new URL("/.well-known/oauth-protected-resource", endpoint.origin),
  ];
  const result: URL[] = [];
  for (const candidate of candidates) {
    const checked = await publicHttpsUrl(candidate.toString(), "OAuth resource metadata");
    if (!result.some((value) => value.toString() === checked.toString())) result.push(checked);
  }
  return result;
}

async function discoverAuthorizationServerMetadata(
  issuer: URL,
): Promise<Record<string, unknown> | null> {
  const path = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`${path}/.well-known/oauth-authorization-server`, issuer.origin),
    new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.toString())) continue;
    seen.add(candidate.toString());
    try {
      const checked = await publicHttpsUrl(candidate.toString(), "authorization metadata");
      const value = await fetchJson(checked);
      if (!isRecord(value)) continue;
      if (typeof value.authorization_endpoint === "string" && typeof value.token_endpoint === "string") {
        return value;
      }
    } catch {
      // Try the next standards-defined OAuth/OIDC metadata location.
    }
  }
  return null;
}

async function safeMetadataEndpoint(value: unknown, label: string): Promise<URL | undefined> {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    return await publicHttpsUrl(value, label);
  } catch {
    return undefined;
  }
}

function chooseScopes(challenge: string[], resource: string[], authorization: string[]): string[] {
  if (challenge.length > 0) return normalizeScopes(challenge).slice(0, 16);
  if (resource.length > 0 && resource.length <= 8) return normalizeScopes(resource);
  if (authorization.length > 0 && authorization.length <= 4) return normalizeScopes(authorization);
  return [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? normalizeScopes(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function normalizeScopes(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => /^[A-Za-z0-9:._/-]{1,128}$/.test(value)))];
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await safeFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await readBounded(response, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`OAuth discovery returned HTTP ${response.status}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("OAuth discovery returned invalid JSON");
  }
}

async function safeFetch(url: URL, init: RequestInit): Promise<Response> {
  await assertPublicHost(url);
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
}

async function publicHttpsUrl(value: string, label: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be a public HTTPS URL without embedded credentials or fragments`);
  }
  await assertPublicHost(url);
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("OAuth discovery refuses local/private hosts");
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error("OAuth discovery refuses local/private addresses");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("OAuth discovery refuses hosts resolving to local/private addresses");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0.0.0.0" || normalized === "::") return true;
  if (normalized.startsWith("127.")) return true;
  if (normalized.startsWith("10.")) return true;
  if (normalized.startsWith("192.168.")) return true;
  if (normalized.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice("::ffff:".length));
  return false;
}

async function discardBounded(response: Response, limit: number): Promise<void> {
  await readBounded(response, limit).catch(() => "");
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new Error("OAuth discovery response exceeded the size limit");
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
      throw new Error("OAuth discovery response exceeded the size limit");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
