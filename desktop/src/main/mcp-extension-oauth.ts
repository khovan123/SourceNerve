import { createHash, randomBytes } from "node:crypto";

import type {
  McpExtensionOAuthActionResult,
  McpExtensionOAuthConfig,
} from "../shared/mcp-extension-api";
import type { McpExtensionClient } from "./mcp-extension-client";
import type { EncryptedSecretStore } from "./secure-store";

const REDIRECT_URI = "sourcenerve://mcp-extension/oauth/callback";
const PENDING_KEY = "mcp-extension:oauth-pending";
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 20_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;
const EXPIRY_SKEW_MS = 60_000;

interface OAuthPendingState {
  extensionId: string;
  state: string;
  verifier: string;
  createdAt: number;
}

interface OAuthTokenMeta {
  expiresAt?: number;
  tokenType?: string;
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
}

export interface McpExtensionOAuthOptions {
  secretStore: EncryptedSecretStore;
  client: McpExtensionClient;
  openExternal(url: string): Promise<unknown>;
}

export class McpExtensionOAuthManager {
  private readonly secretStore: EncryptedSecretStore;
  private readonly client: McpExtensionClient;
  private readonly openExternal: (url: string) => Promise<unknown>;

  constructor(options: McpExtensionOAuthOptions) {
    this.secretStore = options.secretStore;
    this.client = options.client;
    this.openExternal = options.openExternal;
  }

  async saveConfig(extensionId: string, config: McpExtensionOAuthConfig): Promise<void> {
    validateExtensionId(extensionId);
    validateOAuthConfig(config);
    await this.secretStore.setOpaque(configKey(extensionId), JSON.stringify(config));
  }

  async remove(extensionId: string): Promise<void> {
    validateExtensionId(extensionId);
    await Promise.all([
      this.secretStore.deleteOpaque(configKey(extensionId)).catch(() => undefined),
      this.secretStore.deleteOpaque(accessKey(extensionId)).catch(() => undefined),
      this.secretStore.deleteOpaque(refreshKey(extensionId)).catch(() => undefined),
      this.secretStore.deleteOpaque(metaKey(extensionId)).catch(() => undefined),
    ]);
    await this.client.clearCredential(extensionId).catch(() => undefined);
  }

  async status(extensionId: string): Promise<{
    configured: boolean;
    connected: boolean;
    expiresAt?: number;
  }> {
    validateExtensionId(extensionId);
    const [config, accessToken, meta] = await Promise.all([
      this.secretStore.getOpaque(configKey(extensionId)),
      this.secretStore.getOpaque(accessKey(extensionId)),
      this.readMeta(extensionId),
    ]);
    return {
      configured: Boolean(config),
      connected: Boolean(accessToken),
      ...(meta?.expiresAt ? { expiresAt: meta.expiresAt } : {}),
    };
  }

  async restore(extensionId: string): Promise<boolean> {
    validateExtensionId(extensionId);
    const accessToken = await this.secretStore.getOpaque(accessKey(extensionId));
    if (!accessToken) return false;
    const meta = await this.readMeta(extensionId);
    if (meta?.expiresAt && meta.expiresAt <= Date.now() + EXPIRY_SKEW_MS) {
      const refreshed = await this.tryRefresh(extensionId);
      return refreshed.connected;
    }
    await this.client.materializeCredential(extensionId, accessToken);
    return true;
  }

  async connect(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const config = await this.requireConfig(extensionId);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const pending: OAuthPendingState = {
      extensionId,
      state,
      verifier,
      createdAt: Date.now(),
    };
    await this.secretStore.setOpaque(PENDING_KEY, JSON.stringify(pending));

    const authorization = new URL(config.authorizationEndpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", REDIRECT_URI);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("scope", config.scopes.join(" "));
    if (config.resource) authorization.searchParams.set("resource", config.resource);

    await this.openExternal(authorization.toString());
    return {
      extensionId,
      connected: false,
      message: "OAuth authorization opened in the system browser. Complete sign-in to return to SourceNerve.",
    };
  }

  async handleCallback(callbackUrl: string): Promise<McpExtensionOAuthActionResult> {
    const callback = parseCallbackUrl(callbackUrl);
    const pending = await this.readPending();
    if (!pending) throw new Error("No pending MCP extension OAuth authorization was found");
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      await this.secretStore.deleteOpaque(PENDING_KEY).catch(() => undefined);
      throw new Error("MCP extension OAuth authorization expired; start Connect again");
    }
    if (!timingSafeTextEqual(callback.state, pending.state)) {
      throw new Error("MCP extension OAuth callback state did not match the pending authorization");
    }
    if (callback.error) {
      await this.secretStore.deleteOpaque(PENDING_KEY).catch(() => undefined);
      throw new Error(`MCP extension OAuth authorization was denied: ${callback.error}`);
    }
    if (!callback.code) throw new Error("MCP extension OAuth callback did not include an authorization code");

    const config = await this.requireConfig(pending.extensionId);
    const token = await requestToken(config, {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: callback.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
      ...(config.resource ? { resource: config.resource } : {}),
    });
    await this.persistTokens(pending.extensionId, token);
    await this.secretStore.deleteOpaque(PENDING_KEY).catch(() => undefined);
    await this.client.materializeCredential(pending.extensionId, token.accessToken);
    return {
      extensionId: pending.extensionId,
      connected: true,
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      message: "OAuth connection completed and the access token was materialized only to the local SourceNerve gateway.",
    };
  }

  async refresh(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    return this.tryRefresh(extensionId, true);
  }

  async revoke(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const config = await this.requireConfig(extensionId);
    const accessToken = await this.secretStore.getOpaque(accessKey(extensionId));
    const refreshToken = await this.secretStore.getOpaque(refreshKey(extensionId));
    const token = refreshToken ?? accessToken;
    if (token && config.revokeEndpoint) {
      await revokeToken(config, token);
    }
    await Promise.all([
      this.secretStore.deleteOpaque(accessKey(extensionId)).catch(() => undefined),
      this.secretStore.deleteOpaque(refreshKey(extensionId)).catch(() => undefined),
      this.secretStore.deleteOpaque(metaKey(extensionId)).catch(() => undefined),
    ]);
    await this.client.clearCredential(extensionId).catch(() => undefined);
    return {
      extensionId,
      connected: false,
      message: config.revokeEndpoint
        ? "OAuth token revoked and local credentials cleared."
        : "Local OAuth credentials cleared. This provider does not declare a revocation endpoint.",
    };
  }

  private async tryRefresh(
    extensionId: string,
    failWhenUnavailable = false,
  ): Promise<McpExtensionOAuthActionResult> {
    const config = await this.requireConfig(extensionId);
    const refreshToken = await this.secretStore.getOpaque(refreshKey(extensionId));
    if (!refreshToken) {
      if (failWhenUnavailable) {
        throw new Error(`MCP extension ${extensionId} does not have a refresh token; connect again`);
      }
      return {
        extensionId,
        connected: false,
        message: "OAuth refresh token is unavailable; reconnect is required.",
      };
    }
    const token = await requestToken(config, {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken,
      ...(config.resource ? { resource: config.resource } : {}),
    });
    if (!token.refreshToken) token.refreshToken = refreshToken;
    await this.persistTokens(extensionId, token);
    await this.client.materializeCredential(extensionId, token.accessToken);
    return {
      extensionId,
      connected: true,
      ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
      message: "OAuth access token refreshed and materialized to the local SourceNerve gateway.",
    };
  }

  private async persistTokens(extensionId: string, token: TokenResponse): Promise<void> {
    await this.secretStore.setOpaque(accessKey(extensionId), token.accessToken);
    if (token.refreshToken) {
      await this.secretStore.setOpaque(refreshKey(extensionId), token.refreshToken);
    }
    await this.secretStore.setOpaque(
      metaKey(extensionId),
      JSON.stringify({
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        ...(token.tokenType ? { tokenType: token.tokenType } : {}),
      } satisfies OAuthTokenMeta),
    );
  }

  private async requireConfig(extensionId: string): Promise<McpExtensionOAuthConfig> {
    const raw = await this.secretStore.getOpaque(configKey(extensionId));
    if (!raw) throw new Error(`MCP extension ${extensionId} does not have OAuth configuration`);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`MCP extension ${extensionId} OAuth configuration is corrupt`);
    }
    if (!isOAuthConfig(value)) throw new Error(`MCP extension ${extensionId} OAuth configuration is invalid`);
    return value;
  }

  private async readPending(): Promise<OAuthPendingState | null> {
    const raw = await this.secretStore.getOpaque(PENDING_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<OAuthPendingState>;
      if (
        typeof value.extensionId === "string" &&
        typeof value.state === "string" &&
        typeof value.verifier === "string" &&
        typeof value.createdAt === "number"
      ) {
        validateExtensionId(value.extensionId);
        return value as OAuthPendingState;
      }
    } catch {
      // Fall through to a bounded corruption error.
    }
    throw new Error("Pending MCP extension OAuth authorization state is corrupt");
  }

  private async readMeta(extensionId: string): Promise<OAuthTokenMeta | null> {
    const raw = await this.secretStore.getOpaque(metaKey(extensionId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return {
        ...(typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt)
          ? { expiresAt: value.expiresAt }
          : {}),
        ...(typeof value.tokenType === "string" ? { tokenType: value.tokenType } : {}),
      };
    } catch {
      return null;
    }
  }
}

async function requestToken(
  config: McpExtensionOAuthConfig,
  fields: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const text = await readResponseBounded(response, MAX_TOKEN_RESPONSE_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`MCP extension OAuth token endpoint returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const code = isRecord(value) && typeof value.error === "string" ? value.error : "token_request_failed";
    throw new Error(`MCP extension OAuth token request failed: ${safeOAuthCode(code)}`);
  }
  if (!isRecord(value) || !safeToken(value.access_token)) {
    throw new Error("MCP extension OAuth token response did not contain a valid access_token");
  }
  const expiresIn =
    typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 0
      ? Math.min(value.expires_in, 365 * 24 * 60 * 60)
      : undefined;
  return {
    accessToken: value.access_token,
    ...(safeToken(value.refresh_token) ? { refreshToken: value.refresh_token } : {}),
    ...(expiresIn ? { expiresAt: Date.now() + Math.floor(expiresIn * 1000) } : {}),
    ...(typeof value.token_type === "string" && value.token_type.length <= 64
      ? { tokenType: value.token_type }
      : {}),
  };
}

async function revokeToken(config: McpExtensionOAuthConfig, token: string): Promise<void> {
  if (!config.revokeEndpoint) return;
  const response = await fetch(config.revokeEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token, client_id: config.clientId }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  await readResponseBounded(response, MAX_TOKEN_RESPONSE_BYTES);
  if (!response.ok) {
    throw new Error(`MCP extension OAuth revocation failed with HTTP ${response.status}`);
  }
}

async function readResponseBounded(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new Error("MCP extension OAuth response exceeded the size limit");
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
      throw new Error("MCP extension OAuth response exceeded the size limit");
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

function parseCallbackUrl(value: string): { state: string; code?: string; error?: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP extension OAuth callback URL is invalid");
  }
  if (url.protocol !== "sourcenerve:" || url.hostname !== "mcp-extension" || url.pathname !== "/oauth/callback") {
    throw new Error("MCP extension OAuth callback target is invalid");
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (!state || state.length > 256 || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new Error("MCP extension OAuth callback state is invalid");
  }
  if (code && (code.length > 4096 || /[\r\n\0]/.test(code))) {
    throw new Error("MCP extension OAuth authorization code is invalid");
  }
  if (error && (error.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(error))) {
    throw new Error("MCP extension OAuth error code is invalid");
  }
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

function validateOAuthConfig(config: McpExtensionOAuthConfig): void {
  if (!isOAuthConfig(config)) throw new Error("MCP extension OAuth configuration is invalid");
}

function isOAuthConfig(value: unknown): value is McpExtensionOAuthConfig {
  if (!isRecord(value)) return false;
  if (!isHttpsUrl(value.authorizationEndpoint) || !isHttpsUrl(value.tokenEndpoint)) return false;
  if (!safeClientId(value.clientId)) return false;
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.length < 1 ||
    value.scopes.length > 32 ||
    !value.scopes.every((scope) => typeof scope === "string" && /^[A-Za-z0-9:._/-]{1,128}$/.test(scope))
  ) {
    return false;
  }
  if (value.revokeEndpoint !== undefined && !isHttpsUrl(value.revokeEndpoint)) return false;
  if (value.resource !== undefined && !isHttpsUrl(value.resource)) return false;
  return true;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function safeClientId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

function safeToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_TOKEN_BYTES && !/[\r\n\0]/.test(value);
}

function safeOAuthCode(value: string): string {
  return /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : "oauth_error";
}

function validateExtensionId(value: string): void {
  if (!/^[a-z0-9_-]{1,64}$/.test(value)) throw new Error("MCP extension id is invalid");
}

function configKey(id: string): string {
  return `mcp-extension:${id}:oauth-config`;
}
function accessKey(id: string): string {
  return `mcp-extension:${id}:credential`;
}
function refreshKey(id: string): string {
  return `mcp-extension:${id}:oauth-refresh`;
}
function metaKey(id: string): string {
  return `mcp-extension:${id}:oauth-meta`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return leftHash.equals(rightHash);
}
