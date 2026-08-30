export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentModelDecision =
  | {
      kind: "reply";
      text: string;
      usage?: AgentTokenUsage;
    }
  | {
      kind: "tool";
      name: string;
      arguments: unknown;
      usage?: AgentTokenUsage;
    }
  | {
      kind: "stop";
      reason: "no-tool";
      usage?: AgentTokenUsage;
    };

export interface AgentModelMessage {
  role: "user" | "context" | "tool";
  content: string;
  toolName?: string;
}

export interface AgentModelInput {
  messages: readonly AgentModelMessage[];
  iteration: number;
  maxIterations: number;
}

/**
 * Provider-neutral model boundary. Implementations may call a configured model,
 * but they never receive Harness policy authority and they cannot execute tools.
 * Hidden reasoning is intentionally absent from this contract.
 */
export interface AgentModelAdapter {
  readonly providerId: string;
  readonly modelId: string;
  decide(input: AgentModelInput): Promise<AgentModelDecision>;
}
