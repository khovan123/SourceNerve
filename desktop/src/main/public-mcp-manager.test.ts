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
});
