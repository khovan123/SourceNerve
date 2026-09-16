import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationActivityStore } from "./conversation-activity-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ConversationActivityStore", () => {
  it("persists streaming activity with a stable chronological position across reload", async () => {
    const filePath = path.join(await tempDirectory(), "conversation-activity.json");
    const store = new ConversationActivityStore(filePath);
    await store.initialize();

    const started = store.record({
      type: "codex-progress",
      runId: "run-1",
      workspace: "repo-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      kind: "command",
      stage: "started",
      label: "Ran command",
      command: "npm test",
      createdAt: Date.parse("2026-09-16T07:00:00Z"),
    })[0];
    const streamed = store.record({
      type: "codex-progress",
      runId: "run-1",
      workspace: "repo-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      kind: "command",
      stage: "streaming",
      label: "Ran command",
      output: "one\n",
      createdAt: Date.parse("2026-09-16T07:00:01Z"),
    })[0];
    const completed = store.record({
      type: "codex-progress",
      runId: "run-1",
      workspace: "repo-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      kind: "command",
      stage: "completed",
      label: "Ran command",
      output: "one\ntwo\n",
      exitCode: 0,
      durationMs: 1250,
      createdAt: Date.parse("2026-09-16T07:00:02Z"),
    })[0];

    expect(started).toMatchObject({ type: "codex-progress", position: 1 });
    expect(streamed).toMatchObject({ type: "codex-progress", position: 1 });
    expect(completed).toMatchObject({ type: "codex-progress", position: 1 });
    expect(store.list({ workspace: "repo-1", runId: "run-1" })).toMatchObject([{
      id: expect.any(String),
      position: 1,
      stage: "completed",
      command: "npm test",
      output: "one\ntwo\n",
      exitCode: 0,
      durationMs: 1250,
    }]);
    expect(store.listEvents({ workspace: "repo-1", runId: "run-1" }).map((event) => event.type)).toEqual([
      "command_started",
      "command_output_delta",
      "command_finished",
    ]);

    await store.flush();
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { version: number; events: Array<{ type: string; sequence: number }> };
    expect(persisted.version).toBe(2);
    expect(persisted.events.map((event) => event.type)).toEqual([
      "command_started",
      "command_output_delta",
      "command_finished",
    ]);
    expect(persisted.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    const reloaded = new ConversationActivityStore(filePath);
    await reloaded.initialize();
    expect(reloaded.list({ workspace: "repo-1", runId: "run-1" })).toEqual(store.list({ workspace: "repo-1", runId: "run-1" }));
    expect(reloaded.listEvents({ workspace: "repo-1", runId: "run-1" })).toEqual(store.listEvents({ workspace: "repo-1", runId: "run-1" }));
  });

  it("replays historical Codex activities when a conversation is resumed under a fresh run", async () => {
    const filePath = path.join(await tempDirectory(), "conversation-activity.json");
    const store = new ConversationActivityStore(filePath);
    await store.initialize();
    store.record({
      type: "codex-progress",
      runId: "run-old",
      workspace: "repo-1",
      threadId: "thread-native",
      turnId: "turn-old",
      itemId: "tool-1",
      kind: "tool",
      stage: "completed",
      label: "Called tool",
      functionName: "repo.read_file",
      parameters: "{\"path\":\"README.md\"}",
      output: "ok",
    });

    expect(store.list({ workspace: "repo-1", runId: "run-fresh", threadId: "thread-native" })).toMatchObject([{
      runId: "run-old",
      threadId: "thread-native",
      functionName: "repo.read_file",
      output: "ok",
    }]);
  });

  it("splits a multi-file diff into one independently expandable file activity per path", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    const emitted = store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "diff",
      text: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ].join("\n"),
      itemId: "git-diff:sha",
    });

    expect(emitted).toHaveLength(2);
    const activities = store.list({ workspace: "repo-1", runId: "run-1" });
    expect(activities.map((activity) => ({ path: activity.filePath, additions: activity.additions, deletions: activity.deletions, position: activity.position }))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 1, position: 1 },
      { path: "src/b.ts", additions: 2, deletions: 0, position: 2 },
    ]);
    expect(activities[0]?.diff).toContain("src/a.ts");
    expect(activities[1]?.diff).toContain("src/b.ts");
    expect(store.listEvents({ workspace: "repo-1", runId: "run-1" }).map((event) => ({ type: event.type, path: event.filePath }))).toEqual([
      { type: "file_diff", path: "src/a.ts" },
      { type: "file_diff", path: "src/b.ts" },
    ]);
  });

  it("clears only the selected workspace history", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    for (const workspace of ["repo-a", "repo-b"]) {
      store.record({
        type: "chatgpt-progress",
        taskId: `task-${workspace}`,
        runId: `run-${workspace}`,
        workspace,
        kind: "reasoning",
        text: `reasoning-${workspace}`,
      });
    }
    store.clearWorkspace("repo-a");
    expect(store.list({ workspace: "repo-a", runId: "run-repo-a" })).toEqual([]);
    expect(store.list({ workspace: "repo-b", runId: "run-repo-b" })).toHaveLength(1);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-activity-store-"));
  temporaryDirectories.push(directory);
  return directory;
}
