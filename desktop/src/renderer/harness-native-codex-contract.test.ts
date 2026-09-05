import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

describe("Harness native Codex product contract", () => {
  it("presents native Codex as the Harness conversation runtime instead of a secondary chat lane", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain('export function HarnessConversationPanel');
    expect(source).toContain('title="Harness conversation"');
    expect(source).toContain('eyebrow="Native Codex runtime"');
    expect(source).toContain("Native Codex owns reasoning, thread history and built-in tools.");
    expect(source).not.toContain('title="Chat with Codex"');
    expect(source).not.toContain('eyebrow="ChatGPT native lane"');
  });

  it("hydrates persisted transcripts and switches exact Harness runs inside the conversation surface", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("getHarnessCodexConversation");
    expect(source).toContain("clientMessageId");
    expect(source).toContain("Conversation / run");
    expect(source).toContain("New conversation");
    expect(source).toContain("switchRun");
    expect(source).toContain("Restoring conversation…");
  });

  it("keeps exact one-shot Harness approvals inline while a native Codex turn is paused", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "CodexChatPanel.tsx"), "utf8");

    expect(source).toContain("listHarnessApprovals");
    expect(source).toContain("respondHarnessApproval");
    expect(source).toContain("Harness needs approval to continue");
    expect(source).toContain("Allow once");
    expect(source).toContain("Deny");
    expect(source).toContain("externalRequestId");
  });

  it("makes the Harness screen mount the conversation runtime as its primary approval surface", async () => {
    const source = await readFile(path.join(rendererRoot, "components", "HarnessScreen.tsx"), "utf8");

    expect(source).toContain('import { HarnessConversationPanel } from "./CodexChatPanel";');
    expect(source).toContain("<HarnessConversationPanel");
    expect(source.indexOf("<HarnessConversationPanel")).toBeLessThan(source.indexOf('title="Execution policy"'));
    expect(source).toContain("selectedRun={selected}");
    expect(source).not.toContain("<HarnessApprovalPanel");
    expect(source).not.toContain('from "./HarnessApprovalPanel"');
  });
});
