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
    listApplications: vi.fn(async () => ({ platform: "linux" as const, applications: [{ id: "com.spotify.Client", name: "Spotify", launcher: "linux-desktop-entry" as const }] })),
    launchApplication: vi.fn(async (applicationId: string) => ({ application: { id: applicationId, name: "Spotify", launcher: "linux-desktop-entry" as const } })),
    listMediaPlayers: vi.fn(async () => ({ platform: "linux" as const, players: [{ id: "org.mpris.MediaPlayer2.spotify", name: "Spotify", playbackStatus: "Paused" }] })),
    controlMediaPlayer: vi.fn(async (playerId: string, action: string) => ({ playerId, action })),
    openMediaUri: vi.fn(async (playerId: string, uri: string) => ({ playerId, uri })),
    run: vi.fn(async (input: { action: string }) => ({
      action: input.action,
      status: "completed" as const,
      ...(input.action === "screenshot" ? { result: {
        dataUrl: "data:image/png;base64,YWJj",
        mimeType: "image/png" as const,
        sourceId: "screen:0:0",
        sourceName: "Primary",
        displayId: "1",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        imageSize: { width: 1280, height: 720 },
        scaleFactor: 1,
      } } : {}),
    })),
  };
}

function fakeClient() {
  let extension: Record<string, unknown> | undefined;
  let credential = "";
  const policies = new Map<string, { enabled: boolean; approval: string }>();
  const tools = [
    "get_desktop_state",
    "get_screens",
    "list_native_applications",
    "launch_native_application",
    "list_media_players",
    "control_media_player",
    "open_media_uri",
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
    install: vi.fn(async (input: { id: string; version: string; namespace: string; source: string; transport: unknown; authType: string }, secretRef?: string) => {
      extension = { ...input, auth_type: input.authType, secret_ref: secretRef, credential_materialized: false, enabled: false };
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
    materializeCredential: vi.fn(async (_extensionId: string, value: string) => {
      credential = value;
      if (extension) extension = { ...extension, credential_materialized: true };
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
  return {
    client,
    policies,
    extension: () => extension,
    credential: () => credential,
    clearExtension: () => { extension = undefined; credential = ""; },
    seedExtension: (value: Record<string, unknown>) => { extension = { ...value }; },
  };
}

async function rpc(url: string, method: string, params: Record<string, unknown> = {}, id = 1, bearer = "") {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
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
      expect(gateway.client.install).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sourcenerve-desktop-control", authType: "bearer" }),
        "mcp-extension:sourcenerve-desktop-control:credential",
      );
      expect(gateway.policies.get("list_native_applications")).toEqual({ enabled: false, approval: "automatic" });
      expect(gateway.policies.get("launch_native_application")).toEqual({ enabled: false, approval: "automatic" });
      expect(gateway.policies.get("get_screenshot")).toEqual({ enabled: true, approval: "automatic" });
      expect(gateway.policies.get("set_clipboard_text")).toEqual({ enabled: true, approval: "automatic" });
      expect(gateway.policies.get("click_screen")).toEqual({ enabled: false, approval: "automatic" });
      expect(gateway.policies.get("type_text")).toEqual({ enabled: false, approval: "automatic" });
    } finally {
      await server.stop();
    }
  });

  it("replaces a stale first-party registration after Desktop restarts on a new loopback endpoint", async () => {
    const bridge = fakeBridge(state());
    const gateway = fakeClient();
    gateway.seedExtension({
      id: "sourcenerve-desktop-control",
      version: "0.1.32",
      namespace: "desktop-control",
      source: "builtin://sourcenerve/desktop-control",
      auth_type: "none",
      enabled: true,
      transport: { transport: "streamable-http", url: "http://127.0.0.1:44444/mcp" },
    });
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.32",
      reconcileIntervalMs: 0,
    });

    try {
      const url = await server.start();
      await server.reconcile();
      expect(gateway.client.disable).toHaveBeenCalledWith("sourcenerve-desktop-control");
      expect(gateway.client.remove).toHaveBeenCalledWith("sourcenerve-desktop-control");
      expect(gateway.extension()).toMatchObject({
        namespace: "desktop-control",
        source: "builtin://sourcenerve/desktop-control",
        auth_type: "bearer",
        credential_materialized: true,
        enabled: true,
        transport: { transport: "streamable-http", url },
      });
    } finally {
      await server.stop();
    }
  });

  it("re-registers the built-in backend after the gateway loses its registration", async () => {
    const bridge = fakeBridge(state());
    const gateway = fakeClient();
    const server = new DesktopControlMcpServer({
      bridge: bridge as unknown as DesktopControlBridge,
      client: gateway.client as unknown as McpExtensionClient,
      version: "0.1.32",
      reconcileIntervalMs: 0,
    });

    try {
      await server.start();
      await server.reconcile();
      const installedUrl = (gateway.extension()?.transport as { url?: string } | undefined)?.url;
      gateway.clearExtension();

      await server.reconcile();

      expect(gateway.extension()).toMatchObject({
        id: "sourcenerve-desktop-control",
        namespace: "desktop-control",
        enabled: true,
        transport: { transport: "streamable-http", url: installedUrl },
      });
      expect(gateway.client.install).toHaveBeenCalledTimes(2);
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
      await server.reconcile();
      const bearer = gateway.credential();
      expect(bearer).not.toBe("");
      const unauthorized = await rpc(url, "initialize", { protocolVersion: "2025-06-18" });
      expect(unauthorized.status).toBe(401);
      const unauthorizedDelete = await fetch(url, { method: "DELETE" });
      expect(unauthorizedDelete.status).toBe(401);
      const initialized = await rpc(url, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }, 1, bearer);
      expect(initialized.status).toBe(200);
      expect(initialized.json).toMatchObject({
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "sourcenerve-desktop-control", version: "0.1.31" },
        },
      });

      const listed = await rpc(url, "tools/list", {}, 1, bearer);
      const result = listed.json.result as { tools: Array<{ name: string }> };
      expect(result.tools.map((tool) => tool.name)).toContain("get_screenshot");
      expect(result.tools.map((tool) => tool.name)).toContain("click_screen");
      expect(result.tools.map((tool) => tool.name)).toContain("list_native_applications");
      expect(result.tools.map((tool) => tool.name)).toContain("launch_native_application");
      expect(result.tools.map((tool) => tool.name)).toContain("list_media_players");
      expect(result.tools.map((tool) => tool.name)).toContain("control_media_player");
      expect(result.tools.map((tool) => tool.name)).toContain("open_media_uri");

      const called = await rpc(url, "tools/call", { name: "get_screenshot", arguments: { displayId: "1" } }, 1, bearer);
      expect(called.json).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            action: "screenshot",
            status: "completed",
            result: {
              mimeType: "image/png",
              sourceId: "screen:0:0",
              displayId: "1",
              imageSize: { width: 1280, height: 720 },
            },
          },
        },
      });
      const screenshotResult = called.json.result as { content: Array<Record<string, unknown>> };
      expect(screenshotResult.content[0]).toEqual({ type: "image", data: "YWJj", mimeType: "image/png" });
      expect(bridge.run).toHaveBeenCalledWith({ action: "screenshot", displayId: "1" });

      const applications = await rpc(url, "tools/call", {
        name: "list_native_applications",
        arguments: { query: "spotify", maxApplications: 5 },
      }, 2, bearer);
      expect(applications.json).toMatchObject({
        result: {
          isError: false,
          structuredContent: {
            platform: "linux",
            applications: [{ id: "com.spotify.Client", name: "Spotify" }],
          },
        },
      });
      expect(bridge.listApplications).toHaveBeenCalledWith({ query: "spotify", maxApplications: 5 });

      const launched = await rpc(url, "tools/call", {
        name: "launch_native_application",
        arguments: { applicationId: "com.spotify.Client" },
      }, 3, bearer);
      expect(launched.json).toMatchObject({
        result: {
          isError: false,
          structuredContent: { application: { id: "com.spotify.Client", name: "Spotify" } },
        },
      });
      expect(bridge.launchApplication).toHaveBeenCalledWith("com.spotify.Client");

      const players = await rpc(url, "tools/call", { name: "list_media_players", arguments: {} }, 4, bearer);
      expect(players.json).toMatchObject({ result: { isError: false, structuredContent: { players: [{ id: "org.mpris.MediaPlayer2.spotify", name: "Spotify" }] } } });
      expect(bridge.listMediaPlayers).toHaveBeenCalled();

      const controlled = await rpc(url, "tools/call", {
        name: "control_media_player",
        arguments: { playerId: "org.mpris.MediaPlayer2.spotify", action: "play-pause" },
      }, 5, bearer);
      expect(controlled.json).toMatchObject({ result: { isError: false, structuredContent: { playerId: "org.mpris.MediaPlayer2.spotify", action: "play-pause" } } });
      expect(bridge.controlMediaPlayer).toHaveBeenCalledWith("org.mpris.MediaPlayer2.spotify", "play-pause");

      const opened = await rpc(url, "tools/call", {
        name: "open_media_uri",
        arguments: { playerId: "org.mpris.MediaPlayer2.spotify", uri: "spotify:track:123" },
      }, 6, bearer);
      expect(opened.json).toMatchObject({ result: { isError: false, structuredContent: { playerId: "org.mpris.MediaPlayer2.spotify", uri: "spotify:track:123" } } });
      expect(bridge.openMediaUri).toHaveBeenCalledWith("org.mpris.MediaPlayer2.spotify", "spotify:track:123");
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
