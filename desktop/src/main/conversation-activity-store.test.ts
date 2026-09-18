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
  it("does not persist transient ChatGPT reasoning status as conversation activity", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();

    const event = {
      type: "chatgpt-progress" as const,
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "reasoning" as const,
      text: "Inspecting workspace and task context…",
    };

    expect(store.record(event)).toEqual([event]);
    expect(store.list({ workspace: "repo-1", runId: "run-1" })).toEqual([]);
    expect(store.listEvents({ workspace: "repo-1", runId: "run-1" })).toEqual([]);
  });

  it("persists direct ChatGPT user and assistant messages across reload", async () => {
    const filePath = path.join(await tempDirectory(), "conversation-activity.json");
    const store = new ConversationActivityStore(filePath);
    await store.initialize();

    store.recordMessage({
      id: "user:chatgpt:task-1",
      role: "user",
      text: "continue",
      createdAt: "2026-09-17T08:00:00.000Z",
      turnId: "chatgpt-review:task-1",
      runId: "run-1",
      workspace: "repo-1",
    });
    store.recordMessage({
      id: "assistant:task-1",
      role: "assistant",
      text: "done",
      createdAt: "2026-09-17T08:00:01.000Z",
      turnId: "chatgpt-review:task-1",
      runId: "run-1",
      workspace: "repo-1",
    });
    await store.flush();

    const reloaded = new ConversationActivityStore(filePath);
    await reloaded.initialize();
    expect(reloaded.listMessages({ workspace: "repo-1", runId: "run-1" })).toEqual([
      expect.objectContaining({ id: "user:chatgpt:task-1", role: "user", text: "continue" }),
      expect.objectContaining({ id: "assistant:task-1", role: "assistant", text: "done" }),
    ]);
  });

  it("replays every prompt in one logical ChatGPT conversation across multiple Harness runs", async () => {
    const filePath = path.join(await tempDirectory(), "conversation-activity.json");
    const store = new ConversationActivityStore(filePath);
    await store.initialize();

    const conversationId = "chatgpt:conversation-a";
    const turns = [
      ["run-1", "task-1", "first prompt", "first answer", "2026-09-17T08:00:00.000Z"],
      ["run-2", "task-2", "second prompt", "second answer", "2026-09-17T08:01:00.000Z"],
      ["run-3", "task-3", "third prompt", "third answer", "2026-09-17T08:02:00.000Z"],
    ] as const;
    for (const [runId, taskId, prompt, answer, createdAt] of turns) {
      store.recordMessage({
        id: `user:chatgpt:${taskId}`, role: "user", text: prompt, createdAt,
        turnId: `chatgpt-review:${taskId}`, runId, workspace: "repo-1", conversationId,
      });
      store.recordMessage({
        id: `assistant:${taskId}`, role: "assistant", text: answer,
        createdAt: new Date(Date.parse(createdAt) + 1_000).toISOString(),
        turnId: `chatgpt-review:${taskId}`, runId, workspace: "repo-1", conversationId,
      });
    }
    await store.flush();

    const reloaded = new ConversationActivityStore(filePath);
    await reloaded.initialize();
    expect(reloaded.conversationId({ workspace: "repo-1", runId: "run-1" })).toBe(conversationId);
    expect(reloaded.listMessages({ workspace: "repo-1", runId: "run-1", conversationId }).map((message) => message.text)).toEqual([
      "first prompt", "first answer", "second prompt", "second answer", "third prompt", "third answer",
    ]);
  });

  it("includes only legacy messages from the selected anchor run when resuming a tagged logical conversation", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    const conversationId = "chatgpt:conversation-a";
    store.recordMessage({
      id: "legacy-user", role: "user", text: "first prompt", createdAt: "2026-09-17T08:00:00.000Z",
      runId: "run-1", workspace: "repo-1",
    });
    store.recordMessage({
      id: "legacy-assistant", role: "assistant", text: "first answer", createdAt: "2026-09-17T08:00:30.000Z",
      runId: "run-1", workspace: "repo-1",
    });
    store.recordMessage({
      id: "other-legacy", role: "user", text: "unrelated legacy prompt", createdAt: "2026-09-17T08:00:45.000Z",
      runId: "run-unrelated", workspace: "repo-1",
    });
    store.recordMessage({
      id: "user:task-2", role: "user", text: "second prompt", createdAt: "2026-09-17T08:01:00.000Z",
      runId: "run-2", workspace: "repo-1", conversationId,
    });
    store.recordMessage({
      id: "assistant:task-2", role: "assistant", text: "second answer", createdAt: "2026-09-17T08:01:30.000Z",
      runId: "run-2", workspace: "repo-1", conversationId,
    });

    expect(store.listMessages({ workspace: "repo-1", runId: "run-1", conversationId }).map((message) => message.text)).toEqual([
      "first prompt", "first answer", "second prompt", "second answer",
    ]);
  });

  it("lists one resumable summary for a logical ChatGPT conversation spanning multiple Harness runs", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    const conversationId = "chatgpt:conversation-a";
    store.recordMessage({
      id: "user:task-1", role: "user", text: "first prompt", createdAt: "2026-09-17T08:00:00.000Z",
      runId: "run-1", workspace: "repo-1", conversationId,
    });
    store.recordMessage({
      id: "assistant:task-1", role: "assistant", text: "first answer", createdAt: "2026-09-17T08:00:30.000Z",
      runId: "run-1", workspace: "repo-1", conversationId,
    });
    store.recordMessage({
      id: "user:task-2", role: "user", text: "second prompt", createdAt: "2026-09-17T08:01:00.000Z",
      runId: "run-2", workspace: "repo-1", conversationId,
    });
    store.recordMessage({
      id: "assistant:task-2", role: "assistant", text: "second answer", createdAt: "2026-09-17T08:01:30.000Z",
      runId: "run-2", workspace: "repo-1", conversationId,
    });

    expect(store.listConversationSummaries("repo-1")).toEqual([{
      source: "chatgpt",
      runId: "run-2",
      conversationId,
      workspace: "repo-1",
      title: "first prompt",
      preview: "second answer",
      createdAt: "2026-09-17T08:00:00.000Z",
      updatedAt: "2026-09-17T08:01:30.000Z",
      model: "ChatGPT Web current model",
      status: "idle",
    }]);
  });

  it("does not merge a newer logical ChatGPT conversation into an older run", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    store.recordMessage({
      id: "user:old", role: "user", text: "old prompt", createdAt: "2026-09-17T08:00:00.000Z",
      runId: "run-old", workspace: "repo-1", conversationId: "chatgpt:old",
    });
    store.recordMessage({
      id: "user:new", role: "user", text: "new prompt", createdAt: "2026-09-17T09:00:00.000Z",
      runId: "run-new", workspace: "repo-1", conversationId: "chatgpt:new",
    });

    expect(store.listMessages({ workspace: "repo-1", runId: "run-old" }).map((message) => message.text)).toEqual(["old prompt"]);
    expect(store.listMessages({ workspace: "repo-1", runId: "run-old", conversationId: "chatgpt:new" }).map((message) => message.text)).toEqual(["new prompt"]);
  });

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

  it("updates ChatGPT file diff activities by file path instead of appending every dirty snapshot", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();
    const first = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const second = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new",
      "+again",
    ].join("\n");

    store.record({ type: "chatgpt-progress", taskId: "task-1", runId: "run-1", workspace: "repo-1", kind: "diff", text: first, itemId: "git-diff:first" });
    store.record({ type: "chatgpt-progress", taskId: "task-1", runId: "run-1", workspace: "repo-1", kind: "diff", text: second, itemId: "git-diff:second" });

    const activities = store.list({ workspace: "repo-1", runId: "run-1" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ filePath: "src/a.ts", additions: 2, deletions: 1 });
    expect(activities[0]?.diff).toContain("+again");
  });

  it("updates a ChatGPT tool activity when follow-up events omit parameters", async () => {
    const store = new ConversationActivityStore(path.join(await tempDirectory(), "conversation-activity.json"));
    await store.initialize();

    store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "tool",
      text: "Workspace exec · started",
      stage: "started",
      functionName: "workspace_exec",
      parameters: '{"program":"pnpm","args":["test"]}',
    });
    store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "tool",
      text: "Workspace exec · completed",
      stage: "completed",
      functionName: "workspace_exec",
      output: "447 tests passed",
      durationMs: 2250,
    });

    const activities = store.list({ workspace: "repo-1", runId: "run-1" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      functionName: "workspace_exec",
      parameters: '{"program":"pnpm","args":["test"]}',
      output: "447 tests passed",
      stage: "completed",
      durationMs: 2250,
    });
  });

  it("keeps one ChatGPT tool activity when an execution id appears after start and stale events arrive later", async () => {
    const filePath = path.join(await tempDirectory(), "conversation-activity.json");
    const store = new ConversationActivityStore(filePath);
    await store.initialize();

    store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "tool",
      text: "Workspace exec · started",
      stage: "started",
      functionName: "workspace_exec",
      parameters: '{"program":"pnpm","args":["test"]}',
    });
    store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "tool",
      text: "Workspace exec · completed",
      stage: "completed",
      itemId: "exec-1",
      functionName: "workspace_exec",
      output: "ok",
    });
    store.record({
      type: "chatgpt-progress",
      taskId: "task-1",
      runId: "run-1",
      workspace: "repo-1",
      kind: "tool",
      text: "Workspace exec · started",
      stage: "started",
      itemId: "exec-1",
      functionName: "workspace_exec",
    });

    const activities = store.list({ workspace: "repo-1", runId: "run-1" });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ itemId: "exec-1", stage: "completed", output: "ok" });
    await store.flush();
    const reloaded = new ConversationActivityStore(filePath);
    await reloaded.initialize();
    expect(reloaded.list({ workspace: "repo-1", runId: "run-1" })).toMatchObject([
      { itemId: "exec-1", stage: "completed", output: "ok" },
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
        kind: "tool",
        text: `Workspace exec · completed`,
        stage: "completed",
        functionName: "workspace_exec",
        output: `ok-${workspace}`,
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
