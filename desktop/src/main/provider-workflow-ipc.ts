import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopError, DesktopResult } from "../shared/desktop-api";
import {
  PROVIDER_WORKFLOW_IPC,
  type ProviderIssueCreateInput,
  type ProviderPullCreateInput,
  type ProviderPullMergeInput,
  type ProviderPullRefreshInput,
} from "../shared/provider-workflow-api";
import { ProviderWorkflowHttpError } from "./provider-workflow-client";
import {
  ProviderWorkflowConflictError,
  type ProviderWorkflowManager,
} from "./provider-workflow-manager";
import { validateProviderWorkflowIpcInvocation } from "./provider-workflow-policy";
import { sanitizeRuntimeText } from "./runtime-log-store";

export interface ProviderWorkflowIpcContext {
  manager(): ProviderWorkflowManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installProviderWorkflowIpcHandlers(
  context: ProviderWorkflowIpcContext,
): void {
  for (const channel of Object.values(PROVIDER_WORKFLOW_IPC)) {
    ipcMain.removeHandler(channel);
  }

  secureHandle(context, PROVIDER_WORKFLOW_IPC.state, async (args) =>
    invoke(context, (manager) => manager.state(args[0] as string)));
  secureHandle(context, PROVIDER_WORKFLOW_IPC.issueCreate, async (args) =>
    invoke(context, (manager) => manager.createIssue(args[0] as ProviderIssueCreateInput)));
  secureHandle(context, PROVIDER_WORKFLOW_IPC.pullCreate, async (args) =>
    invoke(context, (manager) => manager.createPull(args[0] as ProviderPullCreateInput)));
  secureHandle(context, PROVIDER_WORKFLOW_IPC.pullRefresh, async (args) =>
    invoke(context, (manager) => manager.refreshPull((args[0] as ProviderPullRefreshInput).taskId)));
  secureHandle(context, PROVIDER_WORKFLOW_IPC.pullMerge, async (args) =>
    invoke(context, (manager) => manager.mergePull(args[0] as ProviderPullMergeInput)));
  secureHandle(context, PROVIDER_WORKFLOW_IPC.defaultSync, async (args) =>
    invoke(context, (manager) => manager.syncDefault(args[0] as string)));
}

function secureHandle(
  context: ProviderWorkflowIpcContext,
  channel: string,
  handler: (args: readonly unknown[]) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({
        code: "forbidden",
        message: "Desktop IPC sender is not trusted",
        retryable: false,
      });
    }
    const validation = validateProviderWorkflowIpcInvocation(channel, args);
    if (validation) {
      return fail({ code: "invalid_request", message: validation, retryable: false });
    }
    return handler(args);
  });
}

async function invoke<T>(
  context: ProviderWorkflowIpcContext,
  operation: (manager: ProviderWorkflowManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "Desktop provider workflow is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await operation(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof ProviderWorkflowConflictError) {
    return { code: "conflict", message: error.message, retryable: false };
  }
  if (error instanceof ProviderWorkflowHttpError) {
    if (error.status === 401) {
      return { code: "unauthorized", message: error.message, retryable: false };
    }
    if (error.status === 403) {
      return { code: "forbidden", message: error.message, retryable: false };
    }
    if (error.status === 404) {
      return { code: "not_found", message: error.message, retryable: false };
    }
    if (error.status === 409 || error.status === 422) {
      return { code: "conflict", message: error.message, retryable: false };
    }
    if (error.status >= 500) {
      return { code: "service_error", message: error.message, retryable: true };
    }
  }
  const message = sanitizeRuntimeText(
    error instanceof Error ? error.message : "Provider workflow failed",
    process.env.HOME,
  );
  if (/not connected|no explicit|must be|no provider|unavailable/i.test(message)) {
    return { code: "not_ready", message, retryable: false };
  }
  return { code: "service_error", message, retryable: true };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
