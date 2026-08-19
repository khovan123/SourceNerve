import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { writeFile } from "node:fs/promises";

import {
  DESKTOP_IPC,
  type DesktopError,
  type DesktopResult,
  type SupportBundleExportFormat,
} from "../shared/desktop-api";
import type { DiagnosticsManager } from "./diagnostics-manager";
import { validateDesktopIpcInvocation } from "./ipc-policy";

export function installDiagnosticsIpcHandlers(context: {
  manager(): DiagnosticsManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}): void {
  for (const channel of [
    DESKTOP_IPC.supportBundlePreview,
    DESKTOP_IPC.supportBundleExport,
    DESKTOP_IPC.recoveryState,
    DESKTOP_IPC.recoveryRebuildIndexes,
    DESKTOP_IPC.recoveryBackupCreateValidate,
    DESKTOP_IPC.recoveryBackupValidateLatest,
    DESKTOP_IPC.recoveryOpenStateDirectory,
    DESKTOP_IPC.recoveryOpenLogsDirectory,
    DESKTOP_IPC.recoveryResetUiSettings,
    DESKTOP_IPC.recoveryReadiness,
  ]) {
    ipcMain.removeHandler(channel);
  }

  secureHandle(context, DESKTOP_IPC.supportBundlePreview, async () =>
    invoke(context, (manager) => manager.previewSupportBundle()),
  );

  secureHandle(context, DESKTOP_IPC.supportBundleExport, async (args, event) => {
    const manager = context.manager();
    if (!manager) return unavailable();
    try {
      const selectionId = args[0] as string;
      const format = args[1] as SupportBundleExportFormat;
      const bundle = manager.exportBytes(selectionId, format);
      const parent = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: "Export SourceNerve support bundle",
        defaultPath: bundle.suggestedFileName,
        filters: [
          format === "zip"
            ? { name: "ZIP support bundle", extensions: ["zip"] }
            : { name: "Text support bundle", extensions: ["txt"] },
        ],
      };
      const destination = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (destination.canceled || !destination.filePath) {
        return ok({ saved: false as const, format, bytes: 0 });
      }
      await writeFile(destination.filePath, bundle.bytes, { flag: "w", mode: 0o600 });
      return ok({ saved: true as const, format, bytes: bundle.bytes.length });
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });

  secureHandle(context, DESKTOP_IPC.recoveryState, async () =>
    invoke(context, (manager) => manager.recoveryState()),
  );
  secureHandle(context, DESKTOP_IPC.recoveryRebuildIndexes, async () =>
    invoke(context, (manager) => manager.rebuildManagedIndexes()),
  );
  secureHandle(context, DESKTOP_IPC.recoveryBackupCreateValidate, async () =>
    invoke(context, (manager) => manager.createAndValidateStateBackup()),
  );
  secureHandle(context, DESKTOP_IPC.recoveryBackupValidateLatest, async () =>
    invoke(context, (manager) => manager.validateLatestStateBackup()),
  );
  secureHandle(context, DESKTOP_IPC.recoveryOpenStateDirectory, async () => {
    const manager = context.manager();
    if (!manager) return unavailable();
    const message = await shell.openPath(manager.stateDirectory());
    return message
      ? fail({ code: "service_error", message: "Operating system could not open the SourceNerve state directory", retryable: true })
      : ok({ opened: true as const });
  });
  secureHandle(context, DESKTOP_IPC.recoveryOpenLogsDirectory, async () => {
    const manager = context.manager();
    if (!manager) return unavailable();
    const message = await shell.openPath(manager.logsDirectory());
    return message
      ? fail({ code: "service_error", message: "Operating system could not open the SourceNerve logs directory", retryable: true })
      : ok({ opened: true as const });
  });
  secureHandle(context, DESKTOP_IPC.recoveryResetUiSettings, async () =>
    invoke(context, (manager) => manager.resetDesktopUiSettings()),
  );
  secureHandle(context, DESKTOP_IPC.recoveryReadiness, async () =>
    invoke(context, (manager) => manager.rerunReadiness()),
  );
}

function secureHandle(
  context: { isTrustedSender(event: IpcMainInvokeEvent): boolean },
  channel: string,
  handler: (args: readonly unknown[], event: IpcMainInvokeEvent) => Promise<DesktopResult<unknown>>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!context.isTrustedSender(event)) {
      return fail({ code: "forbidden", message: "Desktop IPC sender is not trusted", retryable: false });
    }
    const validationError = validateDesktopIpcInvocation(channel, args);
    if (validationError) {
      return fail({ code: "invalid_request", message: validationError, retryable: false });
    }
    return handler(args, event);
  });
}

async function invoke<T>(
  context: { manager(): DiagnosticsManager | null },
  operation: (manager: DiagnosticsManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.manager();
  if (!manager) return unavailable();
  try {
    return ok(await operation(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function unavailable<T = never>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Desktop diagnostics manager is not initialized",
    retryable: true,
  });
}

function toDesktopError(error: unknown): DesktopError {
  const message = error instanceof Error
    ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 512)
    : "Desktop diagnostics operation failed";
  return {
    code: /not initialized|unavailable|no ready managed/i.test(message) ? "not_ready" : "internal_error",
    message,
    retryable: /not initialized|unavailable|no ready managed/i.test(message),
  };
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
