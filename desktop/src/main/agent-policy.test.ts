import { describe, expect, it } from "vitest";

import { AGENT_IPC } from "../shared/agent-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";

describe("Agent Desktop IPC policy", () => {
  it("accepts only bounded read, inspect, and evaluate inputs", () => {
    expect(validateDesktopIpcInvocation(AGENT_IPC.listTurns, [{ runId: "run-1", limit: 50 }])).toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.memoryPreview, [{ runId: "run-1", query: "find Harness recovery patterns" }])).toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.evaluate, [{ turnId: "turn-1" }])).toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.listEvaluations, [{ turnId: "turn-1", limit: 20 }])).toBeNull();
  });

  it("rejects payload smuggling and renderer-controlled authority fields", () => {
    expect(validateDesktopIpcInvocation(AGENT_IPC.listTurns, [{ runId: "run-1", provider: "openai" }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.memoryPreview, [{ runId: "run-1", query: "inspect", tool: "workspace_exec" }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.evaluate, [{ turnId: "turn-1", verdict: "pass" }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.listEvaluations, [{ turnId: "turn-1", judge: "pass" }])).not.toBeNull();
  });

  it("enforces identifier, query, and list bounds", () => {
    expect(validateDesktopIpcInvocation(AGENT_IPC.listTurns, [{ runId: "", limit: 20 }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.listTurns, [{ runId: "run-1", limit: 101 }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.memoryPreview, [{ runId: "run-1", query: "" }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.memoryPreview, [{ runId: "run-1", query: "line one\nline two" }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.evaluate, [{ turnId: "x".repeat(129) }])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.listEvaluations, [{ turnId: "turn-1", limit: 0 }])).not.toBeNull();
  });

  it("rejects missing, extra, and unknown invocation shapes", () => {
    expect(validateDesktopIpcInvocation(AGENT_IPC.listTurns, [])).not.toBeNull();
    expect(validateDesktopIpcInvocation(AGENT_IPC.evaluate, [{ turnId: "turn-1" }, { extra: true }])).not.toBeNull();
    expect(validateDesktopIpcInvocation("desktop:agent-run", [{ prompt: "do anything" }])).toMatch(/not allowlisted/);
  });
});
