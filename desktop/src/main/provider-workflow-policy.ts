import type { ProviderPullListInput, ProviderPullOpenInput } from "../shared/provider-workflow-api";
import { PROVIDER_WORKFLOW_IPC } from "../shared/provider-workflow-api";

const PULL_LIST_STATES = new Set(["open", "closed", "all"]);

export const PROVIDER_WORKFLOW_INBOUND_IPC_CHANNELS = Object.freeze(
  Object.values(PROVIDER_WORKFLOW_IPC),
);

export function validateProviderWorkflowIpcInvocation(
  channel: string,
  args: readonly unknown[],
): string | null {
  if (channel === PROVIDER_WORKFLOW_IPC.pullList) {
    return args.length === 1 && isPullListInput(args[0])
      ? null
      : "provider pull list input is invalid";
  }
  if (channel === PROVIDER_WORKFLOW_IPC.pullOpen) {
    return args.length === 1 && isPullOpenInput(args[0])
      ? null
      : "provider pull URL is invalid";
  }
  return "provider workflow IPC channel is not allowlisted";
}

export function isPullListInput(value: unknown): value is ProviderPullListInput {
  if (!isRecord(value) || !exactKeys(value, ["workspace", "state", "limit"])) return false;
  if (typeof value.workspace !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.workspace)) return false;
  if (typeof value.state !== "string" || !PULL_LIST_STATES.has(value.state)) return false;
  return value.limit === undefined || (Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100);
}

export function isPullOpenInput(value: unknown): value is ProviderPullOpenInput {
  if (!isRecord(value) || !exactKeys(value, ["url"]) || typeof value.url !== "string") return false;
  try {
    const url = new URL(value.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return false;
    if (url.hostname === "github.com") return /\/pull\/\d+\/?$/.test(url.pathname);
    if (url.hostname === "gitlab.com") return /\/-\/merge_requests\/\d+\/?$/.test(url.pathname);
    return false;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
