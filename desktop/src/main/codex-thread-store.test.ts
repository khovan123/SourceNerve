import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexThreadStore } from "./codex-thread-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexThreadStore", () => {
  it("persists only the Harness run to native Codex thread binding", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "codex-threads.json");
    const cwd = path.join(directory, "workspace");
    const first = new CodexThreadStore(filePath, () => new Date("2026-09-05T00:00:00Z"));
    await first.initialize();
    await first.bind({ runId: "run-1", workspaceId: "repo-1", cwd, threadId: "thread-1" });
    await first.flush();

    const second = new CodexThreadStore(filePath, () => new Date("2026-09-05T00:01:00Z"));
    await second.initialize();
    expect(second.get("run-1")).toEqual({
      runId: "run-1",
      workspaceId: "repo-1",
      cwd: path.resolve(cwd),
      threadId: "thread-1",
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
  });

  it("moves a native Codex thread binding to the fresh Harness run used for resume", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "codex-threads.json");
    const cwd = path.join(directory, "workspace");
    const store = new CodexThreadStore(filePath, () => new Date("2026-09-05T00:01:00Z"));
    await store.initialize();
    await store.bind({ runId: "run-old", workspaceId: "repo-1", cwd, threadId: "thread-native" });

    await expect(store.rebind({ runId: "run-fresh", workspaceId: "repo-1", cwd, threadId: "thread-native" })).resolves.toMatchObject({
      runId: "run-fresh",
      workspaceId: "repo-1",
      threadId: "thread-native",
    });
    expect(store.get("run-old")).toBeNull();
    expect(store.get("run-fresh")?.threadId).toBe("thread-native");
    await store.flush();

    const reloaded = new CodexThreadStore(filePath);
    await reloaded.initialize();
    expect(reloaded.get("run-old")).toBeNull();
    expect(reloaded.get("run-fresh")?.threadId).toBe("thread-native");
  });

  it("removes every native thread binding for one workspace without touching others", async () => {
    const directory = await tempDirectory();
    const store = new CodexThreadStore(path.join(directory, "codex-threads.json"));
    await store.initialize();
    await store.bind({ runId: "run-a1", workspaceId: "repo-a", cwd: path.join(directory, "a"), threadId: "thread-a1" });
    await store.bind({ runId: "run-a2", workspaceId: "repo-a", cwd: path.join(directory, "a"), threadId: "thread-a2" });
    await store.bind({ runId: "run-b", workspaceId: "repo-b", cwd: path.join(directory, "b"), threadId: "thread-b" });

    await expect(store.removeWorkspace("repo-a")).resolves.toEqual(["run-a1", "run-a2"]);
    expect(store.get("run-a1")).toBeNull();
    expect(store.get("run-a2")).toBeNull();
    expect(store.get("run-b")?.workspaceId).toBe("repo-b");
  });

  it("rejects rebinding one Harness run to another workspace or Codex thread", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "codex-threads.json");
    const store = new CodexThreadStore(filePath);
    await store.initialize();
    await store.bind({ runId: "run-1", workspaceId: "repo-1", cwd: path.join(directory, "one"), threadId: "thread-1" });

    await expect(store.bind({ runId: "run-1", workspaceId: "repo-2", cwd: path.join(directory, "two"), threadId: "thread-1" })).rejects.toThrow("different workspace");
    await expect(store.bind({ runId: "run-1", workspaceId: "repo-1", cwd: path.join(directory, "one"), threadId: "thread-2" })).rejects.toThrow("different Codex thread");
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
