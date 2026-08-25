import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { McpExtensionView } from "../shared/mcp-extension-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { PluginManager } from "./plugin-manager";

const REMOTE_URL = "https://example.com/mcp";
const REMOTE_DEFINITION_HASH = createHash("sha256")
  .update(JSON.stringify({ type: "streamable-http", url: REMOTE_URL, auth: "none" }), "utf8")
  .update("\0", "utf8")
  .digest("hex");

function extension(overrides: Partial<McpExtensionView> = {}): McpExtensionView {
  return {
    id: `plugin-remote-${REMOTE_DEFINITION_HASH.slice(0, 16)}`,
    name: "Fixture · remote",
    version: "1.0.0",
    namespace: `plugin-remote-${REMOTE_DEFINITION_HASH.slice(0, 8)}`,
    source: "plugin-hub:fixture:remote:legacy",
    transport: { transport: "streamable-http", url: REMOTE_URL },
    authType: "none",
    status: "enabled",
    enabled: true,
    required: false,
    updateChannel: "plugin",
    credentialConfigured: false,
    credentialMaterialized: false,
    oauthConfigured: false,
    oauthConnected: false,
    discoveredTools: 0,
    exposedTools: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("PluginManager MCP ownership recovery", () => {
  it("adopts a compatible stale plugin-managed MCP instead of registering it twice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-plugin-manager-"));
    const packageRoot = path.join(root, "package");
    const registryPath = path.join(root, "state", "plugin-hub.json");
    const skillStoreRoot = path.join(root, "skills");
    const stale = extension();
    const installCalls: unknown[] = [];
    const removeCalls: string[] = [];

    try {
      await mkdir(path.join(packageRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(packageRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          description: "Fixture plugin",
          mcpServers: "./.mcp.json",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, ".mcp.json"),
        `${JSON.stringify({
          remote: {
            type: "http",
            url: REMOTE_URL,
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const fakeMcp = {
        list: async () => [stale],
        install: async (input: unknown) => {
          installCalls.push(input);
          throw new Error("duplicate registration should not be attempted");
        },
        enable: async () => stale,
        disable: async () => stale,
        remove: async (id: string) => {
          removeCalls.push(id);
          return { removed: true };
        },
        listTools: async () => [],
        updateToolPolicy: async () => undefined,
      } as unknown as McpExtensionManager;

      const manager = new PluginManager({
        mcp: fakeMcp,
        registryPath,
        skillStoreRoot,
      });

      const installed = await manager.installLocal(packageRoot);
      expect(installCalls).toHaveLength(0);
      expect(installed.createdMcpExtensions).toEqual([]);
      expect(installed.reusedMcpExtensions).toEqual([stale.id]);
      expect(installed.plugin.mcpExtensionIds).toEqual([stale.id]);

      const snapshot = await manager.list();
      expect(snapshot.mcpOwnership).toEqual([
        expect.objectContaining({
          extensionId: stale.id,
          owners: ["fixture"],
          directInstall: false,
        }),
      ]);

      await manager.remove("fixture");
      expect(removeCalls).toEqual([stale.id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
