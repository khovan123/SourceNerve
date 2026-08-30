export type AgentTurnStatus = "running" | "completed" | "failed" | "cancelled" | "iteration-limit";
export type AgentTurnStopReason = "model-reply" | "no-tool" | "iteration-limit" | "cancelled" | "error";

export interface AgentTurnView {
  id: string;
  runId: string;
  clientRequestId?: string;
  status: AgentTurnStatus;
  maxIterations: number;
  iterationCount: number;
  providerId?: string;
  modelId?: string;
  stopReason?: AgentTurnStopReason;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function parseAgentTurn(value: unknown): AgentTurnView {
  const row = record(value, "agent turn");
  return {
    id: text(row.id, 128, "agent turn id"),
    runId: text(row.run_id, 128, "agent run id"),
    ...(row.client_request_id == null ? {} : { clientRequestId: text(row.client_request_id, 128, "agent request id") }),
    status: status(row.status),
    maxIterations: integer(row.max_iterations, 1, 64, "agent max iterations"),
    iterationCount: integer(row.iteration_count, 0, 64, "agent iteration count"),
    ...(row.provider_id == null ? {} : { providerId: text(row.provider_id, 128, "agent provider id") }),
    ...(row.model_id == null ? {} : { modelId: text(row.model_id, 128, "agent model id") }),
    ...(row.stop_reason == null ? {} : { stopReason: stopReason(row.stop_reason) }),
    inputTokens: integer(row.input_tokens, 0, Number.MAX_SAFE_INTEGER, "agent input tokens"),
    outputTokens: integer(row.output_tokens, 0, Number.MAX_SAFE_INTEGER, "agent output tokens"),
    startedAt: integer(row.started_at, 0, Number.MAX_SAFE_INTEGER, "agent started at"),
    updatedAt: integer(row.updated_at, 0, Number.MAX_SAFE_INTEGER, "agent updated at"),
    ...(row.completed_at == null ? {} : { completedAt: integer(row.completed_at, 0, Number.MAX_SAFE_INTEGER, "agent completed at") }),
  };
}

export function parseAgentTurnBegin(value: unknown): { turn: AgentTurnView; replayed: boolean } {
  const row = record(value, "agent turn begin");
  if (typeof row.replayed !== "boolean") throw new Error("SourceNerve agent replay flag is invalid");
  return { turn: parseAgentTurn(row.turn), replayed: row.replayed };
}

export function parseAgentTurnList(value: unknown): AgentTurnView[] {
  const row = record(value, "agent turn list");
  if (!Array.isArray(row.turns)) throw new Error("SourceNerve agent turn list is invalid");
  return row.turns.map(parseAgentTurn);
}

export function parseAgentIteration(value: unknown): { turn: AgentTurnView; iterationLimitReached: boolean } {
  const row = record(value, "agent iteration");
  if (typeof row.iteration_limit_reached !== "boolean") throw new Error("SourceNerve agent iteration limit flag is invalid");
  return { turn: parseAgentTurn(row.turn), iterationLimitReached: row.iteration_limit_reached };
}

function status(value: unknown): AgentTurnStatus {
  if (value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "iteration-limit") return value;
  throw new Error("SourceNerve agent turn status is invalid");
}
function stopReason(value: unknown): AgentTurnStopReason {
  if (value === "model-reply" || value === "no-tool" || value === "iteration-limit" || value === "cancelled" || value === "error") return value;
  throw new Error("SourceNerve agent stop reason is invalid");
}
function integer(value: unknown, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`SourceNerve ${label} is invalid`); return Number(value); }
function text(value: unknown, maxBytes: number, label: string): string { if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`SourceNerve ${label} is invalid`); return value; }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`SourceNerve ${label} is invalid`); return value as Record<string, unknown>; }
