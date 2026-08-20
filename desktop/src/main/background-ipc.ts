import { ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  DESKTOP_IPC,
  type DesktopBehaviorPreferences,
  type DesktopResult,
} from "../shared/desktop-api";
import type { BackgroundController } from "./background-controller";
import { validateDesktopIpcInvocation } from "./ipc-policy";
import { installUpdateIpcHandlers } from "./update-ipc";

export interface BackgroundIpcContext {
  controller(): BackgroundController | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function installBackgroundIpcHandlers(context: BackgroundIpcContext): void {
  ipcMain.removeHandler(DESKTOP_IPC.desktopBehavior);
  ipcMain.removeHandler(DESKTOP_IPC.desktopBehaviorUpdate);

  ipcMain.handle(DESKTOP_IPC.desktopBehavior, async (event, ...args) => {
    const rejected = validateInvocation(context, event, DESKTOP_IPC.desktopBehavior, args);
    if (rejected) return rejected;
    const controller = context.controller();
    return controller
      ? ok(controller.preferences())
      : fail("Desktop background controller is not initialized", true);
  });

  ipcMain.handle(DESKTOP_IPC.desktopBehaviorUpdate, async (event, ...args) => {
    const rejected = validateInvocation(context, event, DESKTOP_IPC.desktopBehaviorUpdate, args);
    if (rejected) return rejected;
    const controller = context.controller();
    if (!controller) return fail("Desktop background controller is not initialized", true);
    try {
      return ok(await controller.updatePreferences(args[0] as DesktopBehaviorPreferences));
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Desktop behavior update failed", false);
    }
  });

  installUpdateIpcHandlers({ isTrustedSender: context.isTrustedSender });
}

function validateInvocation(
  context: BackgroundIpcContext,
  event: IpcMainInvokeEvent,
  channel: string,
  args: readonly unknown[],
): DesktopResult<never> | null {
  if (!context.isTrustedSender(event)) {
    return {
      ok: false,
      error: { code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false },
    };
  }
  const error = validateDesktopIpcInvocation(channel, args);
  return error
    ? { ok: false, error: { code: "invalid_request", message: error, retryable: false } }
    : null;
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string, retryable: boolean): DesktopResult<T> {
  return { ok: false, error: { code: "service_error", message, retryable } };
}
