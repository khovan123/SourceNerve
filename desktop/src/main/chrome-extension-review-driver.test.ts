import { describe, expect, it } from "vitest";

import type { ChatGptReviewDriver } from "./chatgpt-review-loop";
import { CHROME_EXTENSION_PROTOCOL_VERSION } from "./chrome-extension-bridge";
import { ChromeExtensionReviewDriver, CompositeChatGptReviewDriver } from "./chrome-extension-review-driver";

const request = {
  taskId: "sn_0123456789abcdef",
  runId: "run-1",
  workspace: "workspace-a",
  goal: "Fix stale ChatGPT task binding",
  mode: "review" as const,
};

describe("CompositeChatGptReviewDriver", () => {
  it("falls back to embedded ChatGPT Web when the connected extension returns a stale task reply", async () => {
    const cancelled: string[] = [];
    const extension = new ChromeExtensionReviewDriver({
      state: () => ({
        enabled: true,
        origin: "http://127.0.0.1:40173",
        tokenPrefix: "deadbeef",
        connected: true,
        pendingCommands: 0,
        completedCommands: 0,
        frontend: { provider: "chrome-extension", documentId: "doc", epoch: 1, extensionProtocolVersion: CHROME_EXTENSION_PROTOCOL_VERSION },
      }),
      sendCommand: async () => {
        throw new Error("Chrome extension ChatGPT bridge returned a stale or task-unbound control reply");
      },
      cancelTask: (taskId: string) => { cancelled.push(taskId); },
    });
    let embeddedBeginCalls = 0;
    const embedded: ChatGptReviewDriver = {
      begin: async ({ taskId }) => {
        embeddedBeginCalls += 1;
        return `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 1\n\nPLAN:\nUse the embedded web control plane.`;
      },
      review: async ({ taskId, iteration }) => `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nREVIEW:\nDone.`,
    };
    const composite = new CompositeChatGptReviewDriver({ embedded, chromeExtension: extension });

    const reply = await composite.begin(request);

    expect(reply).toContain("Use the embedded web control plane");
    expect(embeddedBeginCalls).toBe(1);
    expect(cancelled).toEqual([request.taskId]);
  });

  it("uses embedded ChatGPT Web when the connected extension has no compatible protocol handshake", async () => {
    let extensionBeginCalls = 0;
    const extension = new ChromeExtensionReviewDriver({
      state: () => ({
        enabled: true,
        origin: "http://127.0.0.1:40173",
        tokenPrefix: "deadbeef",
        connected: true,
        pendingCommands: 0,
        completedCommands: 0,
        frontend: { provider: "chrome-extension", documentId: "old-extension", epoch: 1 },
      }),
      sendCommand: async () => {
        extensionBeginCalls += 1;
        return "stale";
      },
      cancelTask: () => undefined,
    });
    const embedded: ChatGptReviewDriver = {
      begin: async ({ taskId }) => `[C2C]\nSTATE: PLAN\nTASK_ID: ${taskId}\nITERATION: 1\n\nPLAN:\nUse embedded because extension is old.`,
      review: async ({ taskId, iteration }) => `[C2C]\nSTATE: DONE\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\nREVIEW:\nDone.`,
    };
    const composite = new CompositeChatGptReviewDriver({ embedded, chromeExtension: extension });

    const reply = await composite.begin(request);

    expect(reply).toContain("extension is old");
    expect(extensionBeginCalls).toBe(0);
  });

  it("passes the logical SourceNerve conversation through the extension bridge", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const extension = new ChromeExtensionReviewDriver({
      state: () => ({
        enabled: true,
        origin: "http://127.0.0.1:40173",
        tokenPrefix: "deadbeef",
        connected: true,
        pendingCommands: 0,
        completedCommands: 0,
        frontend: { provider: "chrome-extension", documentId: "doc", epoch: 1, extensionProtocolVersion: CHROME_EXTENSION_PROTOCOL_VERSION },
      }),
      sendCommand: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return ["[C2C]", "STATE: DONE", `TASK_ID: ${request.taskId}`, "ITERATION: 0", "", "ANSWER:", "Done."].join("\n");
      },
      cancelTask: () => undefined,
    });

    await extension.begin({ ...request, conversationId: "conversation-a" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.logicalConversationId).toBe("conversation-a");
  });

});
