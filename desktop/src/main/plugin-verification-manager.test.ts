import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { Auth0Manager } from "./auth0-manager";
import { PluginVerificationManager } from "./plugin-verification-manager";
import type { PublicMcpManager } from "./public-mcp-manager";
import type { SourceNerveClient } from "./sourcenerve-client";

const originalFetch = globalThis.fetch;
const challenge = "openai-domain-challenge-abc123";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("PluginVerificationManager", () => {
  it("does not report Ready before the full verification run", async () => {
    const { manager } = setup();
    const state = await manager.state();
    expect(state.status).toBe("needs-attention");
    expect(state.checks.some((item) => item.state === "not-checked")).toBe(true);
  });

  it("verifies fixed OAuth/legal/icon URLs with redirects disabled and reaches ready-to-connect", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ issuer: "https://auth.sourcenerve.example/" });
      }
      if (url.endsWith("/icon.png")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    const { manager, publicRetry } = setup();
    const result = await manager.verify();
    expect(publicRetry).toHaveBeenCalledTimes(1);
    expect(result.view.status).toBe("ready-to-connect");
    expect(result.view.checks.every((item) => item.state === "ready" || item.state === "warning")).toBe(true);
    expect(result.view.status).not.toBe("connected-ready");
  });

  it("copies the installation MCP Server URL while preserving the canonical OAuth resource", () => {
    const { manager } = setup();
    const text = manager.setupFieldsText();
    expect(text).toContain("MCP Server URL: https://mcp.sourcenerve.example/mcp");
    expect(text).toContain("OAuth resource: https://sourcenerve.example/mcp");
    expect(text).not.toContain("Public MCP resource:");
  });

  it("verifies the public domain challenge by exact byte equality and never returns the token", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://mcp.sourcenerve.example/.well-known/openai-apps-challenge");
      expect(init?.redirect).toBe("error");
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const { manager } = setup({ challenge });
    const result = await manager.verifyChallenge();
    expect(result.verified).toBe(true);
    expect(JSON.stringify(result)).not.toContain(challenge);
  });

  it("fails challenge verification when the public response differs", async () => {
    globalThis.fetch = vi.fn(async () => new Response(`${challenge}-different`, { status: 200 })) as typeof fetch;
    const { manager } = setup({ challenge });
    const result = await manager.verifyChallenge();
    expect(result).toMatchObject({ configured: true, verified: false });
  });

  it("refuses to set a challenge against an external daemon before writing secure storage", async () => {
    const { manager, secretSet } = setup({ daemonState: "external" });
    await expect(manager.setChallenge(challenge)).rejects.toThrow(/external daemon/i);
    expect(secretSet).not.toHaveBeenCalled();
  });

  it("does not accept whitespace/control challenge values", async () => {
    const { manager, secretSet } = setup();
    await expect(manager.setChallenge("contains space")).rejects.toThrow(/ASCII graphic/);
    await expect(manager.setChallenge("line\nbreak")).rejects.toThrow(/ASCII graphic/);
    expect(secretSet).not.toHaveBeenCalled();
  });
});

function setup(options: { challenge?: string; daemonState?: "ready" | "external" } = {}) {
  const secrets = new Map<string, string>();
  if (options.challenge) secrets.set("pluginChallengeToken", options.challenge);
  const secretSet = vi.fn(async (key: string, value: string) => { secrets.set(key, value); });
  const secretDelete = vi.fn(async (key: string) => { secrets.delete(key); });
  const bootstrap = {
    profile: productProfile(),
    secretStore: {
      get: vi.fn(async (key: string) => secrets.get(key)),
      set: secretSet,
      delete: secretDelete,
    },
  } as unknown as DesktopBootstrapState;
  const auth0 = {
    state: vi.fn(() => ({
      status: "authenticated",
      identity: { subject: "auth0|user", email: "user@example.test" },
      workspaceGrants: [{ workspace: "api", access: "read-write" }],
    })),
  } as unknown as Auth0Manager;
  const publicReady = {
    state: "ready",
    tunnelRunning: true,
    hostname: "mcp.sourcenerve.example",
    publicMcpUrl: "https://mcp.sourcenerve.example/mcp",
  } as const;
  const publicRetry = vi.fn(async () => publicReady);
  const publicMcp = {
    state: vi.fn(() => publicReady),
    retry: publicRetry,
  } as unknown as PublicMcpManager;
  const daemon = {
    snapshot: vi.fn(() => ({
      state: options.daemonState ?? "ready",
      managed: options.daemonState !== "external",
    })),
    configure: vi.fn(),
    restart: vi.fn(async () => ({ state: "ready", managed: true })),
    start: vi.fn(async () => ({ state: "ready", managed: true })),
  } as unknown as DaemonManager;
  const client = {
    health: vi.fn(async () => ({ status: "ok" })),
  } as unknown as SourceNerveClient;
  const manager = new PluginVerificationManager({
    bootstrap,
    auth0: () => auth0,
    publicMcp: () => publicMcp,
    daemon: () => daemon,
    client: () => client,
    openExternal: vi.fn(async () => undefined),
  });
  return { manager, publicRetry, secretSet, secretDelete };
}

function productProfile() {
  return {
    product: { name: "SourceNerve" },
    plugin: {
      name: "SourceNerve",
      description: "Repository intelligence",
      iconUrl: "https://sourcenerve.example/icon.png",
      chatgptSetupUrl: "https://chatgpt.com/",
    },
    publicMcp: { resource: "https://sourcenerve.example/mcp" },
    auth0: {
      issuer: "https://auth.sourcenerve.example/",
      resource: "https://sourcenerve.example/mcp",
      scopes: ["sourcenerve:read"],
    },
    legal: {
      privacyUrl: "https://sourcenerve.example/privacy",
      termsUrl: "https://sourcenerve.example/terms",
      supportUrl: "https://sourcenerve.example/support",
    },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
