import { describe, expect, it } from "vitest";

import type { CodexServerEvent } from "./codex-protocol";
import { codexServerEventToRuntimeProgress } from "./codex-ui-progress";

const context = { runId: "run-1", workspaceId: "repo", cwd: "/repo" };

function notification(method: string, params: unknown): CodexServerEvent {
  return { type: "notification", method, params };
}

describe("Codex UI progress", () => {
  it("streams public reasoning summaries without exposing raw reasoning text notifications", () => {
    expect(codexServerEventToRuntimeProgress(context, notification("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: "Inspecting the failing tests…",
      summaryIndex: 0,
    }))).toMatchObject({
      type: "codex-progress",
      runId: "run-1",
      workspace: "repo",
      turnId: "turn-1",
      itemId: "reasoning-1",
      kind: "reasoning",
      stage: "streaming",
      text: "Inspecting the failing tests…",
    });

    expect(codexServerEventToRuntimeProgress(context, notification("item/reasoning/textDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      delta: "hidden chain of thought",
      contentIndex: 0,
    }))).toBeNull();
  });

  it("captures command lifecycle and output for Claude-style expandable command rows", () => {
    const started = codexServerEventToRuntimeProgress(context, notification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1,
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "npm test",
        cwd: "/repo",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    }));
    expect(started).toMatchObject({ kind: "command", stage: "started", command: "npm test", cwd: "/repo" });

    const delta = codexServerEventToRuntimeProgress(context, notification("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      delta: "2 tests passed\n",
    }));
    expect(delta).toMatchObject({ kind: "command", stage: "streaming", output: "2 tests passed\n" });

    const completed = codexServerEventToRuntimeProgress(context, notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "npm test",
        cwd: "/repo",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "2 tests passed\n",
        exitCode: 0,
        durationMs: 250,
      },
    }));
    expect(completed).toMatchObject({
      kind: "command",
      stage: "completed",
      command: "npm test",
      output: "2 tests passed\n",
      exitCode: 0,
      durationMs: 250,
    });
  });

  it("derives Claude-style semantic command labels from command actions", () => {
    const started = codexServerEventToRuntimeProgress(context, notification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "cmd-read-1",
        command: "sed -n '1,80p' /repo/src/example.ts",
        cwd: "/repo",
        status: "inProgress",
        commandActions: [{ type: "read", path: "/repo/src/example.ts" }],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    }));

    expect(started).toMatchObject({
      kind: "command",
      stage: "started",
      label: "Read example.ts",
    });
  });

  it("captures file diffs and MCP result text", () => {
    const patch = codexServerEventToRuntimeProgress(context, notification("item/fileChange/patchUpdated", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "file-1",
      changes: [{ path: "/repo/src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
    }));
    expect(patch).toMatchObject({ kind: "file", label: "Edited a.ts" });
    const diff = patch?.type === "codex-progress" ? patch.diff ?? "" : "";
    expect(diff).toContain("--- /repo/src/a.ts");
    expect(diff).toContain("+++ /repo/src/a.ts");
    expect(diff).toContain("+new");

    const tool = codexServerEventToRuntimeProgress(context, notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "mcpToolCall",
        id: "tool-1",
        server: "SourceNerve",
        tool: "read_file",
        status: "completed",
        arguments: { path: "src/a.ts", api_key: "do-not-render" },
        result: { content: [{ type: "text", text: "export const ok = true;" }], structuredContent: null, _meta: null },
        error: null,
        durationMs: 14,
      },
    }));
    expect(tool).toMatchObject({
      kind: "tool",
      stage: "completed",
      label: "Read file",
      functionName: "SourceNerve.read_file",
      output: "export const ok = true;",
    });
    const parameters = tool?.type === "codex-progress" ? tool.parameters ?? "" : "";
    expect(parameters).toContain('"path": "src/a.ts"');
    expect(parameters).not.toContain("do-not-render");
  });
});
