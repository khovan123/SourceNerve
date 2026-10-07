import { describe, expect, it, vi } from "vitest";

import type { DesktopControlBridge, DesktopControlState } from "./desktop-control-bridge";
import type { McpExtensionClient } from "./mcp-extension-client";
import { DesktopControlMcpServer } from "./desktop-control-mcp-server";

function state(overrides: Partial<DesktopControlState> = {}): DesktopControlState {
  return {
    enabled: true,
    platform: "linux",
    permissions: { screen: true, mouse: false, keyboard: false, clipboard: true },
    inputBackend: { id: "none", mouse: false, keyboard: false, notes: [] },
    availableActions: ["observe", "screenshot", "clipboard-read", "clipboard-write"],
    notes: [],
    ...overrides,
  };
}

function fakeBridge(current: DesktopControlState) {
  return {
    state: vi.fn(async () => current),
    observe: vi.fn(async () => ({
      platform: "linux" as const,
      sources: [{ id: "screen:0", name: "Primary" }],
    })),
    run: vi.fn(async (input: { action: string }) => ({
      action: input.action,
      status: "completed" as const,
      ...(input.action === "screenshot" ? { result: "data:image/png;base64,abc" } : {}),
    })),
  };
}

function fakeClient() {
  let extension: Record<string, unknown> | undefined;
  const policies = new Map<string, { enabled: boolean; approval: string }>();
  const tools = [
    "get_desktop_state",
    "get_screens",
    "get_screenshot",
    "get_clipboard_text",
    "set_clipboard_text",
    "move_mouse",
    "click_screen",
    "press_key",
    "type_text",
  ];
  const client = {
    list: vi.fn(async () => extension ? [extension] : []),
    install: vi.fn(async (input: { id: string; version: string; namespace: string; source: string; transport: unknown }) => {
      extension = { ...input, enabled: false };
      return extension;
    }),
    enable: vi.fn(async () => {
      if (!extension) throw new Error("not installed");
      extension = { ...extension, enabled: true };
      return extension;
    }),
    disable: vi.fn(async () => {
      if (extension) extension = { ...extension, enabled: false };
      return extension;
    }),
    remove: vi.fn(async () => {
      extension = undefined;
      return { removed: true };
    }),
    listTools: vi.fn(async () => tools.map((name) => ({ original_name: name }))),
    updateToolPolicy: vi.fn(async (input: { toolName: string; enabled: boolean; approval: string }) => {
      policies.set(input.toolName, { enabled: input.enabled, approval: input.approval });
      return input;
    }),
  };
  return { client, policies, extension: () => extension };
}

async function rpc(url: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe("DesktopControlMcpServer", () => {
  it("registers the built-in desktop-control extension and enables only operational tools", async () => {
    const bridge = fakeBridge(state());
    const gateway = fakeClient();
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.31",
    });

    try {
      const url = await server.start();
      await server.reconcile();

      expect(gateway.extension()).toMatchObject({
        id: "sourcenerve-desktop-control",
        namespace: "desktop-control",
        source: "builtin://sourcenerve/desktop-control",
        enabled: true,
        transport: { transport: "streamable-http", url },
      });
      expect(gateway.policies.get("get_screenshot")).toEqual({ enabled: true, approval: "automatic" });
      expect(gateway.policies.get("set_clipboard_text")).toEqual({ enabled: true, approval: "ask" });
      expect(gateway.policies.get("click_screen")).toEqual({ enabled: false, approval: "ask" });
      expect(gateway.policies.get("type_text")).toEqual({ enabled: false, approval: "ask" });
    } finally {
      await server.stop();
    }
  });

  it("serves a stateless MCP handshake, tool catalog, and delegates calls to DesktopControlBridge", async () => {
    const bridge = fakeBridge(state());
    const gateway = fakeClient();
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.31",
    });

    try {
      const url = await server.start();
      const initialized = await rpc(url, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(initialized.status).toBe(200);
      expect(initialized.json).toMatchObject({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "sourcenerve-desktop-control", version: "0.1.31" },
        },
      });

      const listed = await rpc(url, "tools/list");
      const result = listed.json.result as { tools: Array<{ name: string }> };
      expect(result.tools.map((tool) => tool.name)).toContain("get_screenshot");
      expect(result.tools.map((tool) => tool.name)).toContain("click_screen");

      const called = await rpc(url, "tools/call", { name: "get_screenshot", arguments: {} });
      expect(called.json).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            action: "screenshot",
            status: "completed",
            result: "data:image/png;base64,abc",
          },
        },
      });
      expect(bridge.run).toHaveBeenCalledWith({ action: "screenshot" });
    } finally {
      await server.stop();
    }
  });

  it("fails closed when the reserved built-in id is owned by another registration", async () => {
    const bridge = fakeBridge(state());
    const gateway = fakeClient();
    gateway.client.list.mockResolvedValue([
      {
        id: "sourcenerve-desktop-control",
        version: "0.1.31",
        namespace: "untrusted-control",
        source: "https://example.invalid/mcp",
        enabled: true,
        transport: { transport: "streamable-http", url: "https://example.invalid/mcp" },
      },
    ]);
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.31",
    });

    try {
      await server.start();
      await expect(server.reconcile()).rejects.toThrow("already owned by another registration");
      expect(gateway.client.remove).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("keeps the gateway disabled when permissions do not produce an operational action", async () => {
    const bridge = fakeBridge(state({
      enabled: false,
      permissions: { screen: false, mouse: true, keyboard: true, clipboard: false },
      availableActions: [],
    }));
    const gateway = fakeClient();
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.31",
    });

    try {
      await server.start();
      await server.reconcile();
      expect(gateway.extension()).toMatchObject({ enabled: false });
      expect(gateway.client.enable).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
