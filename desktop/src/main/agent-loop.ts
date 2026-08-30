import type { AgentModelAdapter, AgentTokenUsage } from "./agent-model-adapter";
import type { AgentSession } from "./agent-session";

const MAX_TOOL_NAME_BYTES = 128;

export interface GovernedAgentToolExecutor {
  /** Execute only through an existing Harness-governed tool gateway. */
  execute(input: { runId: string; name: string; arguments: unknown }): Promise<unknown>;
}

export type AgentLoopEvent =
  | { type: "iteration"; iteration: number }
  | { type: "decision"; iteration: number; decision: "reply" | "tool" | "stop"; toolName?: string }
  | { type: "tool-result"; iteration: number; toolName: string };

export interface AgentLoopResult {
  status: "completed" | "iteration-limit";
  stopReason: "model-reply" | "no-tool" | "iteration-limit";
  reply?: string;
  iterations: number;
  usage: AgentTokenUsage;
}

export async function runAgentLoop(input: {
  runId: string;
  maxIterations: number;
  session: AgentSession;
  model: AgentModelAdapter;
  tools: GovernedAgentToolExecutor;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
}): Promise<AgentLoopResult> {
  const maxIterations = boundedIterations(input.maxIterations);
  let usage: AgentTokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    await input.onEvent?.({ type: "iteration", iteration });
    const decision = await input.model.decide({
      messages: input.session.snapshot(),
      iteration,
      maxIterations,
    });
    usage = addUsage(usage, decision.usage);

    if (decision.kind === "reply") {
      const reply = boundedReply(decision.text);
      await input.onEvent?.({ type: "decision", iteration, decision: "reply" });
      return { status: "completed", stopReason: "model-reply", reply, iterations: iteration, usage };
    }

    if (decision.kind === "stop") {
      await input.onEvent?.({ type: "decision", iteration, decision: "stop" });
      return { status: "completed", stopReason: "no-tool", iterations: iteration, usage };
    }

    const toolName = boundedToolName(decision.name);
    await input.onEvent?.({ type: "decision", iteration, decision: "tool", toolName });
    const result = await input.tools.execute({ runId: input.runId, name: toolName, arguments: decision.arguments });
    input.session.appendToolObservation(toolName, result);
    await input.onEvent?.({ type: "tool-result", iteration, toolName });
  }

  return {
    status: "iteration-limit",
    stopReason: "iteration-limit",
    iterations: maxIterations,
    usage,
  };
}

function boundedIterations(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new Error("Agent maxIterations must be 1-64");
  return value;
}

function boundedToolName(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_TOOL_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Agent model returned an invalid tool name");
  }
  return value;
}

function boundedReply(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 128 * 1024 || /\u0000/.test(value)) {
    throw new Error("Agent model returned an invalid reply");
  }
  return value;
}

function addUsage(current: AgentTokenUsage, next?: AgentTokenUsage): AgentTokenUsage {
  if (!next) return current;
  for (const value of [next.inputTokens, next.outputTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Agent model returned invalid token usage");
  }
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
  };
}
