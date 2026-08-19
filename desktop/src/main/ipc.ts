import { BrowserWindow, ipcMain } from "electron";

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type DesktopError,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type RuntimeInfo,
} from "../shared/desktop-api";
import type { DaemonManager } from "./daemon-manager";
import { SourceNerveClient, SourceNerveHttpError } from "./sourcenerve-client";

export interface DesktopIpcContext {
  runtimeInfo(): Omit<RuntimeInfo, "apiVersion">;
  sourceNerveClient(): SourceNerveClient | null;
  daemonManager(): DaemonManager | null;
  operations: OperationRegistry;
}

export function installDesktopIpcHandlers(context: DesktopIpcContext): void {
  removeKnownHandlers();

  ipcMain.handle(DESKTOP_IPC.runtimeInfo, async () =>
    ok({ ...context.runtimeInfo(), apiVersion: DESKTOP_API_VERSION }),
  );
  ipcMain.handle(DESKTOP_IPC.daemonState, async () => {
    const manager = context.daemonManager();
    return manager
      ? ok(manager.snapshot())
      : fail({
          code: "not_ready",
          message: "SourceNerve daemon manager is not initialized",
          retryable: true,
        });
  });
  ipcMain.handle(DESKTOP_IPC.daemonStart, async () =>
    invokeDaemon(context, (manager) => manager.start()),
  );
  ipcMain.handle(DESKTOP_IPC.daemonStop, async () =>
    invokeDaemon(context, (manager) => manager.stop()),
  );
  ipcMain.handle(DESKTOP_IPC.daemonRestart, async () =>
    invokeDaemon(context, (manager) => manager.restart()),
  );
  ipcMain.handle(DESKTOP_IPC.daemonAttachExternal, async () =>
    invokeDaemon(context, (manager) => manager.attachExternal()),
  );
  ipcMain.handle(DESKTOP_IPC.daemonHealth, async () =>
    invokeClient(context, (client) => client.health()),
  );
  ipcMain.handle(DESKTOP_IPC.serviceStatus, async () =>
    invokeClient(context, (client) => client.serviceStatus()),
  );
  ipcMain.handle(DESKTOP_IPC.readiness, async () =>
    invokeClient(context, (client) => client.readiness()),
  );
  ipcMain.handle(DESKTOP_IPC.listWorkspaces, async () =>
    invokeClient(context, (client) => client.listWorkspaces()),
  );
  ipcMain.handle(DESKTOP_IPC.cancelOperation, async (_event, operationId: unknown) => {
    if (!validOperationId(operationId)) {
      return fail({
        code: "invalid_request",
        message: "operationId must be 1-128 letters, numbers, '.', '_' or '-'",
        retryable: false,
        fieldDetails: { operationId: "invalid operation identifier" },
      });
    }
    return ok({ cancelled: context.operations.cancel(operationId) });
  });
}

export function publishRuntimeEvent(event: DesktopRuntimeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC.runtimeEvent, event);
    }
  }
}

export class OperationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  start(operationId: string): AbortSignal {
    if (!validOperationId(operationId)) {
      throw new Error("invalid Desktop operation ID");
    }
    if (this.controllers.has(operationId)) {
      throw new Error("Desktop operation ID is already active");
    }
    const controller = new AbortController();
    this.controllers.set(operationId, controller);
    return controller.signal;
  }

  finish(operationId: string): void {
    this.controllers.delete(operationId);
  }

  cancel(operationId: string): boolean {
    const controller = this.controllers.get(operationId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(operationId);
    return true;
  }
}

async function invokeClient<T>(
  context: DesktopIpcContext,
  invoke: (client: SourceNerveClient) => Promise<T>,
): Promise<DesktopResult<T>> {
  const client = context.sourceNerveClient();
  if (!client) {
    return fail({
      code: "not_ready",
      message: "SourceNerve local runtime is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await invoke(client));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function invokeDaemon<T>(
  context: DesktopIpcContext,
  invoke: (manager: DaemonManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.daemonManager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "SourceNerve daemon manager is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await invoke(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof SourceNerveHttpError) {
    if (error.status === 401) {
      return { code: "unauthorized", message: error.message, retryable: true };
    }
    if (error.status === 403) {
      return { code: "forbidden", message: error.message, retryable: false };
    }
    if (error.status === 404) {
      return { code: "not_found", message: error.message, retryable: false };
    }
    if (error.status >= 500) {
      return { code: "service_error", message: error.message, retryable: true };
    }
    return { code: "transport_error", message: error.message, retryable: true };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "timeout", message: "SourceNerve request timed out", retryable: true };
  }
  if (error instanceof TypeError) {
    return {
      code: "transport_error",
      message: "SourceNerve local service is unavailable",
      retryable: true,
    };
  }
  const message = error instanceof Error ? sanitizeMessage(error.message) : "Desktop operation failed";
  if (/not initialized|not configured|no external SourceNerve daemon/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  if (/cannot stop|cannot restart|different local credential|already running/i.test(message)) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (/incompatible|did not terminate|readiness timeout/i.test(message)) {
    return { code: "service_error", message, retryable: false };
  }
  return { code: "internal_error", message, retryable: false };
}

function sanitizeMessage(message: string): string {
  const bounded = message.replace(/[\r\n\0]/g, " ").slice(0, 512).trim();
  return bounded || "Desktop operation failed";
}

function validOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}

function removeKnownHandlers(): void {
  for (const channel of [
    DESKTOP_IPC.runtimeInfo,
    DESKTOP_IPC.daemonState,
    DESKTOP_IPC.daemonStart,
    DESKTOP_IPC.daemonStop,
    DESKTOP_IPC.daemonRestart,
    DESKTOP_IPC.daemonAttachExternal,
    DESKTOP_IPC.daemonHealth,
    DESKTOP_IPC.serviceStatus,
    DESKTOP_IPC.readiness,
    DESKTOP_IPC.listWorkspaces,
    DESKTOP_IPC.cancelOperation,
  ]) {
    ipcMain.removeHandler(channel);
  }
}
