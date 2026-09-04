import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { ProductProfile } from "./runtime-profile";
import { WorkspaceGrantManager } from "./workspace-grant-manager";
import { WorkspaceManager } from "./workspace-manager";
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from "./workspace-store";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-reconcile-repo-"));
  temporaryDirectories.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "SourceNerve Test"]);
  await execFileAsync(process.execPath, ["-e", "require('fs').writeFileSync('README.md', '# demo\\n')"], { cwd: root });
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", "git@github.com:Fogewise-Tech/demo.git"]);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function bootstrap(userData: string, workspaceRegistryPath: string): DesktopBootstrapState {
  return {
    profile: productProfile(),
    paths: {
      userData,
      managedDirectory: path.dirname(workspaceRegistryPath),
      secureDirectory: path.join(userData, "secure"),
      stateDirectory: path.join(userData, "state"),
      configPath: path.join(path.dirname(workspaceRegistryPath), "sourcenerve.toml"),
      workspaceRegistryPath,
      productProfilePath: path.join(userData, "product-profile.json"),
    },
    secretStore: {
      get: vi.fn(async (key: string) => key === "localBearer" ? "L".repeat(48) : null),
    },
  } as unknown as DesktopBootstrapState;
}

function productProfile(): ProductProfile {
  return {
    schemaVersion: 1,
    product: {
      name: "SourceNerve",
      channel: "development",
      websiteUrl: "https://sourcenerve.example.test/",
      supportUrl: "https://sourcenerve.example.test/support",
      privacyUrl: "https://sourcenerve.example.test/privacy",
      termsUrl: "https://sourcenerve.example.test/terms",
    },
    daemon: {
      managed: true,
      bind: "127.0.0.1:7331",
      healthPath: "/healthz",
      readinessPath: "/readyz",
      mcpPath: "/mcp",
    },
    desktopBehavior: {
      allowBackgroundMode: false,
      allowLaunchAtLogin: false,
      allowNotifications: false,
    },
    auth0: {
      issuer: "https://auth.sourcenerve.example.test/",
      nativeClientId: "native-client-id",
      audience: "https://sourcenerve.example.test/mcp",
      scopes: ["openid", "profile", "offline_access", "sourcenerve:read"],
      callbackUri: "sourcenerve://oauth/callback",
      flow: "authorization_code_pkce",
    },
    gitProviders: {
      github: { cli: "gh", hostname: "github.com", apiBaseUrl: "https://api.github.com" },
      gitlab: { cli: "glab", hostname: "gitlab.com", apiBaseUrl: "https://gitlab.com/api/v4" },
    },
    publicMcp: {
      resource: "https://sourcenerve.example.test/mcp",
      protectedResourceMetadata: "https://sourcenerve.example.test/.well-known/oauth-protected-resource/mcp",
      routingMode: "bootstrap-broker",
      hostnameStrategy: "installation-scoped",
    },
    bootstrapBroker: {
      baseUrl: "https://broker.sourcenerve.example.test",
      clientConfigPath: "/v1/desktop/client-config",
      enrollPath: "/v1/desktop/enroll",
      rotateTunnelPath: "/v1/desktop/rotate",
      revokePath: "/v1/desktop/revoke",
      statusPath: "/v1/desktop/status",
    },
    cloudflare: {
      mode: "broker-managed",
      bundleCloudflared: true,
      desktopReceivesAccountApiToken: false,
      desktopReceivesInstallationCredential: true,
    },
    installation: {
      localBearerEntropyBits: 256,
      generateInstallationId: true,
      secureStoreRequired: true,
    },
    workspace: {
      userSelectsRepository: true,
      userSelectsLocalRoot: true,
      userSelectsAccessMode: true,
      deriveProviderMetadata: true,
    },
  };
}


afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Desktop workspace runtime reconciliation", () => {
  it("persists removal without independently restarting the daemon", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-reconcile-state-"));
    temporaryDirectories.push(userData);
    const managedDirectory = path.join(userData, "managed");
    await mkdir(managedDirectory, { recursive: true });
    const workspaceRegistryPath = path.join(managedDirectory, "workspaces.json");
    await saveWorkspaceRegistry(workspaceRegistryPath, [{
      id: "demo",
      name: "Demo",
      root: path.join(userData, "repo"),
      access: "read-write",
      remote: "origin",
      defaultBranch: "main",
    }]);

    const restart = vi.fn();
    const start = vi.fn();
    const stop = vi.fn();
    const daemon = {
      snapshot: () => ({ state: "ready", managed: true }),
      restart,
      start,
      stop,
    } as unknown as DaemonManager;
    const manager = new WorkspaceManager({
      bootstrap: bootstrap(userData, workspaceRegistryPath),
      daemon,
    });

    await expect(manager.removeWorkspace("demo")).resolves.toEqual({ removed: true });
    await expect(loadWorkspaceRegistry(workspaceRegistryPath)).resolves.toEqual([]);
    expect(restart).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("applies workspace grants and runtime with exactly one daemon restart", async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-grant-state-"));
    temporaryDirectories.push(userData);
    const managedDirectory = path.join(userData, "managed");
    await mkdir(managedDirectory, { recursive: true });
    const workspaceRegistryPath = path.join(managedDirectory, "workspaces.json");
    const appBootstrap = bootstrap(userData, workspaceRegistryPath);
    const view = {
      id: "demo",
      name: "Demo",
      root: path.join(userData, "repo"),
      access: "read-write" as const,
      remote: "origin",
      defaultBranch: "main",
      validation: { state: "ready" as const },
      head: "a".repeat(40),
      branch: "main",
      dirty: false,
      localWritable: true,
    };
    const workspaceManager = {
      listManagedWorkspaces: vi.fn(async () => [view]),
    } as unknown as WorkspaceManager;
    const configure = vi.fn();
    const restart = vi.fn(async () => ({ state: "ready" as const, managed: true }));
    const daemon = {
      snapshot: () => ({ state: "ready" as const, managed: true }),
      configure,
      restart,
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as DaemonManager;
    const manager = new WorkspaceGrantManager({
      bootstrap: appBootstrap,
      daemonManager: daemon,
      workspaceManager,
    });

    await manager.initialize();
    await manager.workspaceChanged({ subject: "auth0|e2e" } as never);

    expect(restart).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(1);
    const config = await readFile(appBootstrap.paths.configPath, "utf8");
    expect(config.match(/\[\[workspace\]\]/g)).toHaveLength(1);
    expect(config.match(/\[\[oauth\.grant\]\]/g)).toHaveLength(1);
    expect(config).toContain('workspace = "demo"');
    expect(config).toContain('subject = "auth0|e2e"');
  });


  it("keeps daemon materialization owned by the grant reconciler only", async () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const [workspaceSource, grantSource] = await Promise.all([
      readFile(path.join(directory, "workspace-manager.ts"), "utf8"),
      readFile(path.join(directory, "workspace-grant-manager.ts"), "utf8"),
    ]);

    expect(workspaceSource).not.toContain("materializeRuntime(");
    expect(workspaceSource).not.toContain("this.daemon.restart(");
    expect(grantSource).toContain("materializeRuntime(");
    expect(grantSource).toContain("this.daemonManager.restart()");
  });
});
