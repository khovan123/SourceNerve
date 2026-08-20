import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Auth0Manager } from "./auth0-manager";
import type { DesktopBootstrapState } from "./bootstrap";
import type { CloudflaredManager } from "./cloudflared-manager";
import { PublicMcpManager } from "./public-mcp-manager";
import type { DesktopRuntimeEvent, PublicMcpView } from "../shared/desktop-api";

describe("PublicMcpManager auth boundary", () => {
  it("derives Offline immediately and stops the local connector once without revoking route state", async () => {
    let authStatus: "authenticated" | "expired" = "authenticated";
    const deleteSecret = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const events: DesktopRuntimeEvent[] = [];

    const bootstrap = {
      paths: { managedDirectory: "/tmp/sourcenerve-public-mcp-test" },
      profile: {
        bootstrapBroker: {
          baseUrl: "https://bootstrap.example.test",
          enrollPath: "/v1/desktop/enroll",
          rotateTunnelPath: "/v1/desktop/tunnel/rotate",
          revokePath: "/v1/desktop/revoke",
          statusPath: "/v1/desktop/bootstrap-status",
        },
      },
      installation: { installationId: "installation-1" },
      secretStore: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: deleteSecret,
      },
    } as unknown as DesktopBootstrapState;

    const auth0 = {
      state: () => ({ status: authStatus }),
    } as unknown as Auth0Manager;

    const cloudflared = {
      stop,
      snapshot: () => ({ state: "running" }),
    } as unknown as CloudflaredManager;

    const manager = new PublicMcpManager({
      bootstrap,
      auth0,
      cloudflared,
      onEvent: (event) => events.push(event),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    const internals = manager as unknown as {
      metadata: {
        version: 1;
        installationId: string;
        hostname: string;
        tunnelId: string;
        status: "active";
        updatedAt: string;
      };
      current: PublicMcpView;
    };
    internals.metadata = {
      version: 1,
      installationId: "installation-1",
      hostname: "install-1.example.test",
      tunnelId: "tunnel-1",
      status: "active",
      updatedAt: new Date(0).toISOString(),
    };
    internals.current = {
      state: "ready",
      tunnelRunning: true,
      hostname: "install-1.example.test",
      publicMcpUrl: "https://install-1.example.test/mcp",
      message: "Public MCP is ready",
    };

    authStatus = "expired";
    const immediate = manager.state();
    expect(immediate).toMatchObject({
      state: "offline",
      tunnelRunning: false,
      hostname: "install-1.example.test",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(manager.state()).toMatchObject({
      state: "offline",
      tunnelRunning: false,
      hostname: "install-1.example.test",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "state",
      component: "public-mcp",
      state: "offline",
    }));
  });

  it("stores a rotated tunnel credential before restarting cloudflared", async () => {
    const managedDirectory = await mkdtemp(path.join(tmpdir(), "sourcenerve-public-mcp-"));
    const sequence: string[] = [];
    const newToken = `rotated-${"x".repeat(48)}`;
    try {
      const secretStore = {
        get: vi.fn(async () => null),
        set: vi.fn(async (name: string, value: string) => {
          expect(name).toBe("cloudflareTunnelToken");
          expect(value).toBe(newToken);
          sequence.push("store");
        }),
        delete: vi.fn(async () => undefined),
      };
      const bootstrap = {
        paths: { managedDirectory },
        profile: {
          bootstrapBroker: {
            baseUrl: "https://bootstrap.example.test",
            enrollPath: "/v1/desktop/enroll",
            rotateTunnelPath: "/v1/desktop/tunnel/rotate",
            revokePath: "/v1/desktop/revoke",
            statusPath: "/v1/desktop/bootstrap-status",
          },
          publicMcp: {
            resource: "https://sourcenerve.example.test/mcp",
            protectedResourceMetadata: "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp",
          },
          daemon: { mcpPath: "/mcp" },
        },
        installation: { installationId: "installation-1" },
        secretStore,
      } as unknown as DesktopBootstrapState;
      const auth0 = {
        state: () => ({ status: "authenticated" }),
        getAccessToken: vi.fn(async () => "auth0-token-for-public-check"),
      } as unknown as Auth0Manager;
      const cloudflared = {
        restart: vi.fn(async (token: string) => {
          expect(token).toBe(newToken);
          sequence.push("restart");
        }),
        snapshot: () => ({ state: "running" }),
      } as unknown as CloudflaredManager;

      const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/healthz") return jsonResponse({ status: "ok" });
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return jsonResponse({ resource: "https://sourcenerve.example.test/mcp" });
        }
        if (url.pathname !== "/mcp") return jsonResponse({}, 404);
        const authorization = new Headers(init?.headers).get("authorization");
        if (!authorization) {
          return new Response("", {
            status: 401,
            headers: {
              "www-authenticate": "Bearer resource_metadata=\"https://install-1.example.test/.well-known/oauth-protected-resource/mcp\"",
            },
          });
        }
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { method?: string } : {};
        if (body.method === "initialize") {
          return jsonResponse(
            { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
            200,
            { "mcp-session-id": "session-1" },
          );
        }
        if (body.method === "tools/list") {
          return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }] } });
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;

      const manager = new PublicMcpManager({
        bootstrap,
        auth0,
        cloudflared,
        onEvent: () => undefined,
        fetchImpl,
        delayImpl: async () => undefined,
      });
      const internals = manager as unknown as {
        broker: { rotate(): Promise<{ installationId: string; hostname: string; tunnelId: string; tunnelToken: string; status: "active" }> };
        metadata: {
          version: 1;
          installationId: string;
          hostname: string;
          tunnelId: string;
          status: "active";
          updatedAt: string;
        };
        current: PublicMcpView;
      };
      internals.broker = {
        async rotate() {
          sequence.push("broker");
          return {
            installationId: "installation-1",
            hostname: "install-1.example.test",
            tunnelId: "tunnel-rotated",
            tunnelToken: newToken,
            status: "active",
          };
        },
      };
      internals.metadata = {
        version: 1,
        installationId: "installation-1",
        hostname: "install-1.example.test",
        tunnelId: "tunnel-old",
        status: "active",
        updatedAt: new Date(0).toISOString(),
      };
      internals.current = {
        state: "ready",
        tunnelRunning: true,
        hostname: "install-1.example.test",
        publicMcpUrl: "https://install-1.example.test/mcp",
      };

      const result = await manager.rotateTunnelCredential();

      expect(result.state).toBe("ready");
      expect(sequence.slice(0, 3)).toEqual(["broker", "store", "restart"]);
      expect(secretStore.set).toHaveBeenCalledTimes(1);
      expect(cloudflared.restart).toHaveBeenCalledTimes(1);
    } finally {
      await rm(managedDirectory, { recursive: true, force: true });
    }
  });
});

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
