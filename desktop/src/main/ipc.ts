import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type Auth0SessionView,
  type DesktopError,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type RuntimeInfo,
  type WorkspaceSaveInput,
} from "../shared/desktop-api";
import type { Auth0Manager } from "./auth0-manager";
import type { DaemonManager } from "./daemon-manager";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  isValidOperationId,
  isValidWorkspaceId,
  validateDesktopIpcInvocation,
} from "./ipc-policy";
import { SourceNerveClient, SourceNerveHttpError } from "./sourcenerve-client";
import type { WorkspaceGrantManager } from "./workspace-grant-manager";
import { WorkspaceManager, WorkspaceManagerError } from "./workspace-manager";

export interface DesktopIpcContext {
  runtimeInfo(): Omit<RuntimeInfo, "apiVersion">;
  sourceNerveClient(): SourceNerveClient | null;
  daemonManager(): DaemonManager | null;
  workspaceManager(): WorkspaceManager | null;
  auth0Manager(): Auth0Manager | null;
  workspaceGrantManager(): WorkspaceGrantManager | null;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  operations: OperationRegistry;
}

export function installDesktopIpcHandlers(context: DesktopIpcContext): void {
  removeKnownHandlers();

  secureHandle(context, DESKTOP_IPC.runtimeInfo, async () =>
    ok({ ...context.runtimeInfo(), apiVersion: DESKTOP_API_VERSION }),
  );
  secureHandle(context, DESKTOP_IPC.daemonState, async () => {
    const manager = context.daemonManager();
    return manager
      ? ok(manager.snapshot())
      : fail({
          code: "not_ready",
          message: "SourceNerve daemon manager is not initialized",
          retryable: true,
        });
  });
  secureHandle(context, DESKTOP_IPC.daemonStart, async () =>
    invokeDaemon(context, (manager) => manager.start()),
  );
  secureHandle(context, DESKTOP_IPC.daemonStop, async () =>
    invokeDaemon(context, (manager) => manager.stop()),
  );
  secureHandle(context, DESKTOP_IPC.daemonRestart, async () =>
    invokeDaemon(context, (manager) => manager.restart()),
  );
  secureHandle(context, DESKTOP_IPC.daemonAttachExternal, async () =>
    invokeDaemon(context, (manager) => manager.attachExternal()),
  );
  secureHandle(context, DESKTOP_IPC.daemonHealth, async () =>
    invokeClient(context, (client) => client.health()),
  );
  secureHandle(context, DESKTOP_IPC.serviceStatus, async () =>
    invokeClient(context, (client) => client.serviceStatus()),
  );
  secureHandle(context, DESKTOP_IPC.readiness, async () =>
    invokeClient(context, (client) => client.readiness()),
  );
  secureHandle(context, DESKTOP_IPC.listWorkspaces, async () =>
    invokeClient(context, (client) => client.listWorkspaces()),
  );
  secureHandle(context, DESKTOP_IPC.workspacePickRepository, async (_args, event) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const parent = BrowserWindow.fromWebContents(event.sender);
    const selection = parent
      ? await dialog.showOpenDialog(parent, {
          title: "Choose Git repository",
          properties: ["openDirectory"],
        })
      : await dialog.showOpenDialog({
          title: "Choose Git repository",
          properties: ["openDirectory"],
        });
    if (selection.canceled || selection.filePaths.length !== 1) return ok(null);
    return invokeWorkspaceManager(manager, () => manager.stageRepositorySelection(selection.filePaths[0]));
  });
  secureHandle(context, DESKTOP_IPC.workspaceListManaged, async () => {
    const manager = context.workspaceManager();
    return manager
      ? invokeWorkspaceManager(manager, () => manager.listManagedWorkspaces())
      : workspaceManagerUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.workspaceSave, async (args) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const result = await invokeWorkspaceManager(manager, () => manager.saveWorkspace(args[0] as WorkspaceSaveInput));
    if (result.ok) await synchronizeWorkspaceGrants(context);
    return result;
  });
  secureHandle(context, DESKTOP_IPC.workspaceRemove, async (args) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const workspaceId = args[0];
    if (!isValidWorkspaceId(workspaceId)) {
      return fail({
        code: "invalid_request",
        message: "workspaceId is invalid",
        retryable: false,
      });
    }
    const result = await invokeWorkspaceManager(manager, () => manager.removeWorkspace(workspaceId));
    if (result.ok) await synchronizeWorkspaceGrants(context);
    return result;
  });
  secureHandle(context, DESKTOP_IPC.workspaceIndex, async (args) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const workspaceId = args[0];
    if (!isValidWorkspaceId(workspaceId)) {
      return fail({
        code: "invalid_request",
        message: "workspaceId is invalid",
        retryable: false,
      });
    }
    return invokeWorkspaceManager(manager, () => manager.indexWorkspace(workspaceId));
  });
  secureHandle(context, DESKTOP_IPC.auth0State, async () => auth0State(context));
  secureHandle(context, DESKTOP_IPC.auth0SignIn, async () =>
    invokeAuth0(context, (manager) => manager.signIn(), false),
  );
  secureHandle(context, DESKTOP_IPC.auth0Refresh, async () =>
    invokeAuth0(context, (manager) => manager.refresh(), true),
  );
  secureHandle(context, DESKTOP_IPC.auth0Logout, async () =>
    invokeAuth0(context, (manager) => manager.logout(), false),
  );
  secureHandle(context, DESKTOP_IPC.cancelOperation, async (args) => {
    const operationId = args[0];
    if (!isValidOperationId(operationId)) {
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

export function publishRuntimeEvent(
  targetWindow: BrowserWindow | null,
  event: DesktopRuntimeEvent,
): void {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send(DESKTOP_IPC.runtimeEvent, event);
}

export class OperationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  start(operationId: string): AbortSignal {
    if (!isValidOperationId(operationId)) {
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

function secureHandle(
  context: DesktopIpcContext,
  channel: string,
  handler: (
    args: readonly unknown[],
    event: IpcMainInvokeEvent,
  ) => Promise<DesktopResult<unknown>>,
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
      return fail({
        code: "invalid_request",
        message: validationError,
        retryable: false,
      });
    }
    return handler(args, event);
  });
}

async function auth0State(context: DesktopIpcContext): Promise<DesktopResult<Auth0SessionView>> {
  const manager = context.auth0Manager();
  if (!manager) return auth0ManagerUnavailable();
  return ok(decorateAuth0State(manager.state(), context.workspaceGrantManager()));
}

async function invokeAuth0(
  context: DesktopIpcContext,
  invoke: (manager: Auth0Manager) => Promise<Auth0SessionView>,
  reconcileGrants: boolean,
): Promise<DesktopResult<Auth0SessionView>> {
  const manager = context.auth0Manager();
  if (!manager) return auth0ManagerUnavailable();
  try {
    const state = await invoke(manager);
    const grants = context.workspaceGrantManager();
    if (reconcileGrants && state.status === "authenticated" && state.identity && grants) {
      await grants.grantCurrentIdentity(state.identity);
    }
    return ok(decorateAuth0State(state, grants));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function decorateAuth0State(
  state: Auth0SessionView,
  grants: WorkspaceGrantManager | null,
): Auth0SessionView {
  if (state.status !== "authenticated" || !state.identity || !grants) return state;
  return {
    ...state,
    workspaceGrants: grants.effectiveFor(state.identity.subject).map((grant) => ({
      workspace: grant.workspace,
      access: grant.access,
    })),
  };
}

async function synchronizeWorkspaceGrants(context: DesktopIpcContext): Promise<void> {
  const grants = context.workspaceGrantManager();
  if (!grants) return;
  const authState = context.auth0Manager()?.state();
  await grants.workspaceChanged(
    authState?.status === "authenticated" && authState.identity ? authState.identity : undefined,
  );
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

async function invokeWorkspaceManager<T>(
  _manager: WorkspaceManager,
  invoke: () => Promise<T>,
): Promise<DesktopResult<T>> {
  try {
    return ok(await invoke());
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

function workspaceManagerUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Desktop workspace manager is not initialized",
    retryable: true,
  });
}

function auth0ManagerUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "SourceNerve account manager is not initialized",
    retryable: true,
  });
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof WorkspaceManagerError) return error.desktopError;
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

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}

function removeKnownHandlers(): void {
  for (const channel of DESKTOP_INBOUND_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}
