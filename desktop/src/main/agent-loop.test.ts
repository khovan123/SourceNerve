import { describe, expect, it } from "vitest";

import { runAgentLoop, type GovernedAgentToolExecutor } from "./agent-loop";
import type { AgentModelAdapter, AgentModelDecision } from "./agent-model-adapter";
import { AgentSession } from "./agent-session";

class SequenceModel implements AgentModelAdapter {
  readonly providerId = "test";
  readonly modelId = "sequence";
  private index = 0;
  constructor(private readonly decisions: AgentModelDecision[]) {}
  async decide(): Promise<AgentModelDecision> {
    const decision = this.decisions[this.index++];
    if (!decision) throw new Error("No scripted decision");
    return decision;
  }
}

class RecordingTools implements GovernedAgentToolExecutor {
  readonly calls: Array<{ runId: string; name: string; arguments: unknown }> = [];
  async execute(input: { runId: string; name: string; arguments: unknown }): Promise<unknown> {
    this.calls.push(input);
    return { ok: true, source: "harness-governed-test" };
  }
}

describe("agent loop", () => {
  it("executes proposed tools only through the governed executor and naturally stops on reply", async () => {
    const tools = new RecordingTools();
    const model = new SequenceModel([
      { kind: "tool", name: "plugin_catalog", arguments: { query: "Harness" }, usage: { inputTokens: 3, outputTokens: 2 } },
      { kind: "reply", text: "done", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    const events: string[] = [];
    const result = await runAgentLoop({
      runId: "run-1",
      maxIterations: 4,
      session: new AgentSession({ userMessage: "inspect Harness" }),
      model,
      tools,
      onEvent: (event) => { events.push(event.type); },
    });

    expect(result).toMatchObject({ status: "completed", stopReason: "model-reply", reply: "done", iterations: 2 });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(tools.calls).toEqual([{ runId: "run-1", name: "plugin_catalog", arguments: { query: "Harness" } }]);
    expect(events).toEqual(["iteration", "decision", "tool-result", "iteration", "decision"]);
  });

  it("hard stops at maxIterations when the model keeps requesting tools", async () => {
    const tools = new RecordingTools();
    const model = new SequenceModel([
      { kind: "tool", name: "plugin_catalog", arguments: {} },
      { kind: "tool", name: "plugin_catalog", arguments: {} },
    ]);
    const result = await runAgentLoop({
      runId: "run-1",
      maxIterations: 2,
      session: new AgentSession({ userMessage: "loop" }),
      model,
      tools,
    });
    expect(result).toMatchObject({ status: "iteration-limit", stopReason: "iteration-limit", iterations: 2 });
    expect(tools.calls).toHaveLength(2);
  });
});
