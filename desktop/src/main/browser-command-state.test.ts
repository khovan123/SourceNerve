import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserCommandStateStore } from "./browser-command-state";
import { bindProviderFrontend } from "./provider-frontend-session";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<BrowserCommandStateStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-browser-state-"));
  roots.push(root);
  return new BrowserCommandStateStore(path.join(root, "commands.json"));
}

describe("BrowserCommandStateStore ChatGPT project bindings", () => {
  it("keeps one durable ChatGPT Project binding per workspace", async () => {
    const store = await createStore();

    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-lcsp/project",
      now: 10,
    });
    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-lcsp-new/project/",
      now: 20,
    });

    expect(await store.workspaceProject("lcsp")).toEqual({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectId: "g-p-lcsp-new",
      projectUrl: "https://chatgpt.com/g/g-p-lcsp-new/project",
      updatedAt: 20,
    });
    expect((await store.snapshot()).projects).toHaveLength(1);
  });

  it("reuses the canonical provider conversation id for one logical SourceNerve conversation across runs", async () => {
    const store = await createStore();
    const logicalConversationId = "conversation-abc";
    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-lcsp/project",
      now: 5,
    });

    await store.record({
      commandId: "command-1",
      taskId: "task-1",
      logicalConversationId,
      stage: "stable",
      now: 10,
      binding: bindProviderFrontend({
        sourceSessionId: "session-1",
        runId: "run-1",
        workspace: "lcsp",
        frontend: {
          provider: "chatgpt-web",
          documentId: "doc-1",
          conversationId: "provider-conversation-1",
          epoch: 1,
        },
        now: 10,
      }),
    });

    await store.record({
      commandId: "command-2",
      taskId: "task-2",
      logicalConversationId,
      stage: "queued",
      now: 20,
      binding: bindProviderFrontend({
        sourceSessionId: "session-2",
        runId: "run-2",
        workspace: "lcsp",
        frontend: {
          provider: "chatgpt-web",
          documentId: "doc-2",
          epoch: 2,
        },
        now: 20,
      }),
    });

    expect(await store.latestProviderConversationId({ workspace: "lcsp", logicalConversationId }))
      .toBe("provider-conversation-1");
  });
  it("invalidates a missing provider conversation without reviving the old command-history binding", async () => {
    const store = await createStore();
    const logicalConversationId = "conversation-missing";
    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-lcsp/project",
      now: 5,
    });

    await store.record({
      commandId: "command-missing",
      taskId: "task-missing",
      logicalConversationId,
      stage: "stable",
      now: 10,
      binding: bindProviderFrontend({
        sourceSessionId: "session-missing",
        runId: "run-missing",
        workspace: "lcsp",
        frontend: {
          provider: "chatgpt-web",
          documentId: "doc-missing",
          conversationId: "provider-conversation-missing",
          epoch: 1,
        },
        now: 10,
      }),
    });

    expect(await store.latestProviderConversationId({ workspace: "lcsp", logicalConversationId }))
      .toBe("provider-conversation-missing");

    await store.clearProviderConversation({ workspace: "lcsp", logicalConversationId });

    expect(await store.latestProviderConversationId({ workspace: "lcsp", logicalConversationId }))
      .toBeUndefined();
    expect((await store.snapshot()).conversations).toEqual([]);
  });

  it("invalidates conversation bindings when a workspace is rebound to a different ChatGPT Project", async () => {
    const store = await createStore();
    const logicalConversationId = "conversation-project-bound";

    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-project-a/project",
      now: 1,
    });
    await store.record({
      commandId: "command-project-a",
      taskId: "task-project-a",
      logicalConversationId,
      stage: "stable",
      now: 2,
      binding: bindProviderFrontend({
        sourceSessionId: "session-project-a",
        runId: "run-project-a",
        workspace: "lcsp",
        frontend: {
          provider: "chatgpt-web",
          documentId: "doc-project-a",
          conversationId: "provider-project-a",
          epoch: 1,
        },
        now: 2,
      }),
    });

    expect(await store.latestProviderConversationId({ workspace: "lcsp", logicalConversationId }))
      .toBe("provider-project-a");

    await store.recordWorkspaceProject({
      workspace: "lcsp",
      projectName: "SourceNerve - lcsp",
      projectUrl: "https://chatgpt.com/g/g-p-project-b/project",
      now: 3,
    });

    expect(await store.latestProviderConversationId({ workspace: "lcsp", logicalConversationId }))
      .toBeUndefined();
    expect((await store.snapshot()).conversations).toEqual([]);
  });

});
