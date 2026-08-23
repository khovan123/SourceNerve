import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  McpExtensionOAuthActionResult,
  McpExtensionOAuthConfig,
} from "../shared/mcp-extension-api";
import type { McpExtensionClient } from "./mcp-extension-client";
import type { EncryptedSecretStore } from "./secure-store";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/oauth/callback";
const PENDING_TTL_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 20_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_CALLBACK_URL_BYTES = 8 * 1024;
const EXPIRY_SKEW_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_000_000_000;
const AUTO_REFRESH_RETRY_MS = 60_000;

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

interface LoopbackCallback {
  redirectUri: string;
  callback: Promise<string>;
  close(): Promise<void>;
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
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private pendingLoopback: LoopbackCallback | null = null;

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

  async shutdown(): Promise<void> {
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    const loopback = this.pendingLoopback;
    this.pendingLoopback = null;
    if (loopback) await loopback.close().catch(() => undefined);
  }

  async remove(extensionId: string): Promise<void> {
    validateExtensionId(extensionId);
    this.cancelRefresh(extensionId);
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
    const connected = Boolean(accessToken) && (!meta?.expiresAt || meta.expiresAt > Date.now());
    return {
      configured: Boolean(config),
      connected,
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
    await this.scheduleRefreshFromStorage(extensionId, meta?.expiresAt);
    return true;
  }

  async connect(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    if (this.pendingLoopback) {
      throw new Error("Another MCP extension OAuth authorization is already waiting for the browser callback");
    }
    const config = await this.requireConfig(extensionId);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    const loopback = await startLoopbackCallback(state);
    this.pendingLoopback = loopback;

    const authorization = new URL(config.authorizationEndpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", loopback.redirectUri);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("scope", config.scopes.join(" "));
    if (config.resource) authorization.searchParams.set("resource", config.resource);

    try {
      await this.openExternal(authorization.toString());
      const callbackUrl = await loopback.callback;
      const callback = parseCallbackUrl(callbackUrl, loopback.redirectUri);
      if (callback.error) {
        throw new Error(`MCP extension OAuth authorization was denied: ${callback.error}`);
      }
      if (!callback.code) {
        throw new Error("MCP extension OAuth callback did not include an authorization code");
      }

      const token = await requestToken(config, {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: callback.code,
        redirect_uri: loopback.redirectUri,
        code_verifier: verifier,
        ...(config.resource ? { resource: config.resource } : {}),
      });
      await this.persistTokens(extensionId, token);
      await this.client.materializeCredential(extensionId, token.accessToken);
      return {
        extensionId,
        connected: true,
        ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
        message: "OAuth PKCE completed through a localhost loopback callback. Tokens are stored only in OS-backed secure storage and the access token is materialized only to the local SourceNerve gateway.",
      };
    } finally {
      if (this.pendingLoopback === loopback) this.pendingLoopback = null;
      await loopback.close().catch(() => undefined);
    }
  }

  async refresh(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    return this.tryRefresh(extensionId, true);
  }

  async revoke(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    this.cancelRefresh(extensionId);
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
      this.cancelRefresh(extensionId);
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
    await this.scheduleRefreshFromStorage(extensionId, token.expiresAt);
  }

  private async scheduleRefreshFromStorage(
    extensionId: string,
    expiresAt: number | undefined,
  ): Promise<void> {
    this.cancelRefresh(extensionId);
    if (!expiresAt || !(await this.secretStore.hasOpaque(refreshKey(extensionId)))) return;
    const desiredDelay = expiresAt - Date.now() - EXPIRY_SKEW_MS;
    const delay = Math.max(1_000, Math.min(desiredDelay, MAX_TIMER_DELAY_MS));
    const timer = setTimeout(() => {
      this.refreshTimers.delete(extensionId);
      void this.autoRefresh(extensionId, expiresAt);
    }, delay);
    timer.unref();
    this.refreshTimers.set(extensionId, timer);
  }

  private async autoRefresh(extensionId: string, expectedExpiry: number): Promise<void> {
    try {
      const meta = await this.readMeta(extensionId);
      if (meta?.expiresAt && meta.expiresAt !== expectedExpiry) {
        await this.scheduleRefreshFromStorage(extensionId, meta.expiresAt);
        return;
      }
      if (expectedExpiry > Date.now() + EXPIRY_SKEW_MS) {
        await this.scheduleRefreshFromStorage(extensionId, expectedExpiry);
        return;
      }
      await this.tryRefresh(extensionId);
    } catch {
      const timer = setTimeout(() => {
        this.refreshTimers.delete(extensionId);
        void this.autoRefresh(extensionId, expectedExpiry);
      }, AUTO_REFRESH_RETRY_MS);
      timer.unref();
      this.refreshTimers.set(extensionId, timer);
    }
  }

  private cancelRefresh(extensionId: string): void {
    const timer = this.refreshTimers.get(extensionId);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(extensionId);
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
    if (!isOAuthConfig(value)) {
      throw new Error(`MCP extension ${extensionId} OAuth configuration is invalid`);
    }
    return value;
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

async function startLoopbackCallback(expectedState: string): Promise<LoopbackCallback> {
  let redirectUri = "";
  let settled = false;
  let resolveCallback: (value: string) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      respondText(response, 403, "SourceNerve OAuth callback rejected.");
      return;
    }
    if (request.method !== "GET" || !request.url || request.url.length > MAX_CALLBACK_URL_BYTES) {
      respondText(response, 400, "SourceNerve OAuth callback request is invalid.");
      return;
    }
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url, redirectUri || `http://${CALLBACK_HOST}`);
    } catch {
      respondText(response, 400, "SourceNerve OAuth callback URL is invalid.");
      return;
    }
    if (callbackUrl.pathname === "/favicon.ico") {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }
    if (callbackUrl.pathname !== CALLBACK_PATH) {
      respondText(response, 404, "SourceNerve OAuth callback path was not found.");
      return;
    }
    const state = callbackUrl.searchParams.get("state");
    if (!state || !timingSafeTextEqual(state, expectedState)) {
      respondText(response, 400, "SourceNerve OAuth callback state did not match.");
      return;
    }
    if (settled) {
      respondText(response, 409, "SourceNerve OAuth callback was already received.");
      return;
    }
    settled = true;
    respondText(
      response,
      200,
      "SourceNerve received the OAuth authorization response. You can close this browser tab and return to the Desktop app.",
    );
    resolveCallback(callbackUrl.toString());
  });

  await listenLoopback(server);
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("SourceNerve could not determine the OAuth loopback callback port");
  }
  redirectUri = `http://${CALLBACK_HOST}:${(address as AddressInfo).port}${CALLBACK_PATH}`;

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectCallback(new Error("MCP extension OAuth authorization timed out; start Connect again"));
    void closeServer(server);
  }, PENDING_TTL_MS);
  timeout.unref();

  return {
    redirectUri,
    callback: callback.finally(() => clearTimeout(timeout)),
    async close() {
      clearTimeout(timeout);
      await closeServer(server);
    },
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, CALLBACK_HOST);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function securityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function respondText(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === CALLBACK_HOST || value === `::ffff:${CALLBACK_HOST}` || value === "::1";
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
  if (
    value.token_type !== undefined &&
    (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer")
  ) {
    throw new Error("MCP extension OAuth token endpoint returned an unsupported token_type");
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
  if (declared && Number(declared) > limit) {
    throw new Error("MCP extension OAuth response exceeded the size limit");
  }
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

function parseCallbackUrl(
  value: string,
  redirectUri: string,
): { state: string; code?: string; error?: string } {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(value);
    expected = new URL(redirectUri);
  } catch {
    throw new Error("MCP extension OAuth callback URL is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== CALLBACK_HOST ||
    url.origin !== expected.origin ||
    url.pathname !== CALLBACK_PATH
  ) {
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
    !value.scopes.every(
      (scope) => typeof scope === "string" && /^[A-Za-z0-9:._/-]{1,128}$/.test(scope),
    )
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
