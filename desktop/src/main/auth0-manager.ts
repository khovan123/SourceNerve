import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Auth0Identity,
  Auth0SessionView,
  DesktopRuntimeEvent,
} from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { AuthCallback } from "./security-policy";

const AUTH_METADATA_VERSION = 1 as const;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const PENDING_LOGIN_MAX_AGE_MS = 10 * 60 * 1000;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

interface SecretStore {
  get(name: "auth0AccessToken" | "auth0RefreshToken"): Promise<string | null>;
  set(name: "auth0AccessToken" | "auth0RefreshToken", value: string): Promise<void>;
  delete(name: "auth0AccessToken" | "auth0RefreshToken"): Promise<void>;
}

interface OidcMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
}

interface StoredAuthMetadata {
  version: typeof AUTH_METADATA_VERSION;
  subject: string;
  name?: string;
  email?: string;
  expiresAt: number;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  id_token?: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtClaims extends Record<string, unknown> {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  scope?: string;
  permissions?: string[];
  name?: string;
  email?: string;
}

interface JwksDocument {
  keys: JsonWebKey[];
}

export interface Auth0ManagerOptions {
  bootstrap: DesktopBootstrapState;
  openExternal(url: string): Promise<void>;
  onEvent?: (event: DesktopRuntimeEvent) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class Auth0Manager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly secretStore: SecretStore;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly metadataPath: string;
  private pending: PendingLogin | null = null;
  private current: Auth0SessionView = { status: "signed-out" };
  private oidc: OidcMetadata | null = null;
  private jwks: JwksDocument | null = null;

  constructor(options: Auth0ManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.secretStore = options.bootstrap.secretStore;
    this.openExternal = options.openExternal;
    this.onEvent = options.onEvent;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.metadataPath = path.join(options.bootstrap.paths.managedDirectory, "auth-session.json");
  }

  state(): Auth0SessionView {
    return structuredClone(this.current);
  }

  async initialize(): Promise<Auth0SessionView> {
    const accessToken = await this.secretStore.get("auth0AccessToken");
    if (!accessToken) {
      await this.clearLocalSession(false);
      return this.state();
    }

    try {
      const verified = await this.verifyAccessToken(accessToken);
      const stored = await this.readMetadata();
      if (stored && stored.subject !== verified.identity.subject) {
        throw new Error("stored Auth0 identity does not match the verified access token");
      }
      const identity: Auth0Identity = {
        subject: verified.identity.subject,
        name: stored?.name,
        email: stored?.email,
      };
      this.current = {
        status: "authenticated",
        identity,
        expiresAt: verified.expiresAt,
        scopes: verified.scopes,
      };
      if (verified.expiresAt <= this.now() + 30_000) {
        return await this.refresh();
      }
      this.publish("authenticated");
      return this.state();
    } catch (error) {
      const refreshToken = await this.secretStore.get("auth0RefreshToken");
      if (refreshToken) {
        try {
          return await this.refresh();
        } catch {
          // Fail closed below without exposing refresh/access token material.
        }
      }
      this.current = { status: "expired", error: safeError(error) };
      this.publish("expired", "SourceNerve account session needs sign-in");
      return this.state();
    }
  }

  async signIn(): Promise<Auth0SessionView> {
    const profile = this.bootstrap.profile.auth0;
    if (!profile.nativeClientId || PLACEHOLDER_PATTERN.test(profile.nativeClientId)) {
      throw new Error("SourceNerve Auth0 Native App client ID is not configured for this Desktop build");
    }

    const oidc = await this.discover();
    const verifier = base64Url(randomBytes(48));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = base64Url(randomBytes(32));
    const nonce = base64Url(randomBytes(32));
    this.pending = { state, nonce, verifier, createdAt: this.now() };

    const authorization = new URL(oidc.authorizationEndpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", profile.nativeClientId);
    authorization.searchParams.set("redirect_uri", profile.callbackUri);
    authorization.searchParams.set("audience", profile.audience);
    authorization.searchParams.set("scope", [...new Set(profile.scopes)].join(" "));
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("nonce", nonce);

    this.current = { status: "signing-in" };
    this.publish("signing-in");
    try {
      await this.openExternal(authorization.toString());
    } catch (error) {
      this.pending = null;
      this.current = { status: "error", error: safeError(error) };
      this.publish("error", "Unable to open SourceNerve account sign-in");
      throw error;
    }
    return this.state();
  }

  async handleCallback(callback: AuthCallback): Promise<Auth0SessionView> {
    const pending = this.pending;
    if (!pending || this.now() - pending.createdAt > PENDING_LOGIN_MAX_AGE_MS) {
      this.pending = null;
      throw new Error("SourceNerve authentication callback has no active sign-in attempt");
    }
    if (callback.state !== pending.state) {
      this.pending = null;
      throw new Error("SourceNerve authentication callback state mismatch");
    }
    if (callback.kind === "error") {
      this.pending = null;
      const message = `SourceNerve sign-in was not completed (${callback.error})`;
      this.current = { status: "error", error: message };
      this.publish("error", message);
      return this.state();
    }

    this.pending = null;
    const oidc = await this.discover();
    const profile = this.bootstrap.profile.auth0;
    const token = await this.exchangeToken(oidc.tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: profile.nativeClientId,
      code: callback.code,
      code_verifier: pending.verifier,
      redirect_uri: profile.callbackUri,
    });
    if (!token.id_token) throw new Error("Auth0 authorization response did not include an ID token");

    const access = await this.verifyAccessToken(token.access_token);
    const idClaims = await this.verifyJwt(token.id_token, profile.nativeClientId);
    if (idClaims.sub !== access.identity.subject) {
      throw new Error("Auth0 ID token subject does not match the access token subject");
    }
    if (idClaims.nonce !== pending.nonce) {
      throw new Error("Auth0 ID token nonce mismatch");
    }

    const identity: Auth0Identity = {
      subject: access.identity.subject,
      name: boundedOptionalProfile(idClaims.name, 256),
      email: boundedOptionalProfile(idClaims.email, 320),
    };
    await this.persistVerifiedSession(token, identity, access.expiresAt, access.scopes);
    this.current = {
      status: "authenticated",
      identity,
      expiresAt: access.expiresAt,
      scopes: access.scopes,
    };
    this.publish("authenticated");
    return this.state();
  }

  async refresh(): Promise<Auth0SessionView> {
    const refreshToken = await this.secretStore.get("auth0RefreshToken");
    if (!refreshToken) {
      this.current = { status: "expired", error: "SourceNerve account session cannot be refreshed" };
      this.publish("expired");
      return this.state();
    }
    const profile = this.bootstrap.profile.auth0;
    const oidc = await this.discover();
    const previous = await this.readMetadata();
    const token = await this.exchangeToken(oidc.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: profile.nativeClientId,
      refresh_token: refreshToken,
    });
    const access = await this.verifyAccessToken(token.access_token);
    if (previous && access.identity.subject !== previous.subject) {
      throw new Error("refreshed Auth0 session changed subject unexpectedly");
    }
    const identity: Auth0Identity = {
      subject: access.identity.subject,
      name: previous?.name,
      email: previous?.email,
    };
    await this.persistVerifiedSession(
      { ...token, refresh_token: token.refresh_token ?? refreshToken },
      identity,
      access.expiresAt,
      access.scopes,
    );
    this.current = {
      status: "authenticated",
      identity,
      expiresAt: access.expiresAt,
      scopes: access.scopes,
    };
    this.publish("authenticated");
    return this.state();
  }

  async getAccessToken(): Promise<string> {
    const accessToken = await this.secretStore.get("auth0AccessToken");
    if (!accessToken) throw new Error("SourceNerve account is not signed in");
    const verified = await this.verifyAccessToken(accessToken);
    if (verified.expiresAt > this.now() + 30_000) return accessToken;
    await this.refresh();
    const refreshed = await this.secretStore.get("auth0AccessToken");
    if (!refreshed) throw new Error("SourceNerve account session is unavailable");
    await this.verifyAccessToken(refreshed);
    return refreshed;
  }

  async logout(): Promise<Auth0SessionView> {
    this.pending = null;
    await this.clearLocalSession(true);
    return this.state();
  }

  private async clearLocalSession(publish: boolean): Promise<void> {
    await Promise.all([
      this.secretStore.delete("auth0AccessToken"),
      this.secretStore.delete("auth0RefreshToken"),
      unlink(this.metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    ]);
    this.current = { status: "signed-out" };
    if (publish) this.publish("signed-out");
  }

  private async persistVerifiedSession(
    token: TokenResponse,
    identity: Auth0Identity,
    expiresAt: number,
    scopes: string[],
  ): Promise<void> {
    await this.secretStore.set("auth0AccessToken", token.access_token);
    if (token.refresh_token) await this.secretStore.set("auth0RefreshToken", token.refresh_token);
    const metadata: StoredAuthMetadata = {
      version: AUTH_METADATA_VERSION,
      subject: identity.subject,
      name: identity.name,
      email: identity.email,
      expiresAt,
      scopes,
    };
    await atomicJson(this.metadataPath, metadata);
  }

  private async discover(): Promise<OidcMetadata> {
    if (this.oidc) return this.oidc;
    const issuer = this.bootstrap.profile.auth0.issuer;
    const discoveryUrl = new URL(".well-known/openid-configuration", issuer).toString();
    const value = await this.fetchJson(discoveryUrl, { method: "GET" });
    if (!isRecord(value) || value.issuer !== issuer) {
      throw new Error("Auth0 OIDC discovery issuer mismatch");
    }
    const authorizationEndpoint = exactIssuerHttpsUrl(value.authorization_endpoint, issuer, "authorization endpoint");
    const tokenEndpoint = exactIssuerHttpsUrl(value.token_endpoint, issuer, "token endpoint");
    const jwksUri = exactIssuerHttpsUrl(value.jwks_uri, issuer, "JWKS endpoint");
    this.oidc = { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
    return this.oidc;
  }

  private async exchangeToken(endpoint: string, fields: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams(fields).toString();
    if (Buffer.byteLength(body, "utf8") > 16 * 1024) throw new Error("Auth0 token request is oversized");
    const value = await this.fetchJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!isRecord(value)) throw new Error("Auth0 token response is invalid");
    if (
      typeof value.access_token !== "string" ||
      value.access_token.length < 32 ||
      value.access_token.length > MAX_TOKEN_BYTES ||
      value.token_type !== "Bearer"
    ) {
      throw new Error("Auth0 token response is missing a valid bearer access token");
    }
    const refreshToken =
      typeof value.refresh_token === "string" && value.refresh_token.length <= MAX_TOKEN_BYTES
        ? value.refresh_token
        : undefined;
    const idToken =
      typeof value.id_token === "string" && value.id_token.length <= MAX_TOKEN_BYTES
        ? value.id_token
        : undefined;
    return {
      access_token: value.access_token,
      token_type: "Bearer",
      refresh_token: refreshToken,
      id_token: idToken,
    };
  }

  private async verifyAccessToken(token: string): Promise<{
    identity: Auth0Identity;
    expiresAt: number;
    scopes: string[];
  }> {
    const claims = await this.verifyJwt(token, this.bootstrap.profile.auth0.audience);
    if (claims.exp - claims.iat > MAX_ACCESS_TOKEN_LIFETIME_SECONDS) {
      throw new Error("Auth0 access token lifetime exceeds the SourceNerve policy");
    }
    const scopes = normalizeScopes(claims);
    if (!scopes.includes("sourcenerve:read")) {
      throw new Error("Auth0 access token is missing sourcenerve:read");
    }
    return {
      identity: { subject: claims.sub },
      expiresAt: claims.exp * 1000,
      scopes,
    };
  }

  private async verifyJwt(token: string, expectedAudience: string): Promise<JwtClaims> {
    if (!token || token.length > MAX_TOKEN_BYTES) throw new Error("Auth0 JWT is invalid");
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("Auth0 JWT must use compact JWS format");
    const header = parseJsonSegment(segments[0]) as Partial<JwtHeader>;
    const claims = parseJsonSegment(segments[1]) as Partial<JwtClaims>;
    if (header.alg !== "RS256" || !boundedTokenField(header.kid, 256)) {
      throw new Error("Auth0 JWT algorithm or key identifier is invalid");
    }
    if (!validClaimsShape(claims)) throw new Error("Auth0 JWT claims are invalid");

    const oidc = await this.discover();
    const jwks = await this.loadJwks();
    let key = jwks.keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
    if (!key) {
      this.jwks = null;
      key = (await this.loadJwks()).keys.find(
        (candidate) => candidate.kid === header.kid && candidate.kty === "RSA",
      );
    }
    if (!key) throw new Error("Auth0 JWT signing key is unknown");

    const publicKey = createPublicKey({ key, format: "jwk" });
    const validSignature = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`, "ascii"),
      publicKey,
      decodeBase64Url(segments[2]),
    );
    if (!validSignature) throw new Error("Auth0 JWT signature is invalid");

    const typed = claims as JwtClaims;
    if (typed.iss !== oidc.issuer) throw new Error("Auth0 JWT issuer mismatch");
    if (!audienceIncludes(typed.aud, expectedAudience)) throw new Error("Auth0 JWT audience mismatch");
    if (!validSubject(typed.sub)) throw new Error("Auth0 JWT subject is invalid");
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typed.exp <= nowSeconds - CLOCK_SKEW_SECONDS) throw new Error("Auth0 JWT is expired");
    if (typed.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error("Auth0 JWT issued-at time is in the future");
    if (typed.exp <= typed.iat) throw new Error("Auth0 JWT lifetime is invalid");
    return typed;
  }

  private async loadJwks(): Promise<JwksDocument> {
    if (this.jwks) return this.jwks;
    const oidc = await this.discover();
    const value = await this.fetchJson(oidc.jwksUri, { method: "GET" });
    if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 32) {
      throw new Error("Auth0 JWKS document is invalid");
    }
    const keys = value.keys.filter(isJsonWebKey);
    if (keys.length !== value.keys.length) throw new Error("Auth0 JWKS contains an invalid key");
    this.jwks = { keys };
    return this.jwks;
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error(`Auth0 request failed with HTTP ${response.status}`);
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("Auth0 response is oversized");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Auth0 response is oversized");
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readMetadata(): Promise<StoredAuthMetadata | null> {
    try {
      const raw = await readFile(this.metadataPath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Auth0 metadata file is oversized");
      const value = JSON.parse(raw) as Partial<StoredAuthMetadata>;
      if (
        value.version !== AUTH_METADATA_VERSION ||
        !validSubject(value.subject) ||
        typeof value.expiresAt !== "number" ||
        !Array.isArray(value.scopes) ||
        value.scopes.some((scope) => typeof scope !== "string" || scope.length > 256)
      ) {
        throw new Error("Auth0 metadata file is invalid");
      }
      return {
        version: AUTH_METADATA_VERSION,
        subject: value.subject,
        name: boundedOptionalProfile(value.name, 256),
        email: boundedOptionalProfile(value.email, 320),
        expiresAt: value.expiresAt,
        scopes: value.scopes,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private publish(state: string, message?: string): void {
    this.onEvent?.({ type: "state", component: "auth", state, message });
  }
}

async function atomicJson(filePath: string, value: StoredAuthMetadata): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function exactIssuerHttpsUrl(value: unknown, issuer: string, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Auth0 ${label} is invalid`);
  }
  const candidate = new URL(value);
  const issuerUrl = new URL(issuer);
  if (
    candidate.protocol !== "https:" ||
    candidate.origin !== issuerUrl.origin ||
    candidate.username ||
    candidate.password ||
    candidate.hash
  ) {
    throw new Error(`Auth0 ${label} must stay on the configured issuer origin`);
  }
  return candidate.toString();
}

function parseJsonSegment(segment: string): unknown {
  if (!segment || segment.length > MAX_TOKEN_BYTES) throw new Error("Auth0 JWT segment is invalid");
  try {
    return JSON.parse(decodeBase64Url(segment).toString("utf8")) as unknown;
  } catch {
    throw new Error("Auth0 JWT segment is not valid JSON");
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Auth0 JWT base64url segment is invalid");
  return Buffer.from(value, "base64url");
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function validClaimsShape(value: Partial<JwtClaims>): value is JwtClaims {
  return (
    typeof value.iss === "string" &&
    typeof value.sub === "string" &&
    (typeof value.aud === "string" || (Array.isArray(value.aud) && value.aud.every((item) => typeof item === "string"))) &&
    Number.isInteger(value.exp) &&
    Number.isInteger(value.iat)
  );
}

function audienceIncludes(audience: string | string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedTokenField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && /^[A-Za-z0-9._~-]+$/.test(value);
}

function boundedOptionalProfile(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeScopes(claims: JwtClaims): string[] {
  const scopes = new Set<string>();
  if (typeof claims.scope === "string") {
    for (const scope of claims.scope.split(/\s+/)) {
      if (scope && scope.length <= 256) scopes.add(scope);
    }
  }
  if (Array.isArray(claims.permissions)) {
    for (const permission of claims.permissions) {
      if (typeof permission === "string" && permission.length <= 256) scopes.add(permission);
    }
  }
  return [...scopes].sort();
}

function isJsonWebKey(value: unknown): value is JsonWebKey {
  if (!isRecord(value)) return false;
  return (
    value.kty === "RSA" &&
    typeof value.kid === "string" &&
    value.kid.length >= 1 &&
    value.kid.length <= 256 &&
    typeof value.n === "string" &&
    typeof value.e === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "SourceNerve account operation failed";
  return message.replace(/[\r\n\0]/g, " ").slice(0, 512).trim() || "SourceNerve account operation failed";
}
