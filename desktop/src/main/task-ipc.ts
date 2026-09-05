import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  HARNESS_IPC,
  type DesktopHarnessCodexAccountInput,
  type DesktopHarnessCodexTurnInput,
  type DesktopHarnessContextRouteInput,
  type DesktopHarnessEventsInput,
  type DesktopHarnessRunBeginInput,
  type DesktopHarnessJobCancelInput,
  type DesktopHarnessJobListInput,
  type DesktopHarnessRunIdInput,
  type DesktopHarnessRunListInput,
} from "../shared/harness-api";
import {
  HARNESS_APPROVAL_IPC,
  type DesktopHarnessApprovalListInput,
  type DesktopHarnessApprovalRespondInput,
} from "../shared/harness-approval-api";
import { TASK_IPC, type DesktopTaskApplyInput, type DesktopTaskBeginInput, type DesktopTaskBranchInput, type DesktopTaskCommitInput, type DesktopTaskFileReadInput, type DesktopTaskProposeInput } from "../shared/task-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";
import { sanitizeRuntimeText } from "./runtime-log-store";
import { SourceNerveHttpError } from "./sourcenerve-client";
import type { DesktopTaskManager } from "./task-manager";

export interface TaskIpcContext {
  manager(): DesktopTaskManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installTaskIpcHandlers(context: TaskIpcContext): void {
  for (const channel of [...Object.values(TASK_IPC), ...Object.values(HARNESS_IPC), ...Object.values(HARNESS_APPROVAL_IPC)]) ipcMain.removeHandler(channel);

  secureHandle(context, HARNESS_IPC.contextRoute, async (args) => invoke(context, (manager) => manager.routeHarnessContext(args[0] as DesktopHarnessContextRouteInput)));
  secureHandle(context, HARNESS_IPC.beginRun, async (args) => invoke(context, (manager) => manager.beginHarnessRun(args[0] as DesktopHarnessRunBeginInput)));
  secureHandle(context, HARNESS_IPC.listRuns, async (args) => invoke(context, (manager) => manager.listHarnessRuns((args[0] ?? {}) as DesktopHarnessRunListInput)));
  secureHandle(context, HARNESS_IPC.getRun, async (args) => invoke(context, (manager) => manager.getHarnessRun(args[0] as DesktopHarnessRunIdInput)));
  secureHandle(context, HARNESS_IPC.listEvents, async (args) => invoke(context, (manager) => manager.listHarnessEvents(args[0] as DesktopHarnessEventsInput)));
  secureHandle(context, HARNESS_IPC.listJobs, async (args) => invoke(context, (manager) => manager.listHarnessJobs(args[0] as DesktopHarnessJobListInput)));
  secureHandle(context, HARNESS_IPC.cancelRun, async (args) => invoke(context, (manager) => manager.cancelHarnessRun(args[0] as DesktopHarnessRunIdInput)));
  secureHandle(context, HARNESS_IPC.cancelJob, async (args) => invoke(context, (manager) => manager.cancelHarnessJob(args[0] as DesktopHarnessJobCancelInput)));
  secureHandle(context, HARNESS_IPC.codexSetupStatus, async () => invoke(context, (manager) => manager.getHarnessCodexSetup()));
  secureHandle(context, HARNESS_IPC.codexInstall, async () => invoke(context, (manager) => manager.installHarnessCodex()));
  secureHandle(context, HARNESS_IPC.codexLogin, async () => invoke(context, (manager) => manager.loginHarnessCodex()));
  secureHandle(context, HARNESS_IPC.codexAccount, async (args) => invoke(context, (manager) => manager.getHarnessCodexAccount(args[0] as DesktopHarnessCodexAccountInput)));
  secureHandle(context, HARNESS_IPC.codexTurn, async (args) => invoke(context, (manager) => manager.runHarnessCodexTurn(args[0] as DesktopHarnessCodexTurnInput)));

  secureHandle(context, TASK_IPC.list, async () => invoke(context, (manager) => manager.list()));
  secureHandle(context, TASK_IPC.begin, async (args) => invoke(context, (manager) => manager.begin(args[0] as DesktopTaskBeginInput)));
  secureHandle(context, TASK_IPC.readFile, async (args) => invoke(context, (manager) => manager.readFile(args[0] as DesktopTaskFileReadInput)));
  secureHandle(context, TASK_IPC.remember, async (args) => invoke(context, (manager) => manager.remember(args[0] as string)));
  secureHandle(context, TASK_IPC.get, async (args) => invoke(context, (manager) => manager.get(args[0] as string)));
  secureHandle(context, TASK_IPC.cancel, async (args) => invoke(context, (manager) => manager.cancel(args[0] as string)));
  secureHandle(context, TASK_IPC.branch, async (args) => invoke(context, (manager) => manager.checkoutBranch(args[0] as DesktopTaskBranchInput)));
  secureHandle(context, TASK_IPC.propose, async (args) => invoke(context, (manager) => manager.propose(args[0] as DesktopTaskProposeInput)));
  secureHandle(context, TASK_IPC.apply, async (args) => invoke(context, (manager) => manager.apply(args[0] as DesktopTaskApplyInput)));
  secureHandle(context, TASK_IPC.review, async (args) => invoke(context, (manager) => manager.review(args[0] as string)));
  secureHandle(context, TASK_IPC.commit, async (args) => invoke(context, (manager) => manager.commit(args[0] as DesktopTaskCommitInput)));
  secureHandle(context, TASK_IPC.push, async (args) => invoke(context, (manager) => manager.push(args[0] as string)));
  secureHandle(context, HARNESS_APPROVAL_IPC.list, async (args) => invoke(context, (manager) => manager.listHarnessApprovals(args[0] as DesktopHarnessApprovalListInput)));
  secureHandle(context, HARNESS_APPROVAL_IPC.respond, async (args) => invoke(context, (manager) => manager.respondHarnessApproval(args[0] as DesktopHarnessApprovalRespondInput)));
}

function secureHandle(
  context: TaskIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({ code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false });
    }
    const validation = validateDesktopIpcInvocation(channel, args);
    if (validation) return fail({ code: "invalid_request", message: validation, retryable: false });
    return handler(args);
  });
}

async function invoke<T>(
  context: TaskIpcContext,
  operation: (manager: DesktopTaskManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) return fail({ code: "not_ready", message: "Desktop task workflow is not initialized", retryable: true });
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
  const message = sanitizeRuntimeText(error instanceof Error ? error.message : "Task workflow failed", process.env.HOME);
  if (/read-only|must be|invalid|mismatch|different|no longer|cannot|stale|changed/i.test(message)) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (/not initialized|not a ready|unavailable/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  return { code: "service_error", message, retryable: true };
}

function ok<T>(value: T): DesktopResult<T> { return { ok: true, value }; }
function fail<T>(error: DesktopError): DesktopResult<T> { return { ok: false, error }; }
