import { randomUUID } from "node:crypto";

import type { SourceNerveClient } from "./sourcenerve-client";
import { AgentEvaluationClient, type AgentEvaluationView } from "./agent-eval";
import { runAgentLoop, type GovernedAgentToolExecutor } from "./agent-loop";
import { AgentMemoryClient, memoryContextMessages } from "./agent-memory";
import type { AgentModelAdapter } from "./agent-model-adapter";
import { parseAgentIteration, parseAgentTurn, parseAgentTurnBegin, parseAgentTurnList, type AgentTurnView } from "./agent-parser";
import { AgentSession } from "./agent-session";

export interface AgentOrchestrationResult {
  turn: AgentTurnView;
  reply?: string;
  evaluation: AgentEvaluationView;
}

/**
 * Desktop Agent Host. The model proposes; the injected GovernedAgentToolExecutor
 * is the only tool execution path. This class has no shell/process primitive.
 */
export class AgentOrchestrator {
  private readonly memory: AgentMemoryClient;
  private readonly evaluations: AgentEvaluationClient;

  constructor(private readonly dependencies: {
    client: SourceNerveClient;
    model: AgentModelAdapter;
    tools: GovernedAgentToolExecutor;
  }) {
    this.memory = new AgentMemoryClient(dependencies.client);
    this.evaluations = new AgentEvaluationClient(dependencies.client);
  }

  async run(input: { runId: string; userMessage: string; maxIterations?: number; clientRequestId?: string }): Promise<AgentOrchestrationResult> {
    const maxIterations = input.maxIterations ?? 12;
    const begun = parseAgentTurnBegin(await this.dependencies.client.harnessRequest(
      "/api/v1/harness/agent/turns/begin",
      {
        run_id: input.runId,
        client_request_id: input.clientRequestId ?? `desktop:agent:${randomUUID()}`,
        max_iterations: maxIterations,
        provider_id: this.dependencies.model.providerId,
        model_id: this.dependencies.model.modelId,
      },
    ));

    if (begun.turn.status !== "running") {
      const evaluation = await this.evaluations.evaluate(begun.turn.id);
      return { turn: begun.turn, evaluation };
    }

    if (begun.replayed && begun.turn.iterationCount > 0) {
      throw new Error("Agent turn already has durable iterations; reload the turn instead of replaying its non-durable model session");
    }

    const memory = await this.memory.retrieve({ runId: input.runId, query: input.userMessage });
    const session = new AgentSession({
      userMessage: input.userMessage,
      context: memoryContextMessages(memory),
    });

    try {
      const loop = await runAgentLoop({
        runId: input.runId,
        maxIterations,
        session,
        model: this.dependencies.model,
        tools: this.dependencies.tools,
        onEvent: async (event) => {
          if (event.type !== "decision") return;
          parseAgentIteration(await this.dependencies.client.harnessRequest(
            "/api/v1/harness/agent/turns/iteration",
            {
              turn_id: begun.turn.id,
              iteration: event.iteration,
              decision: event.decision,
              ...(event.toolName ? { tool_name: event.toolName } : {}),
            },
          ));
        },
      });

      const turn = parseAgentTurn(await this.dependencies.client.harnessRequest(
        "/api/v1/harness/agent/turns/complete",
        {
          turn_id: begun.turn.id,
          status: loop.status,
          stop_reason: loop.stopReason,
          input_tokens: loop.usage.inputTokens,
          output_tokens: loop.usage.outputTokens,
        },
      ));
      const evaluation = await this.evaluations.evaluate(turn.id);
      return { turn, ...(loop.reply === undefined ? {} : { reply: loop.reply }), evaluation };
    } catch (error) {
      try {
        await this.dependencies.client.harnessRequest(
          "/api/v1/harness/agent/turns/complete",
          {
            turn_id: begun.turn.id,
            status: "failed",
            stop_reason: "error",
            input_tokens: 0,
            output_tokens: 0,
          },
        );
      } catch {
        // Preserve the original failure. Harness recovery/events remain authoritative.
      }
      throw error;
    }
  }

  async listTurns(runId: string, limit = 25): Promise<AgentTurnView[]> {
    return parseAgentTurnList(await this.dependencies.client.harnessRequest(
      "/api/v1/harness/agent/turns/list",
      { run_id: runId, limit },
    ));
  }
}
