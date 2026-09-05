import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexConversationStore } from "./codex-conversation-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexConversationStore", () => {
  it("persists one Harness transcript and native thread binding across reloads", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-conversation-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "conversations.json");
    const first = new CodexConversationStore(filePath, () => new Date("2026-09-05T08:00:00.000Z"));
    await first.initialize();
    await first.appendUser({ runId: "run-1", workspace: "repo", messageId: "user-1", text: "inspect this" });
    await first.appendUser({ runId: "run-1", workspace: "repo", messageId: "user-1", text: "inspect this" });
    await first.appendAssistant({ runId: "run-1", workspace: "repo", threadId: "thread-1", turnId: "turn-1", text: "done" });
    await first.flush();

    const second = new CodexConversationStore(filePath);
    await second.initialize();

    expect(second.get("run-1", "repo")).toEqual({
      runId: "run-1",
      workspace: "repo",
      threadId: "thread-1",
      messages: [
        { id: "user-1", role: "user", text: "inspect this", createdAt: "2026-09-05T08:00:00.000Z" },
        { id: "assistant:turn-1", role: "assistant", text: "done", createdAt: "2026-09-05T08:00:00.000Z", turnId: "turn-1" },
      ],
    });
  });

  it("fails closed when a run is reused for a different workspace", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-conversation-"));
    temporaryDirectories.push(directory);
    const store = new CodexConversationStore(path.join(directory, "conversations.json"));
    await store.initialize();
    await store.appendUser({ runId: "run-1", workspace: "repo-a", messageId: "user-1", text: "hello" });

    expect(() => store.get("run-1", "repo-b")).toThrow(/different workspace/);
  });
});
