import { describe, expect, it } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import { BootstrapBrokerClient } from "./bootstrap-broker-client";

describe("BootstrapBrokerClient", () => {
  it("uses the Auth0 access token only as an outbound broker credential", async () => {
    const requests: Array<{ url: string; authorization: string | null; body?: string }> = [];
    const bootstrap = bootstrapFixture();
    const client = new BootstrapBrokerClient({
      bootstrap,
      auth0: {
        async getAccessToken() {
          return "auth0-access-token-that-must-not-cross-renderer";
        },
      } as never,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({
          url,
          authorization: headers.get("authorization"),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return json({
          installationId: bootstrap.installation.installationId,
          hostname: "install-demo.desktop.example.test",
          tunnelId: "tunnel_12345678",
          tunnelToken: "cloudflare-tunnel-token-" + "x".repeat(48),
          status: "active",
        });
      },
    });

    const result = await client.enroll();
    expect(result.hostname).toBe("install-demo.desktop.example.test");
    expect(result.tunnelToken).toMatch(/^cloudflare-tunnel-token-/);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://bootstrap.example.test/v1/desktop/enroll");
    expect(requests[0].authorization).toBe(
      "Bearer auth0-access-token-that-must-not-cross-renderer",
    );
    expect(requests[0].body).toContain(bootstrap.installation.installationId);
    expect(requests[0].body).not.toContain("auth0-access-token");
  });

  it("parses broker status without accepting or returning a tunnel credential", async () => {
    const bootstrap = bootstrapFixture();
    const client = new BootstrapBrokerClient({
      bootstrap,
      auth0: { async getAccessToken() { return "auth0-access-token-for-status"; } } as never,
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v1/desktop/bootstrap-status");
        expect(url.searchParams.get("installationId")).toBe(
          bootstrap.installation.installationId,
        );
        return json({
          installationId: bootstrap.installation.installationId,
          hostname: "install-demo.desktop.example.test",
          tunnelId: "tunnel_12345678",
          tunnelToken: "must-be-ignored",
          status: "active",
          updatedAt: "2026-08-19T14:00:00Z",
        });
      },
    });

    const result = await client.status();
    expect(result.status).toBe("active");
    expect(JSON.stringify(result)).not.toContain("must-be-ignored");
    expect(result).not.toHaveProperty("tunnelToken");
  });
});

function bootstrapFixture(): DesktopBootstrapState {
  return {
    profile: {
      bootstrapBroker: {
        baseUrl: "https://bootstrap.example.test",
        enrollPath: "/v1/desktop/enroll",
        rotateTunnelPath: "/v1/desktop/tunnel/rotate",
        revokePath: "/v1/desktop/revoke",
        statusPath: "/v1/desktop/bootstrap-status",
      },
    },
    installation: {
      installationId: "install_1234567890abcdef",
      localBearer: "L".repeat(43),
    },
  } as unknown as DesktopBootstrapState;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
