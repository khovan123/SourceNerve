import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type Auth0SessionView,
  type DesktopError,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type ManagedWorkspaceInput,
  type RuntimeInfo,
} from "../shared/desktop-api";
import type { Auth0Manager } from "./auth0-manager";
import type { DaemonManager } from "./daemon-manager";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  isValidOperationId,
  validateDesktopIpcInvocation,
} from "./ipc-policy";
import { SourceNerveClient, SourceNerveHttpError } from "./sourcenerve-client";
import type { WorkspaceGrantManager } from "./workspace-grant-manager";
import { WorkspaceManager, WorkspaceValidationError } from "./workspace-manager";

export interface DesktopIpcContext {
  runtimeInfo(): Omit<RuntimeInfo, "apiVersion">;
  sourceNerveClient(): SourceNerveClient | null;
  daemonManager(): DaemonManager | null;
  workspaceManager(): WorkspaceManager | null;
  auth0Manager(): Auth0Manager | null;
  workspaceGrantManager(): WorkspaceGrantManager | null;
  pickWorkspaceDirectory(): Promise<string | null>;
  isWorkspaceRootAuthorized(root: string): Promise<boolean>;
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
  secureHandle(context, DESKTOP_IPC.workspacePickDirectory, async () => {
    try {
      const selected = await context.pickWorkspaceDirectory();
      return ok(selected ? { path: selected } : null);
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });
  secureHandle(context, DESKTOP_IPC.workspaceManagedList, async () =>
    invokeWorkspace(context, (manager) => manager.list()),
  );
  secureHandle(context, DESKTOP_IPC.workspaceValidate, async (args) => {
    const input = args[0] as ManagedWorkspaceInput;
    if (!(await context.isWorkspaceRootAuthorized(input.root))) {
      return fail({
        code: "forbidden",
        message: "Repository root must be selected through the Desktop directory picker",
        retryable: false,
      });
    }
    return invokeWorkspace(context, (manager) => manager.validate(input, input.id));
  });
  secureHandle(context, DESKTOP_IPC.workspaceSave, async (args) => {
    const input = args[0] as ManagedWorkspaceInput;
    if (!(await context.isWorkspaceRootAuthorized(input.root))) {
      return fail({
        code: "forbidden",
        message: "Repository root must be selected through the Desktop directory picker",
        retryable: false,
      });
    }
    return invokeWorkspace(context, async (manager) => {
      const saved = await manager.save(input);
      await reconcileWorkspaceGrants(context);
      return saved;
    });
  });
  secureHandle(context, DESKTOP_IPC.workspaceRemove, async (args) =>
    invokeWorkspace(context, async (manager) => {
      const removed = await manager.remove(args[0] as string);
      if (removed) await reconcileWorkspaceGrants(context);
      return { removed };
    }),
  );
  secureHandle(context, DESKTOP_IPC.workspaceIndex, async (args) =>
    invokeWorkspace(context, (manager) => manager.index(args[0] as string)),
  );

  secureHandle(context, DESKTOP_IPC.auth0State, async () => {
    const manager = context.auth0Manager();
    if (!manager) {
      return fail({
        code: "not_ready",
        message: "SourceNerve Auth0 session manager is not initialized",
        retryable: true,
      });
    }
    return ok(decorateAuthState(context, manager.state()));
  });
  secureHandle(context, DESKTOP_IPC.auth0SignIn, async () =>
    invokeAuth(context, async (manager) => decorateAuthState(context, await manager.signIn())),
  );
  secureHandle(context, DESKTOP_IPC.auth0Refresh, async () =>
    invokeAuth(context, async (manager) => {
      const state = await manager.refresh();
      if (state.status === "authenticated" && state.identity) {
        const grants = context.workspaceGrantManager();
        if (grants) await grants.grantCurrentIdentity(state.identity);
      }
      return decorateAuthState(context, state);
    }),
  );
  secureHandle(context, DESKTOP_IPC.auth0Logout, async () =>
    invokeAuth(context, async (manager) => decorateAuthState(context, await manager.logout())),
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
    const validationError = validateDesktopIpcInvocation(channel, args);
    if (validationError) {
      return fail({
        code: "invalid_request",
        message: validationError,
        retryable: false,
      });
    }
    return handler(args);
  });
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

async function invokeWorkspace<T>(
  context: DesktopIpcContext,
  invoke: (manager: WorkspaceManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.workspaceManager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "Desktop workspace manager is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await invoke(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function invokeAuth<T>(
  context: DesktopIpcContext,
  invoke: (manager: Auth0Manager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.auth0Manager();
  if (!manager) {
    return fail({
      code: "not_ready",
      message: "SourceNerve Auth0 session manager is not initialized",
      retryable: true,
    });
  }
  try {
    return ok(await invoke(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function reconcileWorkspaceGrants(context: DesktopIpcContext): Promise<void> {
  const grants = context.workspaceGrantManager();
  if (!grants) return;
  const auth = context.auth0Manager()?.state();
  await grants.workspaceChanged(auth?.status === "authenticated" ? auth.identity : undefined);
}

function decorateAuthState(context: DesktopIpcContext, state: Auth0SessionView): Auth0SessionView {
  if (state.status !== "authenticated" || !state.identity) return state;
  const grants = context.workspaceGrantManager()?.effectiveFor(state.identity.subject) ?? [];
  return {
    ...state,
    workspaceGrants: grants.map((grant) => ({ workspace: grant.workspace, access: grant.access })),
  };
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof WorkspaceValidationError) {
    return {
      code: "invalid_request",
      message: error.message,
      retryable: false,
      fieldDetails: Object.fromEntries(
        error.validation.errors.slice(0, 16).map((message, index) => [`workspace.${index}`, message]),
      ),
    };
  }
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
  if (/not initialized|not configured|must be ready|external SourceNerve daemon|client ID is not configured/i.test(message)) {
    return { code: "not_ready", message, retryable: true };
  }
  if (/state mismatch|no active sign-in|invalid workspace|cannot stop|cannot restart|different local credential|already running/i.test(message)) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (/incompatible|did not terminate|readiness timeout|JWT signature|issuer mismatch|audience mismatch/i.test(message)) {
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
