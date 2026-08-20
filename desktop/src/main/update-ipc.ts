import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import type { DesktopResult } from "../shared/desktop-api";
import { UPDATE_IPC, type DesktopUpdateView } from "../shared/update-api";
import { DesktopUpdateManager } from "./update-manager";

export interface UpdateIpcContext {
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

let updateManager: DesktopUpdateManager | null = null;
let unsubscribe: (() => void) | null = null;

export function installUpdateIpcHandlers(context: UpdateIpcContext): void {
  for (const channel of [UPDATE_IPC.state, UPDATE_IPC.check, UPDATE_IPC.download, UPDATE_IPC.restart]) {
    ipcMain.removeHandler(channel);
  }

  updateManager ??= new DesktopUpdateManager();
  updateManager.initialize();
  unsubscribe?.();
  unsubscribe = updateManager.subscribe((view) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(UPDATE_IPC.event, view);
    }
  });

  ipcMain.handle(UPDATE_IPC.state, async (event, ...args) => {
    const rejected = reject(context, event, args);
    if (rejected) return rejected;
    return ok(updateManager!.snapshot());
  });

  ipcMain.handle(UPDATE_IPC.check, async (event, ...args) => {
    const rejected = reject(context, event, args);
    if (rejected) return rejected;
    return ok(await updateManager!.check());
  });

  ipcMain.handle(UPDATE_IPC.download, async (event, ...args) => {
    const rejected = reject(context, event, args);
    if (rejected) return rejected;
    return ok(await updateManager!.download());
  });

  ipcMain.handle(UPDATE_IPC.restart, async (event, ...args) => {
    const rejected = reject(context, event, args);
    if (rejected) return rejected;
    try {
      return ok(updateManager!.restartToUpdate());
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Unable to restart into the update.", false);
    }
  });
}

function reject(
  context: UpdateIpcContext,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
): DesktopResult<never> | null {
  if (!context.isTrustedSender(event)) {
    return {
      ok: false,
      error: { code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false },
    };
  }
  if (args.length !== 0) {
    return {
      ok: false,
      error: { code: "invalid_request", message: "Desktop update operation does not accept arguments", retryable: false },
    };
  }
  return null;
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T>(message: string, retryable: boolean): DesktopResult<T> {
  return {
    ok: false,
    error: {
      code: "service_error",
      message: message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1024),
      retryable,
    },
  };
}

export function currentDesktopUpdateState(): DesktopUpdateView | null {
  return updateManager?.snapshot() ?? null;
}
