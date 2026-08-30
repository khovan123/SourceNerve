import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  AGENT_IPC,
  type DesktopAgentEvaluationListInput,
  type DesktopAgentEvaluateInput,
  type DesktopAgentMemoryPreviewInput,
  type DesktopAgentTurnListInput,
} from "../shared/agent-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";
import { sanitizeRuntimeText } from "./runtime-log-store";
import { SourceNerveHttpError } from "./sourcenerve-client";
import type { DesktopAgentManager } from "./agent-manager";

export interface AgentIpcContext {
  manager(): DesktopAgentManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installAgentIpcHandlers(context: AgentIpcContext): void {
  for (const channel of Object.values(AGENT_IPC)) ipcMain.removeHandler(channel);
  secureHandle(context, AGENT_IPC.listTurns, async (args) => invoke(context, (manager) => manager.listTurns(args[0] as DesktopAgentTurnListInput)));
  secureHandle(context, AGENT_IPC.memoryPreview, async (args) => invoke(context, (manager) => manager.previewMemory(args[0] as DesktopAgentMemoryPreviewInput)));
  secureHandle(context, AGENT_IPC.evaluate, async (args) => invoke(context, (manager) => manager.evaluate(args[0] as DesktopAgentEvaluateInput)));
  secureHandle(context, AGENT_IPC.listEvaluations, async (args) => invoke(context, (manager) => manager.listEvaluations(args[0] as DesktopAgentEvaluationListInput)));
}

function secureHandle(
  context: AgentIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) return fail({ code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false });
    const validation = validateDesktopIpcInvocation(channel, args);
    if (validation) return fail({ code: "invalid_request", message: validation, retryable: false });
    return handler(args);
  });
}

async function invoke<T>(context: AgentIpcContext, operation: (manager: DesktopAgentManager) => Promise<T>): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) return fail({ code: "not_ready", message: "Desktop agent runtime is not initialized", retryable: true });
  try {
    return ok(await operation(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof SourceNerveHttpError) {
    if (error.status === 401) return { code: "unauthorized", message: error.message, retryable: false };
    if (error.status === 403) return { code: "forbidden", message: error.message, retryable: false };
    if (error.status === 404) return { code: "not_found", message: error.message, retryable: false };
    if (error.status === 409) return { code: "conflict", message: error.message, retryable: false };
    if (error.status >= 500) return { code: "service_error", message: error.message, retryable: true };
    return { code: "invalid_request", message: error.message, retryable: false };
  }
  const message = sanitizeRuntimeText(error instanceof Error ? error.message : "Agent operation failed", process.env.HOME);
  return { code: "service_error", message, retryable: true };
}

function ok<T>(value: T): DesktopResult<T> { return { ok: true, value }; }
function fail<T>(error: DesktopError): DesktopResult<T> { return { ok: false, error }; }
