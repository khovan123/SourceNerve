import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";

import {
  DESKTOP_IPC,
  type DesktopError,
  type DesktopResult,
  type LegacyImportApplyInput,
} from "../shared/desktop-api";
import { validateDesktopIpcInvocation } from "./ipc-policy";
import type { MigrationManager } from "./migration-manager";
import { WorkspaceManagerError } from "./workspace-manager";

export function installMigrationIpcHandlers(context: {
  manager(): MigrationManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  onApplied(): Promise<void>;
}): void {
  ipcMain.removeHandler(DESKTOP_IPC.legacyImportPick);
  ipcMain.removeHandler(DESKTOP_IPC.legacyImportApply);

  secureHandle(context, DESKTOP_IPC.legacyImportPick, async (_args, event) => {
    const manager = context.manager();
    if (!manager) return unavailable();
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Import existing SourceNerve setup",
      properties: ["openFile"],
      filters: [{ name: "SourceNerve config", extensions: ["toml"] }],
    };
    const selection = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || selection.filePaths.length !== 1) return ok(null);
    try {
      return ok(await manager.stage(selection.filePaths[0]));
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });

  secureHandle(context, DESKTOP_IPC.legacyImportApply, async (args) => {
    const manager = context.manager();
    if (!manager) return unavailable();
    try {
      const result = await manager.apply(args[0] as LegacyImportApplyInput);
      await context.onApplied();
      return ok(result);
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });
}

function secureHandle(
  context: { isTrustedSender(event: IpcMainInvokeEvent): boolean },
  channel: string,
  handler: (args: readonly unknown[], event: IpcMainInvokeEvent) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({
        code: "forbidden",
        message: "Desktop IPC sender is not trusted",
        retryable: false,
      });
    }
    const validationError = validateDesktopIpcInvocation(channel, args);
    if (validationError) {
      return fail({ code: "invalid_request", message: validationError, retryable: false });
    }
    return handler(args, event);
  });
}

function unavailable(): DesktopResult<never> {
  return fail({
    code: "not_ready",
    message: "Desktop migration manager is not initialized",
    retryable: true,
  });
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof WorkspaceManagerError) return error.desktopError;
  const message = error instanceof Error
    ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 512)
    : "Desktop migration failed";
  return {
    code: "internal_error",
    message,
    retryable: false,
  };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
