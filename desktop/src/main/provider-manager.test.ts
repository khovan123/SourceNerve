import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import { ProviderManager } from "./provider-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProviderManager", () => {
  it("handles RFC device authorization pending on HTTP 400 and stores only the final token securely", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const secrets = new Map<string, string>();
    const opened: string[] = [];
    const requests: string[] = [];
    let tokenPolls = 0;

    const bootstrap = {
      profile: {
        gitProviders: {
          github: {
            clientId: "github-desktop-client",
            flow: "device_authorization",
            deviceCodeUrl: "https://github.com/login/device/code",
            tokenUrl: "https://github.com/login/oauth/access_token",
            apiBaseUrl: "https://api.github.com",
            verificationOrigin: "https://github.com",
            scopes: ["repo", "read:user"],
          },
          gitlab: {
            clientId: "gitlab-desktop-client",
            flow: "device_authorization",
            deviceCodeUrl: "https://gitlab.com/oauth/authorize_device",
            tokenUrl: "https://gitlab.com/oauth/token",
            apiBaseUrl: "https://gitlab.com/api/v4",
            verificationOrigin: "https://gitlab.com",
            scopes: ["api"],
          },
        },
      },
      paths: { managedDirectory: directory },
      secretStore: {
        async get(name: string) { return secrets.get(name) ?? null; },
        async set(name: string, value: string) { secrets.set(name, value); },
        async delete(name: string) { secrets.delete(name); },
      },
    } as unknown as DesktopBootstrapState;

    const manager = new ProviderManager({
      bootstrap,
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      openExternal: async (url) => { opened.push(url); },
      delayImpl: async () => undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://github.com/login/device/code") {
          expect(String(init?.body)).not.toContain("client_secret");
          return json({
            device_code: "device-code-123",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          });
        }
        if (url === "https://github.com/login/oauth/access_token") {
          tokenPolls += 1;
          if (tokenPolls === 1) return json({ error: "authorization_pending" }, 400);
          return json({ access_token: "provider-token-" + "T".repeat(48), token_type: "bearer" });
        }
        if (url === "https://api.github.com/user") {
          expect((init?.headers as Record<string, string>).authorization).toContain("provider-token-");
          return json({ id: 123, login: "desktop-user", name: "Desktop User" });
        }
        throw new Error(`unexpected provider test request: ${url}`);
      },
    });

    const started = await manager.connect("github");
    expect(started.status).toBe("awaiting-user");
    expect(started.deviceLogin?.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(started)).not.toContain("device-code-123");
    expect(opened).toEqual(["https://github.com/login/device"]);

    await waitFor(() => manager.state("github").status === "connected");
    await waitForFile(path.join(directory, "provider-sessions.json"));
    const state = manager.state("github");
    expect(state.status).toBe("connected");
    expect(state.login).toBe("desktop-user");
    expect(JSON.stringify(state)).not.toContain("provider-token-");
    expect(secrets.get("githubToken")).toMatch(/^provider-token-/);
    expect(tokenPolls).toBe(2);
    expect(requests).toContain("https://api.github.com/user");

    const metadata = await readFile(path.join(directory, "provider-sessions.json"), "utf8");
    expect(metadata).toContain("desktop-user");
    expect(metadata).not.toContain("provider-token-");
    expect(metadata).not.toContain("device-code-123");
  });

  it("rejects a provider verification URL that escapes the configured origin", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-provider-"));
    temporaryDirectories.push(directory);
    const bootstrap = {
      profile: {
        gitProviders: {
          github: {
            clientId: "github-desktop-client",
            flow: "device_authorization",
            deviceCodeUrl: "https://github.com/login/device/code",
            tokenUrl: "https://github.com/login/oauth/access_token",
            apiBaseUrl: "https://api.github.com",
            verificationOrigin: "https://github.com",
            scopes: ["repo"],
          },
          gitlab: {
            clientId: "gitlab-desktop-client",
            flow: "device_authorization",
            deviceCodeUrl: "https://gitlab.com/oauth/authorize_device",
            tokenUrl: "https://gitlab.com/oauth/token",
            apiBaseUrl: "https://gitlab.com/api/v4",
            verificationOrigin: "https://gitlab.com",
            scopes: ["api"],
          },
        },
      },
      paths: { managedDirectory: directory },
      secretStore: { async get() { return null; }, async set() {}, async delete() {} },
    } as unknown as DesktopBootstrapState;

    const manager = new ProviderManager({
      bootstrap,
      workspaceManager: { listManagedWorkspaces: async () => [] } as never,
      openExternal: async () => undefined,
      fetchImpl: async () => json({
        device_code: "device-code-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://evil.example.test/device",
        expires_in: 900,
        interval: 5,
      }),
    });

    await expect(manager.connect("github")).rejects.toThrow(/escaped the configured origin/);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("provider test did not reach expected state");
}

async function waitForFile(filePath: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("provider metadata was not persisted");
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
