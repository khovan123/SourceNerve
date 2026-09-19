import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { CloudflaredManager } from "./cloudflared-manager";
import { PublicMcpManager } from "./public-mcp-manager";
import type { PublicMcpView } from "../shared/desktop-api";

describe("PublicMcpManager No Auth", () => {
  it("stores a rotated tunnel credential and verifies MCP without Authorization", async () => {
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
          daemon: { mcpPath: "/mcp" },
        },
        installation: { installationId: "installation-1" },
        secretStore,
      } as unknown as DesktopBootstrapState;
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
        if (url.pathname !== "/mcp") return jsonResponse({}, 404);
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as { method?: string; params?: { name?: string } }
          : {};
        if (body.method === "initialize") {
          return jsonResponse(
            { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
            200,
            { "mcp-session-id": "session-1" },
          );
        }
        if (body.method === "tools/list") {
          return jsonResponse({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "workspace_list" }] } });
        }
        if (body.method === "tools/call" && body.params?.name === "workspace_list") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 3,
            result: {
              content: [{ type: "text", text: JSON.stringify([{ id: "repo-a", name: "Repo A", writable: true }]) }],
              structuredContent: [{ id: "repo-a", name: "Repo A", writable: true }],
              isError: false,
            },
          });
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;

      const manager = new PublicMcpManager({
        bootstrap,
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
      expect(result.message).toBe("Public MCP is ready");
      expect(sequence.slice(0, 3)).toEqual(["broker", "store", "restart"]);
      expect(fetchImpl).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          body: expect.stringContaining('"name":"workspace_list"'),
        }),
      );
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
