import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { OperationRegistry } from "./ipc";
import type { SourceNerveClient } from "./sourcenerve-client";
import { WorkspaceManager } from "./workspace-manager";
import { saveWorkspaceRegistry } from "./workspace-store";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-index-single-flight-repo-"));
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Desktop workspace index single-flight", () => {
  it("joins concurrent callers for the same workspace and starts one daemon index request", async () => {
    const repositoryRoot = await createRepository();
    const userData = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-index-single-flight-state-"));
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

    let releaseIndex!: () => void;
    const indexGate = new Promise<void>((resolve) => { releaseIndex = resolve; });
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
    const indexWorkspace = vi.fn(async () => {
      await indexGate;
      return indexResult;
    });

    const client = {
      listWorkspaces: vi.fn(async () => [{ id: "demo", name: "Demo", writable: true }]),
      indexWorkspace,
    } as unknown as SourceNerveClient;
    const daemon = {
      snapshot: () => ({ state: "ready", managed: true }),
    } as unknown as DaemonManager;

    const activeOperations = new Map<string, AbortController>();
    const operations = {
      start(operationId: string) {
        if (activeOperations.has(operationId)) throw new Error("already active");
        const controller = new AbortController();
        activeOperations.set(operationId, controller);
        return controller.signal;
      },
      finish(operationId: string) {
        activeOperations.delete(operationId);
      },
      cancel(operationId: string) {
        const controller = activeOperations.get(operationId);
        if (!controller) return false;
        controller.abort();
        activeOperations.delete(operationId);
        return true;
      },
    } as unknown as OperationRegistry;

    const events = vi.fn();
    const onWorkspaceIndexed = vi.fn(async () => undefined);
    const bootstrap = {
      paths: {
        userData,
        managedDirectory,
        secureDirectory: path.join(userData, "secure"),
        stateDirectory: path.join(userData, "state"),
        configPath: path.join(managedDirectory, "sourcenerve.toml"),
        workspaceRegistryPath,
        productProfilePath: path.join(userData, "product-profile.json"),
      },
    } as unknown as DesktopBootstrapState;

    const manager = new WorkspaceManager({
      bootstrap,
      daemon,
      client,
      operations,
      onEvent: events,
      onWorkspaceIndexed,
    });

    const first = manager.indexWorkspace("demo");
    const second = manager.indexWorkspace("demo");

    expect(second).toBe(first);
    await vi.waitFor(() => expect(indexWorkspace).toHaveBeenCalledTimes(1));
    expect(activeOperations.size).toBe(1);

    releaseIndex();
    await expect(Promise.all([first, second])).resolves.toEqual([indexResult, indexResult]);
    expect(indexWorkspace).toHaveBeenCalledTimes(1);
    expect(activeOperations.size).toBe(0);
    expect(events.mock.calls.filter(([event]) => event.type === "progress" && event.stage === "index-started")).toHaveLength(1);
    expect(events.mock.calls.filter(([event]) => event.type === "state" && event.state === "indexed")).toHaveLength(1);
    expect(onWorkspaceIndexed).toHaveBeenCalledTimes(1);
    expect(onWorkspaceIndexed).toHaveBeenLastCalledWith("demo");

    await expect(manager.indexWorkspace("demo")).resolves.toEqual(indexResult);
    expect(indexWorkspace).toHaveBeenCalledTimes(2);
    expect(onWorkspaceIndexed).toHaveBeenCalledTimes(2);
  });
});
