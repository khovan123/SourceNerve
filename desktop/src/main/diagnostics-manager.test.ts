import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import { buildSingleFileZip, DiagnosticsManager } from "./diagnostics-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DiagnosticsManager", () => {
  it("previews the exact sanitized support bundle and never includes raw secrets or workspace roots", async () => {
    const directory = await tempDirectory();
    const home = process.env.HOME || process.env.USERPROFILE || directory;
    const localBearer = "local-bearer-secret-12345678901234567890";
    const githubToken = "github-provider-secret-1234567890";
    const gitlabToken = "gitlab-provider-secret-1234567890";
    const bootstrap = fakeBootstrap(directory, home, { localBearer, githubToken, gitlabToken });
    const manager = new DiagnosticsManager({
      bootstrap,
      runtimeInfo: () => ({ desktopVersion: "0.1.0", platform: process.platform, arch: process.arch }),
      packaged: false,
      daemon: () => ({ snapshot: () => ({ state: "ready", managed: true, version: "0.1.0" }) }) as never,
      client: () => ({
        health: async () => ({ status: "ok" as const }),
        serviceStatus: async () => ({ identity: { version: "0.1.0" } }),
        readiness: async () => ({ ready: true }),
      }) as never,
      workspaceManager: () => ({
        listManagedWorkspaces: async () => [{
          id: "private-api",
          name: "Private API",
          root: path.join(home, "secret-repository-root"),
          access: "read-write" as const,
          remote: "origin",
          defaultBranch: "main",
          validation: { state: "ready" as const },
          branch: "main",
          head: "a".repeat(40),
          dirty: false,
        }],
      }) as never,
      auth0Manager: () => ({ state: () => ({ status: "authenticated", scopes: ["sourcenerve:read"] }) }) as never,
      providerManager: () => ({ states: () => [{ provider: "github", status: "connected" }] }) as never,
      publicMcpManager: () => ({ state: () => ({ state: "ready", tunnelRunning: true, hostname: "installation-secret.example.com" }) }) as never,
      runtimeLogStore: () => ({
        snapshot: () => ({
          entries: [{
            sequence: 1,
            timestamp: "2026-08-20T00:00:00.000Z",
            component: "daemon",
            level: "error",
            message: `Authorization: Bearer ${localBearer} token=${githubToken} ${home}/secret-repository-root`,
          }],
          droppedEntries: 0,
          maxEntries: 1000,
          maxBytes: 512 * 1024,
        }),
      }) as never,
      desktopPreferences: () => null,
      crashMarkerStore: () => ({ snapshot: () => ({ previousMainExit: { clean: false, startedAt: "2026-08-19T23:59:00.000Z" } }) }) as never,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    await manager.initialize();

    const preview = await manager.previewSupportBundle();
    expect(preview.text).toContain('"localBearer": "configured"');
    expect(preview.text).toContain('"githubCredential": "configured"');
    expect(preview.text).toContain('"previousMainExit"');
    expect(preview.text).not.toContain(localBearer);
    expect(preview.text).not.toContain(githubToken);
    expect(preview.text).not.toContain(gitlabToken);
    expect(preview.text).not.toContain("installation-secret.example.com");
    expect(preview.text).not.toContain(path.join(home, "secret-repository-root"));
    expect(preview.text).not.toContain("Authorization: Bearer local-bearer");

    const textExport = manager.exportBytes(preview.selectionId, "text");
    expect(textExport.bytes.toString("utf8")).toBe(preview.text);
    const zipExport = manager.exportBytes(preview.selectionId, "zip");
    expect(zipExport.bytes.subarray(0, 4).toString("binary")).toBe("PK\u0003\u0004");
    expect(zipExport.bytes.includes(Buffer.from("support-bundle.txt", "utf8"))).toBe(true);
    expect(zipExport.bytes.includes(Buffer.from(preview.text, "utf8"))).toBe(true);
  });

  it("builds a deterministic single-file ZIP envelope around the provided bytes", () => {
    const content = Buffer.from("safe-support-text\n", "utf8");
    const zip = buildSingleFileZip("support-bundle.txt", content, new Date("2026-08-20T00:00:00Z"));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from("support-bundle.txt"))).toBe(true);
    expect(zip.includes(content)).toBe(true);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});

function fakeBootstrap(
  directory: string,
  home: string,
  secrets: Record<string, string>,
): DesktopBootstrapState {
  return {
    paths: {
      userData: directory,
      managedDirectory: path.join(directory, "managed"),
      secureDirectory: path.join(directory, "secure"),
      stateDirectory: path.join(home, "state"),
      configPath: path.join(directory, "managed", "sourcenerve.toml"),
      workspaceRegistryPath: path.join(directory, "managed", "workspaces.json"),
      installationPath: path.join(directory, "managed", "installation.json"),
      profilePath: path.join(directory, "profile.json"),
    },
    profile: {
      schemaVersion: 1,
      product: {
        name: "SourceNerve",
        channel: "development",
        websiteUrl: "https://example.com",
        supportUrl: "https://example.com/support",
        privacyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
      },
      daemon: { managed: true, bind: "127.0.0.1:7331", healthPath: "/healthz", readinessPath: "/readyz", mcpPath: "/mcp" },
      desktopBehavior: { allowBackgroundMode: true, allowLaunchAtLogin: true, allowNotifications: true },
      auth0: { issuer: "https://auth.example.com/", nativeClientId: "client", audience: "https://mcp.example.com/mcp", scopes: ["sourcenerve:read"], callbackUri: "sourcenerve://oauth/callback", flow: "authorization_code_pkce" },
      gitProviders: {
        github: { clientId: "github-client", flow: "device_authorization", deviceCodeUrl: "https://github.com/login/device/code", tokenUrl: "https://github.com/login/oauth/access_token", apiBaseUrl: "https://api.github.com", verificationOrigin: "https://github.com", scopes: ["repo"] },
        gitlab: { clientId: "gitlab-client", flow: "device_authorization", deviceCodeUrl: "https://gitlab.com/oauth/authorize_device", tokenUrl: "https://gitlab.com/oauth/token", apiBaseUrl: "https://gitlab.com/api/v4", verificationOrigin: "https://gitlab.com", scopes: ["api"] },
      },
      publicMcp: { resource: "https://mcp.example.com/mcp", protectedResourceMetadata: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp", routingMode: "bootstrap-broker", hostnameStrategy: "installation-scoped" },
      bootstrapBroker: { baseUrl: "https://broker.example.com", enrollPath: "/enroll", rotateTunnelPath: "/rotate", revokePath: "/revoke", statusPath: "/status" },
      cloudflare: { mode: "broker-managed", bundleCloudflared: true, desktopReceivesAccountApiToken: false, desktopReceivesInstallationCredential: true },
      installation: { localBearerEntropyBits: 256, generateInstallationId: true, secureStoreRequired: true },
      workspace: { userSelectsRepository: true, userSelectsLocalRoot: true, userSelectsAccessMode: true, deriveProviderMetadata: true },
    },
    storageBackend: "test",
    secretStore: {
      get: async (key: string) => secrets[key] ?? null,
      set: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as DesktopBootstrapState;
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}
