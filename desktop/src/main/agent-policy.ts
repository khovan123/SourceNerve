import {
  AGENT_IPC,
  type DesktopAgentEvaluationListInput,
  type DesktopAgentEvaluateInput,
  type DesktopAgentMemoryPreviewInput,
  type DesktopAgentTurnListInput,
} from "../shared/agent-api";

export const AGENT_INBOUND_IPC_CHANNELS = Object.freeze(Object.values(AGENT_IPC));

export function validateAgentIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === AGENT_IPC.listTurns) return args.length === 1 && isTurnList(args[0]) ? null : "Agent turn list input is invalid";
  if (channel === AGENT_IPC.memoryPreview) return args.length === 1 && isMemoryPreview(args[0]) ? null : "Agent memory preview input is invalid";
  if (channel === AGENT_IPC.evaluate) return args.length === 1 && isEvaluate(args[0]) ? null : "Agent evaluate input is invalid";
  if (channel === AGENT_IPC.listEvaluations) return args.length === 1 && isEvaluationList(args[0]) ? null : "Agent evaluation list input is invalid";
  return "Agent IPC channel is not allowlisted";
}

function isTurnList(value: unknown): value is DesktopAgentTurnListInput {
  return exactRecord(value, ["runId", "limit"]) && boundedId(value.runId) && optionalLimit(value.limit, 100);
}
function isMemoryPreview(value: unknown): value is DesktopAgentMemoryPreviewInput {
  return exactRecord(value, ["runId", "query"]) && boundedId(value.runId) && boundedQuery(value.query);
}
function isEvaluate(value: unknown): value is DesktopAgentEvaluateInput {
  return exactRecord(value, ["turnId"]) && boundedId(value.turnId);
}
function isEvaluationList(value: unknown): value is DesktopAgentEvaluationListInput {
  return exactRecord(value, ["turnId", "limit"]) && boundedId(value.turnId) && optionalLimit(value.limit, 100);
}
function exactRecord(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value); }
function boundedQuery(value: unknown): value is string { return typeof value === "string" && value.trim().length >= 1 && value.length <= 16 * 1024 && !/[\u0000-\u001f\u007f]/.test(value); }
function optionalLimit(value: unknown, max: number): boolean { return value === undefined || (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max); }
