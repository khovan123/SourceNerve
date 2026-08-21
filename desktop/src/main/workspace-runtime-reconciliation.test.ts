import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { OperationRegistry } from "./ipc";
import type { SourceNerveClient } from "./sourcenerve-client";
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
    paths: {
      userData,
      managedDirectory: path.dirname(workspaceRegistryPath),
      secureDirectory: path.join(userData, "secure"),
      stateDirectory: path.join(userData, "state"),
      configPath: path.join(path.dirname(workspaceRegistryPath), "sourcenerve.toml"),
      workspaceRegistryPath,
      productProfilePath: path.join(userData, "product-profile.json"),
    },
  } as unknown as DesktopBootstrapState;
}

function operations(): OperationRegistry {
  const active = new Map<string, AbortController>();
  return {
    start(operationId: string) {
      if (active.has(operationId)) throw new Error("already active");
      const controller = new AbortController();
      active.set(operationId, controller);
      return controller.signal;
    },
    finish(operationId: string) {
      active.delete(operationId);
    },
    cancel(operationId: string) {
      const controller = active.get(operationId);
      if (!controller) return false;
      controller.abort();
      active.delete(operationId);
      return true;
    },
  } as unknown as OperationRegistry;
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
      client: {} as SourceNerveClient,
      operations: operations(),
      onEvent: vi.fn(),
    });

    await expect(manager.removeWorkspace("demo")).resolves.toEqual({ removed: true });
    await expect(loadWorkspaceRegistry(workspaceRegistryPath)).resolves.toEqual([]);
    expect(restart).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("waits for a managed daemon transition before starting an index request", async () => {
    const repositoryRoot = await createRepository();
    const userData = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-runtime-index-state-"));
    temporaryDirectories.push(userData);
    const managedDirectory = path.join(userData, "managed");
    await mkdir(managedDirectory, { recursive: true });
    const workspaceRegistryPath = path.join(managedDirectory, "workspaces.json");
    await saveWorkspaceRegistry(workspaceRegistryPath, [{
      id: "demo",
      name: "Demo",
      root: repositoryRoot,
      access: "read-write",
      remote: "origin",
      defaultBranch: "main",
      provider: "github",
      repository: "Fogewise-Tech/demo",
    }]);

    let state: "starting" | "ready" = "starting";
    const daemon = {
      snapshot: () => ({ state, managed: true }),
    } as unknown as DaemonManager;
    const indexResult = {
      workspace: "demo",
      head: "a".repeat(40),
      discoveredFiles: 1,
      indexedTextFiles: 1,
      graph: {
        parsedFiles: 1,
        partialFiles: 0,
        failedFiles: 0,
        symbols: 1,
        edges: 0,
        unresolvedReferences: 0,
      },
    };
    const indexWorkspace = vi.fn(async () => indexResult);
    const client = {
      listWorkspaces: vi.fn(async () => [{ id: "demo", name: "Demo", writable: true }]),
      indexWorkspace,
    } as unknown as SourceNerveClient;
    const manager = new WorkspaceManager({
      bootstrap: bootstrap(userData, workspaceRegistryPath),
      daemon,
      client,
      operations: operations(),
      onEvent: vi.fn(),
    });

    const pending = manager.indexWorkspace("demo");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(indexWorkspace).not.toHaveBeenCalled();
    state = "ready";

    await expect(pending).resolves.toEqual(indexResult);
    expect(indexWorkspace).toHaveBeenCalledTimes(1);
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
