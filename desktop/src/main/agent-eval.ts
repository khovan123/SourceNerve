import type { SourceNerveClient } from "./sourcenerve-client";

export interface AgentEvaluationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AgentEvaluationMetrics {
  iterations: number;
  maxIterations: number;
  contextReads: number;
  executions: number;
  failureCount: number;
  learningCount: number;
  satisfiedProofs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentEvaluationView {
  id: string;
  turnId: string;
  evaluatorVersion: number;
  deterministicVerdict: "pass" | "fail";
  checks: AgentEvaluationCheck[];
  metrics: AgentEvaluationMetrics;
  judgeVerdict?: "pass" | "fail";
  judgeProviderId?: string;
  judgeModelId?: string;
  finalVerdict: "pass" | "fail";
  createdAt: number;
}

export class AgentEvaluationClient {
  constructor(private readonly client: SourceNerveClient) {}

  async evaluate(turnId: string): Promise<AgentEvaluationView> {
    return parseAgentEvaluation(await this.client.harnessRequest(
      "/api/v1/harness/agent/evaluations/run",
      { turn_id: turnId },
    ));
  }

  async list(turnId: string, limit = 20): Promise<AgentEvaluationView[]> {
    const raw = record(await this.client.harnessRequest(
      "/api/v1/harness/agent/evaluations/list",
      { turn_id: turnId, limit },
    ), "agent evaluation list");
    if (!Array.isArray(raw.evaluations)) throw new Error("SourceNerve agent evaluation list is invalid");
    return raw.evaluations.map(parseAgentEvaluation);
  }

  async recordJudge(input: { evaluationId: string; verdict: "pass" | "fail"; providerId: string; modelId: string }): Promise<AgentEvaluationView> {
    return parseAgentEvaluation(await this.client.harnessRequest(
      "/api/v1/harness/agent/evaluations/judge",
      {
        evaluation_id: input.evaluationId,
        verdict: input.verdict,
        provider_id: input.providerId,
        model_id: input.modelId,
      },
    ));
  }
}

export function parseAgentEvaluation(value: unknown): AgentEvaluationView {
  const row = record(value, "agent evaluation");
  const metrics = record(row.metrics, "agent evaluation metrics");
  const checks = array(row.checks, "agent evaluation checks").map((item) => {
    const check = record(item, "agent evaluation check");
    return {
      name: text(check.name, 128, "agent evaluation check name"),
      passed: booleanValue(check.passed, "agent evaluation check passed"),
      detail: text(check.detail, 1024, "agent evaluation check detail"),
    };
  });
  return {
    id: text(row.id, 128, "agent evaluation id"),
    turnId: text(row.turn_id, 128, "agent evaluation turn id"),
    evaluatorVersion: integer(row.evaluator_version, 1, Number.MAX_SAFE_INTEGER, "agent evaluator version"),
    deterministicVerdict: verdict(row.deterministic_verdict, "deterministic verdict"),
    checks,
    metrics: {
      iterations: nonNegative(metrics.iterations, "iterations"),
      maxIterations: nonNegative(metrics.max_iterations, "max iterations"),
      contextReads: nonNegative(metrics.context_reads, "context reads"),
      executions: nonNegative(metrics.executions, "executions"),
      failureCount: nonNegative(metrics.failure_count, "failure count"),
      learningCount: nonNegative(metrics.learning_count, "learning count"),
      satisfiedProofs: nonNegative(metrics.satisfied_proofs, "satisfied proofs"),
      inputTokens: nonNegative(metrics.input_tokens, "input tokens"),
      outputTokens: nonNegative(metrics.output_tokens, "output tokens"),
    },
    ...(row.judge_verdict == null ? {} : { judgeVerdict: verdict(row.judge_verdict, "judge verdict") }),
    ...(row.judge_provider_id == null ? {} : { judgeProviderId: text(row.judge_provider_id, 128, "judge provider id") }),
    ...(row.judge_model_id == null ? {} : { judgeModelId: text(row.judge_model_id, 128, "judge model id") }),
    finalVerdict: verdict(row.final_verdict, "final verdict"),
    createdAt: nonNegative(row.created_at, "created at"),
  };
}

function verdict(value: unknown, label: string): "pass" | "fail" { if (value !== "pass" && value !== "fail") throw new Error(`SourceNerve agent ${label} is invalid`); return value; }
function nonNegative(value: unknown, label: string): number { return integer(value, 0, Number.MAX_SAFE_INTEGER, `agent evaluation ${label}`); }
function integer(value: unknown, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`SourceNerve ${label} is invalid`); return Number(value); }
function booleanValue(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`SourceNerve ${label} is invalid`); return value; }
function text(value: unknown, maxBytes: number, label: string): string { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /\u0000/.test(value)) throw new Error(`SourceNerve ${label} is invalid`); return value; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`SourceNerve ${label} is invalid`); return value; }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`SourceNerve ${label} is invalid`); return value as Record<string, unknown>; }
