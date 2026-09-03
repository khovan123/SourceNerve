import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import type { EncryptedSecretStore } from "./secure-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpExtensionOAuthManager Dynamic Client Registration", () => {
  it("reports an HTTP registration rejection instead of invalid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>forbidden</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })));
    const values = new Map<string, string>();
    const secretStore = {
      setOpaque: async (key: string, value: string) => { values.set(key, value); },
      getOpaque: async (key: string) => values.get(key) ?? null,
      deleteOpaque: async (key: string) => { values.delete(key); },
    } as unknown as EncryptedSecretStore;
    const client = {
      clearCredential: async () => ({}),
      materializeCredential: async () => ({}),
    } as unknown as McpExtensionClient;
    const manager = new McpExtensionOAuthManager({
      secretStore,
      client,
      openExternal: async () => undefined,
    });
    await manager.saveConfig("example", {
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
      registrationEndpoint: "https://auth.example.test/register",
      scopes: ["read"],
    });

    await expect(manager.connect("example")).rejects.toThrow(
      "MCP extension OAuth client registration failed: registration_failed (HTTP 403)",
    );
    await manager.shutdown();
  });
});
