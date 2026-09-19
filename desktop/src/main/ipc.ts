import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from "electron";

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type DesktopError,
  type DesktopResult,
  type ChromeExtensionBridgeState,
  type DesktopControlObservation,
  type DesktopControlObserveInput,
  type DesktopControlPermissions,
  type DesktopControlRunInput,
  type DesktopControlRunResult,
  type DesktopControlState,
  type DesktopRuntimeEvent,
  type RuntimeInfo,
  type WorkspaceSaveInput,
} from "../shared/desktop-api";
import type { DaemonManager } from "./daemon-manager";
import type { ChromeExtensionBridge } from "./chrome-extension-bridge";
import type { DesktopControlBridge } from "./desktop-control-bridge";
import { validateWorkspaceGitTransport } from "./git-transport-validator";
import {
  DESKTOP_INBOUND_IPC_CHANNELS,
  isGitProvider,
  isRepositorySlug,
  isValidOperationId,
  isValidWorkspaceId,
  validateDesktopIpcInvocation,
} from "./ipc-policy";
import { ProviderHttpError, type ProviderManager } from "./provider-manager";
import type { PublicMcpManager } from "./public-mcp-manager";
import { sanitizeRuntimeText, type RuntimeLogStore } from "./runtime-log-store";
import { SourceNerveClient, SourceNerveHttpError } from "./sourcenerve-client";
import type { WorkspaceGrantManager } from "./workspace-grant-manager";
import { WorkspaceManager, WorkspaceManagerError } from "./workspace-manager";

export interface DesktopIpcContext {
  runtimeInfo(): Omit<RuntimeInfo, "apiVersion">;
  sourceNerveClient(): SourceNerveClient | null;
  daemonManager(): DaemonManager | null;
  workspaceManager(): WorkspaceManager | null;
  workspaceGrantManager(): WorkspaceGrantManager | null;
  providerManager(): ProviderManager | null;
  publicMcpManager(): PublicMcpManager | null;
  desktopControlBridge(): DesktopControlBridge | null;
  chromeExtensionBridge(): ChromeExtensionBridge | null;
  runtimeLogStore(): RuntimeLogStore | null;
  workspaceSkillsChanged?(): Promise<void>;
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

  secureHandle(
    context,
    DESKTOP_IPC.workspacePickRepository,
    async (_args, event) => {
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
      if (selection.canceled || selection.filePaths.length !== 1)
        return ok(null);
      return invokeWorkspaceManager(manager, () =>
        manager.stageRepositorySelection(selection.filePaths[0]),
      );
    },
  );
  secureHandle(context, DESKTOP_IPC.workspaceListManaged, async () => {
    const manager = context.workspaceManager();
    return manager
      ? invokeWorkspaceManager(manager, () => manager.listManagedWorkspaces())
      : workspaceManagerUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.workspaceSave, async (args) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const result = await invokeWorkspaceManager(manager, () =>
      manager.saveWorkspace(args[0] as WorkspaceSaveInput),
    );
    // Daemon restart (part of synchronization) can take up to 25 seconds.
    // Return the workspace result immediately so the UI is not blocked.
    // Runtime events (daemon/workspace state changes) propagate to the renderer
    // independently via subscribeRuntimeEvents.
    if (result.ok)
      void synchronizeWorkspaceGrants(context).catch((error) => {
        context.runtimeLogStore()?.record({
          type: "log",
          component: "daemon",
          level: "warn",
          message: `Workspace saved; daemon synchronization deferred: ${error instanceof Error ? error.message : "unknown error"}`,
          timestamp: new Date().toISOString(),
        });
      });
    return result;
  });
  secureHandle(context, DESKTOP_IPC.workspaceRemove, async (args) => {
    const manager = context.workspaceManager();
    if (!manager) return workspaceManagerUnavailable();
    const workspaceId = args[0];
    if (!isValidWorkspaceId(workspaceId)) return invalidWorkspaceId();
    const result = await invokeWorkspaceManager(manager, () =>
      manager.removeWorkspace(workspaceId),
    );
    // Same non-blocking approach as workspaceSave above.
    if (result.ok)
      void synchronizeWorkspaceGrants(context).catch((error) => {
        context.runtimeLogStore()?.record({
          type: "log",
          component: "daemon",
          level: "warn",
          message: `Workspace removed; daemon synchronization deferred: ${error instanceof Error ? error.message : "unknown error"}`,
          timestamp: new Date().toISOString(),
        });
      });
    return result;
  });
  secureHandle(context, DESKTOP_IPC.providerStates, async () => {
    const manager = context.providerManager();
    return manager ? ok(manager.states()) : providerManagerUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.providerConnect, async (args) => {
    const provider = args[0];
    if (!isGitProvider(provider)) return invalidProvider();
    return invokeProvider(context, (manager) => manager.connect(provider));
  });
  secureHandle(context, DESKTOP_IPC.providerDisconnect, async (args) => {
    const provider = args[0];
    if (!isGitProvider(provider)) return invalidProvider();
    return invokeProvider(context, (manager) => manager.disconnect(provider));
  });
  secureHandle(context, DESKTOP_IPC.providerRepositories, async (args) => {
    const provider = args[0];
    if (!isGitProvider(provider)) return invalidProvider();
    return invokeProvider(context, (manager) =>
      manager.listRepositories(provider),
    );
  });
  secureHandle(
    context,
    DESKTOP_IPC.providerValidateRepository,
    async (args) => {
      const provider = args[0];
      const repository = args[1];
      if (!isGitProvider(provider) || !isRepositorySlug(repository)) {
        return fail({
          code: "invalid_request",
          message: "provider repository input is invalid",
          retryable: false,
        });
      }
      return invokeProvider(context, (manager) =>
        manager.validateRepository(provider, repository),
      );
    },
  );
  secureHandle(context, DESKTOP_IPC.providerValidateTransport, async (args) => {
    const workspaceId = args[0];
    if (!isValidWorkspaceId(workspaceId)) return invalidWorkspaceId();
    const workspaceManager = context.workspaceManager();
    if (!workspaceManager) return workspaceManagerUnavailable();
    try {
      return ok(
        await validateWorkspaceGitTransport(workspaceManager, workspaceId),
      );
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });

  secureHandle(context, DESKTOP_IPC.publicMcpState, async () => {
    const manager = context.publicMcpManager();
    return manager ? ok(manager.state()) : publicMcpUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.publicMcpEnroll, async () =>
    invokePublicMcpWithWorkspaceSync(context, (manager) => manager.enroll()),
  );
  secureHandle(context, DESKTOP_IPC.publicMcpRetry, async () =>
    invokePublicMcpWithWorkspaceSync(context, repairPublicMcp),
  );
  secureHandle(context, DESKTOP_IPC.publicMcpRotate, async () =>
    invokePublicMcp(context, (manager) => manager.rotateTunnelCredential()),
  );
  secureHandle(context, DESKTOP_IPC.publicMcpRevoke, async () =>
    invokePublicMcp(context, (manager) => manager.revoke()),
  );
  secureHandle(context, DESKTOP_IPC.publicMcpReEnroll, async () =>
    invokePublicMcpWithWorkspaceSync(context, (manager) => manager.reEnroll()),
  );


  secureHandle(context, DESKTOP_IPC.desktopControlState, async () => {
    const bridge = context.desktopControlBridge();
    return bridge ? ok(await bridge.state()) : desktopControlUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.desktopControlPermissionsUpdate, async (args) => {
    const bridge = context.desktopControlBridge();
    return bridge ? ok(await bridge.updatePermissions(args[0] as DesktopControlPermissions)) : desktopControlUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.desktopControlObserve, async (args) => {
    const bridge = context.desktopControlBridge();
    return bridge ? ok(await bridge.observe((args[0] ?? {}) as DesktopControlObserveInput)) : desktopControlUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.desktopControlRun, async (args) => {
    const bridge = context.desktopControlBridge();
    return bridge ? ok(await bridge.run(args[0] as DesktopControlRunInput)) : desktopControlUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.chromeExtensionBridgeState, async () => {
    const bridge = context.chromeExtensionBridge();
    return bridge ? ok(bridge.state()) : chromeExtensionBridgeUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.chromeExtensionBridgeRotateToken, async () => {
    const bridge = context.chromeExtensionBridge();
    return bridge ? ok(await bridge.rotateToken()) : chromeExtensionBridgeUnavailable();
  });

  secureHandle(context, DESKTOP_IPC.runtimeLogs, async () => {
    const store = context.runtimeLogStore();
    return store ? ok(store.snapshot()) : runtimeLogsUnavailable();
  });
  secureHandle(context, DESKTOP_IPC.diagnosticsCopy, async () => {
    const store = context.runtimeLogStore();
    if (!store) return runtimeLogsUnavailable();
    try {
      const text = await buildDiagnosticsText(context, store);
      clipboard.writeText(text);
      return ok({ copied: true as const, characters: text.length });
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });

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
    if (!isValidOperationId(operationId))
      throw new Error("invalid Desktop operation ID");
    if (this.controllers.has(operationId))
      throw new Error("Desktop operation ID is already active");
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
    if (validationError)
      return fail({
        code: "invalid_request",
        message: validationError,
        retryable: false,
      });
    try {
      return await handler(args, event);
    } catch (error) {
      return fail(toDesktopError(error));
    }
  });
}

async function reconcileWorkspaceGrants(
  context: DesktopIpcContext,
): Promise<void> {
  await context.workspaceGrantManager()?.workspaceChanged();
}

async function synchronizeWorkspaceGrants(
  context: DesktopIpcContext,
): Promise<void> {
  await reconcileWorkspaceGrants(context);
  await context.workspaceSkillsChanged?.();

  const publicMcp = context.publicMcpManager();
  if (!publicMcp) return;
  void repairPublicMcp(publicMcp).catch((error) => {
    context.runtimeLogStore()?.record({
      type: "log",
      component: "public-mcp",
      level: "warn",
      message: `Workspace runtime was applied locally; Public MCP verification was deferred: ${sanitizeMessage(error instanceof Error ? error.message : "verification failed")}`,
      timestamp: new Date().toISOString(),
    });
  });
}

async function repairPublicMcp(manager: PublicMcpManager) {
  const view = manager.state();
  if (
    view.state === "not-enrolled" ||
    (view.state === "enrolling" && !view.hostname)
  ) {
    return manager.enroll();
  }
  return manager.retry();
}

async function buildDiagnosticsText(
  context: DesktopIpcContext,
  store: RuntimeLogStore,
): Promise<string> {
  const daemon = context.daemonManager()?.snapshot() ?? null;
  const providers = context.providerManager()?.states() ?? [];
  const publicMcp = context.publicMcpManager()?.state() ?? null;
  const workspaceManager = context.workspaceManager();
  const workspaces = workspaceManager
    ? await workspaceManager.listManagedWorkspaces().catch(() => [])
    : [];
  const local = await localDiagnosticState(context, daemon?.state);
  const logs = store.snapshot();

  const bundle = {
    generatedAt: new Date().toISOString(),
    runtime: { ...context.runtimeInfo(), apiVersion: DESKTOP_API_VERSION },
    daemon,
    providers: providers.map((provider) => ({
      provider: provider.provider,
      status: provider.status,
      connectedAt: provider.connectedAt,
      error: provider.error,
    })),
    publicMcp,
    local,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      access: workspace.access,
      remote: workspace.remote,
      defaultBranch: workspace.defaultBranch,
      provider: workspace.provider,
      repository: workspace.repository,
      validation: workspace.validation,
      head: workspace.head,
      branch: workspace.branch,
      dirty: workspace.dirty,
    })),
    logRetention: {
      retainedEntries: logs.entries.length,
      droppedEntries: logs.droppedEntries,
      maxEntries: logs.maxEntries,
      maxBytes: logs.maxBytes,
    },
    recentLogs: logs.entries.slice(-200),
  };

  return sanitizeRuntimeText(JSON.stringify(bundle, null, 2), process.env.HOME);
}

async function localDiagnosticState(
  context: DesktopIpcContext,
  daemonState: string | undefined,
): Promise<Record<string, unknown>> {
  if (daemonState !== "ready" && daemonState !== "external") {
    return {
      available: false,
      reason: `daemon-${daemonState ?? "unavailable"}`,
    };
  }
  const client = context.sourceNerveClient();
  if (!client) return { available: false, reason: "local-client-unavailable" };

  const [health, readiness, service] = await Promise.allSettled([
    client.health(),
    client.readiness(),
    client.serviceStatus(),
  ]);
  return {
    available: true,
    health: health.status === "fulfilled" ? health.value : { status: "error" },
    readiness:
      readiness.status === "fulfilled" ? readiness.value : { ready: false },
    service:
      service.status === "fulfilled"
        ? service.value
        : { status: "unavailable" },
  };
}

async function invokeProvider<T>(
  context: DesktopIpcContext,
  invoke: (manager: ProviderManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.providerManager();
  if (!manager) return providerManagerUnavailable();
  try {
    return ok(await invoke(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function invokePublicMcpWithWorkspaceSync<T>(
  context: DesktopIpcContext,
  invoke: (manager: PublicMcpManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  try {
    await reconcileWorkspaceGrants(context);
  } catch (error) {
    return fail(toDesktopError(error));
  }
  return invokePublicMcp(context, invoke);
}

async function invokePublicMcp<T>(
  context: DesktopIpcContext,
  invoke: (manager: PublicMcpManager) => Promise<T>,
): Promise<DesktopResult<T>> {
  const manager = context.publicMcpManager();
  if (!manager) return publicMcpUnavailable();
  try {
    return ok(await invoke(manager));
  } catch (error) {
    return fail(toDesktopError(error));
  }
}

async function invokeClient<T>(
  context: DesktopIpcContext,
  invoke: (client: SourceNerveClient) => Promise<T>,
): Promise<DesktopResult<T>> {
  const client = context.sourceNerveClient();
  if (!client)
    return fail({
      code: "not_ready",
      message: "SourceNerve local runtime is not initialized",
      retryable: true,
    });
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
  if (!manager)
    return fail({
      code: "not_ready",
      message: "SourceNerve daemon manager is not initialized",
      retryable: true,
    });
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
function providerManagerUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Git provider manager is not initialized",
    retryable: true,
  });
}
function publicMcpUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Public MCP lifecycle is not configured for this Desktop build",
    retryable: false,
  });
}

function desktopControlUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Desktop control bridge is not initialized",
    retryable: true,
  });
}
function chromeExtensionBridgeUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Chrome extension bridge is not initialized",
    retryable: true,
  });
}
function runtimeLogsUnavailable<T>(): DesktopResult<T> {
  return fail({
    code: "not_ready",
    message: "Desktop runtime diagnostics are not initialized",
    retryable: true,
  });
}
function invalidProvider<T>(): DesktopResult<T> {
  return fail({
    code: "invalid_request",
    message: "provider must be github or gitlab",
    retryable: false,
  });
}
function invalidWorkspaceId<T>(): DesktopResult<T> {
  return fail({
    code: "invalid_request",
    message: "workspaceId is invalid",
    retryable: false,
  });
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof WorkspaceManagerError) return error.desktopError;
  if (error instanceof ProviderHttpError) {
    if (error.status === 401)
      return { code: "unauthorized", message: error.message, retryable: true };
    if (error.status === 403)
      return { code: "forbidden", message: error.message, retryable: false };
    if (error.status === 404)
      return { code: "not_found", message: error.message, retryable: false };
    if (error.status === 429 || error.status >= 500)
      return { code: "service_error", message: error.message, retryable: true };
    return { code: "transport_error", message: error.message, retryable: true };
  }
  if (error instanceof SourceNerveHttpError) {
    if (error.status === 401)
      return { code: "unauthorized", message: error.message, retryable: true };
    if (error.status === 403)
      return { code: "forbidden", message: error.message, retryable: false };
    if (error.status === 404)
      return { code: "not_found", message: error.message, retryable: false };
    if (error.status >= 500)
      return { code: "service_error", message: error.message, retryable: true };
    return { code: "transport_error", message: error.message, retryable: true };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "timeout",
      message: "SourceNerve request timed out",
      retryable: true,
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "transport_error",
      message: "SourceNerve local service is unavailable",
      retryable: true,
    };
  }
  const message =
    error instanceof Error
      ? sanitizeMessage(error.message)
      : "Desktop operation failed";
  if (
    /not initialized|not configured|not connected|not enrolled|sign in|unavailable|no external SourceNerve daemon/i.test(
      message,
    )
  ) {
    return { code: "not_ready", message, retryable: true };
  }
  if (
    /invalid|already running|cannot stop|cannot restart|different local credential|revoked/i.test(
      message,
    )
  ) {
    return { code: "invalid_request", message, retryable: false };
  }
  if (
    /incompatible|did not terminate|readiness timeout|temporarily unavailable|startup timeout/i.test(
      message,
    )
  ) {
    return { code: "service_error", message, retryable: true };
  }
  return { code: "internal_error", message, retryable: false };
}

function sanitizeMessage(message: string): string {
  return sanitizeRuntimeText(message, process.env.HOME);
}
function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}
function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}
function removeKnownHandlers(): void {
  for (const channel of DESKTOP_INBOUND_IPC_CHANNELS)
    ipcMain.removeHandler(channel);
}
