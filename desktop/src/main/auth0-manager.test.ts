import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import { Auth0Manager } from "./auth0-manager";

const ISSUER = "https://tenant.example.test/";
const CLIENT_ID = "native-client-id";
const AUDIENCE = "https://sourcenerve.example.test/mcp";
const CALLBACK = "sourcenerve://oauth/callback";
const NOW = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Auth0Manager", () => {
  it("completes Authorization Code + PKCE and exposes only safe identity metadata", async () => {
    const fixture = await createFixture();
    let authorizationUrl = "";
    const manager = new Auth0Manager({
      bootstrap: fixture.bootstrap,
      now: () => NOW,
      openExternal: async (url) => { authorizationUrl = url; },
      fetchImpl: fixture.fetchImpl,
    });

    await expect(manager.signIn()).resolves.toEqual({ status: "signing-in" });
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin).toBe("https://tenant.example.test");
    expect(authorization.pathname).toBe("/authorize");
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorization.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(authorization.searchParams.get("audience")).toBe(AUDIENCE);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.has("client_secret")).toBe(false);

    fixture.authorization = authorization;
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    const completed = await manager.handleCallback({ kind: "success", code: "authorization-code", state: state! });

    expect(completed.status).toBe("authenticated");
    expect(completed.identity).toEqual({
      subject: "auth0|desktop-user",
      name: "Desktop User",
      email: "desktop@example.test",
    });
    expect(completed.scopes).toContain("sourcenerve:read");
    expect(JSON.stringify(completed)).not.toContain(fixture.accessToken);
    expect(JSON.stringify(completed)).not.toContain(fixture.refreshToken);
    expect(fixture.secrets.get("auth0AccessToken")).toBe(fixture.accessToken);
    expect(fixture.secrets.get("auth0RefreshToken")).toBe(fixture.refreshToken);
    expect(fixture.lastTokenRequest).toContain("grant_type=authorization_code");
    expect(fixture.lastTokenRequest).toContain("code_verifier=");
    expect(fixture.lastTokenRequest).not.toContain("client_secret");
  });

  it("fails closed when the callback state does not match the active sign-in", async () => {
    const fixture = await createFixture();
    const manager = new Auth0Manager({
      bootstrap: fixture.bootstrap,
      now: () => NOW,
      openExternal: async (url) => { fixture.authorization = new URL(url); },
      fetchImpl: fixture.fetchImpl,
    });
    await manager.signIn();
    await expect(manager.handleCallback({ kind: "success", code: "authorization-code", state: "wrong-state" })).rejects.toThrow(/state mismatch/);
    expect(fixture.secrets.has("auth0AccessToken")).toBe(false);
    expect(fixture.secrets.has("auth0RefreshToken")).toBe(false);
  });

  it("rejects a signed access token for the wrong SourceNerve audience", async () => {
    const fixture = await createFixture({ accessAudience: "https://wrong.example.test/mcp" });
    const manager = new Auth0Manager({
      bootstrap: fixture.bootstrap,
      now: () => NOW,
      openExternal: async (url) => { fixture.authorization = new URL(url); },
      fetchImpl: fixture.fetchImpl,
    });
    await manager.signIn();
    await expect(manager.handleCallback({
      kind: "success",
      code: "authorization-code",
      state: fixture.authorization.searchParams.get("state")!,
    })).rejects.toThrow(/audience mismatch/);
    expect(fixture.secrets.has("auth0AccessToken")).toBe(false);
  });
});

async function createFixture(options: { accessAudience?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-auth0-"));
  temporaryDirectories.push(directory);
  const secrets = new Map<string, string>();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  const kid = "desktop-test-key";
  let authorization = new URL(`${ISSUER}authorize`);
  let lastTokenRequest = "";
  let accessToken = "";
  const refreshToken = "refresh-token-" + "R".repeat(48);

  const bootstrap = {
    profile: {
      auth0: {
        issuer: ISSUER,
        nativeClientId: CLIENT_ID,
        audience: AUDIENCE,
        scopes: ["openid", "profile", "email", "offline_access", "sourcenerve:read", "sourcenerve:write"],
        callbackUri: CALLBACK,
        flow: "authorization_code_pkce",
      },
    },
    paths: { managedDirectory: directory },
    secretStore: {
      async get(name: string) { return secrets.get(name) ?? null; },
      async set(name: string, value: string) { secrets.set(name, value); },
      async delete(name: string) { secrets.delete(name); },
    },
  } as unknown as DesktopBootstrapState;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${ISSUER}.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize`,
        token_endpoint: `${ISSUER}oauth/token`,
        jwks_uri: `${ISSUER}.well-known/jwks.json`,
      });
    }
    if (url === `${ISSUER}.well-known/jwks.json`) {
      return json({ keys: [{ ...publicJwk, kid, use: "sig", alg: "RS256" }] });
    }
    if (url === `${ISSUER}oauth/token`) {
      lastTokenRequest = String(init?.body ?? "");
      const nonce = authorization.searchParams.get("nonce") ?? "missing-nonce";
      const nowSeconds = Math.floor(NOW / 1000);
      accessToken = jwt(privateKey, kid, {
        iss: ISSUER,
        sub: "auth0|desktop-user",
        aud: options.accessAudience ?? AUDIENCE,
        iat: nowSeconds,
        exp: nowSeconds + 300,
        scope: "openid profile email sourcenerve:read sourcenerve:write",
      });
      const idToken = jwt(privateKey, kid, {
        iss: ISSUER,
        sub: "auth0|desktop-user",
        aud: CLIENT_ID,
        iat: nowSeconds,
        exp: nowSeconds + 300,
        nonce,
        name: "Desktop User",
        email: "desktop@example.test",
      });
      return json({ access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, id_token: idToken });
    }
    throw new Error(`unexpected test request: ${url}`);
  };

  return {
    bootstrap,
    secrets,
    fetchImpl,
    refreshToken,
    get accessToken() { return accessToken; },
    get authorization() { return authorization; },
    set authorization(value: URL) { authorization = value; },
    get lastTokenRequest() { return lastTokenRequest; },
  };
}

function jwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = base64Json({ alg: "RS256", typ: "JWT", kid });
  const payload = base64Json(claims);
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
