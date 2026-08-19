import {
  app,
  BrowserWindow,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Auth0Manager } from "./main/auth0-manager";
import { BackgroundController, openDesktopLogs } from "./main/background-controller";
import { installBackgroundIpcHandlers } from "./main/background-ipc";
import { prepareDesktopBootstrap } from "./main/bootstrap";
import { CloudflaredManager, resolveCloudflaredBinaryPath } from "./main/cloudflared-manager";
import { existingDaemonLaunchPlan } from "./main/daemon-bootstrap";
import {
  DaemonManager,
  resolveDaemonBinaryPath,
} from "./main/daemon-manager";
import { DesktopPreferencesStore } from "./main/desktop-preferences";
import {
  installDesktopIpcHandlers,
  OperationRegistry,
  publishRuntimeEvent,
} from "./main/ipc";
import { ProviderManager } from "./main/provider-manager";
import { PublicMcpManager } from "./main/public-mcp-manager";
import {
  RuntimeLogStore,
  sanitizeRuntimeEvent,
} from "./main/runtime-log-store";
import type { DesktopBehaviorPolicy } from "./main/runtime-profile";
import {
  isAllowedRendererNavigation,
  isTrustedRendererDocument,
  parseAuthCallbackUrl,
  validateDevServerUrl,
} from "./main/security-policy";
import { SourceNerveClient } from "./main/sourcenerve-client";
import { WorkspaceGrantManager } from "./main/workspace-grant-manager";
import { WorkspaceManager } from "./main/workspace-manager";
import {
  DESKTOP_IPC,
  type DesktopRuntimeEvent,
  type RuntimeInfo,
} from "./shared/desktop-api";

const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 640;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;
const launchedHidden = process.argv.includes("--hidden");
const MAX_PENDING_AUTH_CALLBACKS = 4;
const DISABLED_DESKTOP_BEHAVIOR_POLICY: DesktopBehaviorPolicy = {
  allowBackgroundMode: false,
  allowLaunchAtLogin: false,
  allowNotifications: false,
};

let sourceNerveClient: SourceNerveClient | null = null;
let daemonManager: DaemonManager | null = null;
let workspaceManager: WorkspaceManager | null = null;
let auth0Manager: Auth0Manager | null = null;
let workspaceGrantManager: WorkspaceGrantManager | null = null;
let providerManager: ProviderManager | null = null;
let cloudflaredManager: CloudflaredManager | null = null;
let publicMcpManager: PublicMcpManager | null = null;
let runtimeLogStore: RuntimeLogStore | null = null;
let desktopPreferences: DesktopPreferencesStore | null = null;
let backgroundController: BackgroundController | null = null;
let desktopBehaviorPolicy: DesktopBehaviorPolicy = { ...DISABLED_DESKTOP_BEHAVIOR_POLICY };
let runtimeEndpoints: RuntimeInfo["endpoints"];
let mainWindow: BrowserWindow | null = null;
let rendererDevServerUrl: string | undefined;
let rendererEntryUrl: string | undefined;
let allowQuitAfterShutdown = false;
let pendingShowRequest = false;
const pendingAuthCallbackUrls: string[] = [];
let bootstrapStatus: RuntimeInfo["bootstrap"] = {
  ready: false,
  error: "Desktop bootstrap has not initialized",
};
const operations = new OperationRegistry();

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const callbackUrl = argv.find((argument) => argument.startsWith("sourcenerve://oauth/callback"));
    if (callbackUrl) routeOrQueueAuthCallback(callbackUrl);
    if (app.isReady()) showMainWindow();
    else pendingShowRequest = true;
  });

  const initialAuthCallbackUrl = process.argv.find((argument) =>
    argument.startsWith("sourcenerve://oauth/callback"),
  );
  if (initialAuthCallbackUrl) queueAuthCallbackUrl(initialAuthCallbackUrl);
}

function runtimeInfo(): Omit<RuntimeInfo, "apiVersion"> {
  return {
    platform: process.platform,
    arch: process.arch,
    desktopVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    bootstrap: bootstrapStatus,
    endpoints: runtimeEndpoints,
  };
}

function publishMainRuntimeEvent(event: DesktopRuntimeEvent): void {
  const safeEvent = sanitizeRuntimeEvent(
    event,
    app.isReady() ? app.getPath("home") : process.env.HOME,
  );
  backgroundController?.handleRuntimeEvent(safeEvent);
  const logEntry = runtimeLogStore?.record(safeEvent) ?? null;
  publishRuntimeEvent(mainWindow, safeEvent);
  if (logEntry && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_IPC.runtimeLogEvent, logEntry);
  }
}

function resolveRendererDevServer(): string | undefined {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) return undefined;
  const result = validateDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  if (!result.ok) throw new Error(`unsafe Desktop development renderer URL: ${result.error}`);
  return result.value;
}

function createWindow(showOnReady = true): BrowserWindow {
  rendererDevServerUrl = resolveRendererDevServer();
  const packagedEntryPath = path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  );
  rendererEntryUrl = rendererDevServerUrl ?? pathToFileURL(packagedEntryPath).toString();

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    backgroundColor: "#0b1020",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  mainWindow = window;

  const navigationAllowed = (targetUrl: string) => {
    const currentUrl = window.webContents.getURL() || rendererEntryUrl;
    return Boolean(
      currentUrl &&
        isAllowedRendererNavigation(targetUrl, currentUrl, rendererDevServerUrl),
    );
  };

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!navigationAllowed(targetUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, targetUrl) => {
    if (!navigationAllowed(targetUrl)) event.preventDefault();
  });
  window.on("close", (event) => {
    if (!allowQuitAfterShutdown && backgroundController?.shouldHideOnClose()) {
      event.preventDefault();
      window.hide();
    }
  });

  if (rendererDevServerUrl) void window.loadURL(rendererDevServerUrl);
  else void window.loadFile(packagedEntryPath);

  window.once("ready-to-show", () => {
    if (showOnReady) window.show();
    publishMainRuntimeEvent({
      type: "state",
      component: "desktop",
      state: bootstrapStatus.ready ? "ready" : "needs-attention",
      message: bootstrapStatus.error,
    });
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function showMainWindow(): void {
  if (!app.isReady()) {
    pendingShowRequest = true;
    return;
  }
  let window = mainWindow;
  if (!window || window.isDestroyed()) window = createWindow(true);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function installSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function isTrustedIpcSender(event: IpcMainInvokeEvent): boolean {
  const window = mainWindow;
  const frame = event.senderFrame;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !frame ||
    frame !== event.sender.mainFrame
  ) {
    return false;
  }
  return isTrustedRendererDocument(
    frame.url,
    window.webContents.getURL(),
    rendererDevServerUrl,
  );
}

async function initializeBootstrap(): Promise<void> {
  try {
    const bootstrap = await prepareDesktopBootstrap({
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      packaged: app.isPackaged,
    });
    desktopBehaviorPolicy = { ...bootstrap.profile.desktopBehavior };
    const localApiUrl = `http://${bootstrap.profile.daemon.bind}`;
    runtimeEndpoints = {
      localApiUrl,
      localMcpUrl: `${localApiUrl}${bootstrap.profile.daemon.mcpPath}`,
      publicMcpResource: bootstrap.profile.publicMcp.resource,
    };
    sourceNerveClient = new SourceNerveClient({
      baseUrl: localApiUrl,
      getBearer: async () => {
        const bearer = await bootstrap.secretStore.get("localBearer");
        if (!bearer) throw new Error("SourceNerve local bearer is unavailable");
        return bearer;
      },
    });
    daemonManager = new DaemonManager({
      binaryPath: resolveDaemonBinaryPath({
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
      expectedVersion: app.getVersion(),
      client: sourceNerveClient,
      onEvent: publishMainRuntimeEvent,
    });
    workspaceManager = new WorkspaceManager({
      bootstrap,
      daemon: daemonManager,
      client: sourceNerveClient,
      operations,
      onEvent: publishMainRuntimeEvent,
    });

    const launchPlan = await existingDaemonLaunchPlan(bootstrap);
    if (launchPlan) daemonManager.configure(launchPlan);

    auth0Manager = new Auth0Manager({
      bootstrap,
      openExternal: async (url) => shell.openExternal(url),
      onEvent: publishMainRuntimeEvent,
    });
    workspaceGrantManager = new WorkspaceGrantManager({
      bootstrap,
      daemonManager,
      workspaceManager,
    });

    const authState = await auth0Manager.initialize();
    await workspaceGrantManager.initialize();
    const managedWorkspaces = await workspaceManager.listManagedWorkspaces();
    if (managedWorkspaces.length > 0) {
      if (authState.status === "authenticated" && authState.identity) {
        await workspaceGrantManager.grantCurrentIdentity(authState.identity);
      } else {
        await workspaceGrantManager.workspaceChanged();
      }
    }

    providerManager = new ProviderManager({
      bootstrap,
      workspaceManager,
      openExternal: async (url) => shell.openExternal(url),
      onEvent: publishMainRuntimeEvent,
      onCredentialChanged: async () => {
        const currentAuth = auth0Manager?.state();
        await workspaceGrantManager?.workspaceChanged(
          currentAuth?.status === "authenticated" && currentAuth.identity
            ? currentAuth.identity
            : undefined,
        );
      },
    });
    await providerManager.initialize();

    if (launchPlan && daemonManager.snapshot().state === "stopped") {
      await daemonManager.start().catch((error) => {
        const message = error instanceof Error ? error.message : "managed daemon startup failed";
        publishMainRuntimeEvent({
          type: "log",
          component: "daemon",
          level: "error",
          message,
          timestamp: new Date().toISOString(),
        });
      });
    }

    const brokerBaseUrl = bootstrap.profile.bootstrapBroker.baseUrl;
    if (brokerBaseUrl && !PLACEHOLDER_PATTERN.test(brokerBaseUrl)) {
      cloudflaredManager = new CloudflaredManager({
        binaryPath: resolveCloudflaredBinaryPath({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
        }),
        onEvent: publishMainRuntimeEvent,
      });
      publicMcpManager = new PublicMcpManager({
        bootstrap,
        auth0: auth0Manager,
        cloudflared: cloudflaredManager,
        onEvent: publishMainRuntimeEvent,
      });
      if (authState.status === "authenticated") {
        try {
          const publicState = await publicMcpManager.initialize();
          if (publicState.state === "not-enrolled") {
            await publicMcpManager.enroll();
          }
        } catch {
          publishMainRuntimeEvent({
            type: "state",
            component: "public-mcp",
            state: "degraded",
            message: "Public MCP auto-enrollment deferred; use Retry / Repair from Connections",
          });
        }
      }
    }

    bootstrapStatus = {
      ready: true,
      profileSchemaVersion: bootstrap.profile.schemaVersion,
      secureStorageBackend: bootstrap.storageBackend,
    };
    publishMainRuntimeEvent({
      type: "log",
      component: "desktop",
      level: "info",
      message: `bootstrap ready profile=v${bootstrap.profile.schemaVersion} secureStorage=${bootstrap.storageBackend}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    sourceNerveClient = null;
    daemonManager = null;
    workspaceManager = null;
    auth0Manager = null;
    workspaceGrantManager = null;
    providerManager = null;
    publicMcpManager = null;
    cloudflaredManager = null;
    desktopBehaviorPolicy = { ...DISABLED_DESKTOP_BEHAVIOR_POLICY };
    runtimeEndpoints = undefined;
    const message = error instanceof Error ? error.message : "Desktop bootstrap failed";
    bootstrapStatus = { ready: false, error: message };
    publishMainRuntimeEvent({
      type: "log",
      component: "desktop",
      level: "error",
      message: `bootstrap unavailable: ${message}`,
      timestamp: new Date().toISOString(),
    });
  }
}

async function handleAuthCallbackUrl(callbackUrl: string): Promise<void> {
  const parsed = parseAuthCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    publishMainRuntimeEvent({
      type: "log",
      component: "auth",
      level: "warn",
      message: "rejected malformed SourceNerve OAuth callback",
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const manager = auth0Manager;
  if (!manager) {
    queueAuthCallbackUrl(callbackUrl);
    return;
  }
  try {
    const state = await manager.handleCallback(parsed.value);
    if (state.status === "authenticated" && state.identity && workspaceGrantManager) {
      await workspaceGrantManager.grantCurrentIdentity(state.identity);
      if (publicMcpManager) {
        try {
          const publicState = await publicMcpManager.initialize();
          if (publicState.state === "not-enrolled") {
            await publicMcpManager.enroll();
          }
        } catch {
          publishMainRuntimeEvent({
            type: "state",
            component: "public-mcp",
            state: "degraded",
            message: "Public MCP auto-enrollment needs Retry / Repair",
          });
        }
      }
    }
  } catch {
    publishMainRuntimeEvent({
      type: "state",
      component: "auth",
      state: "error",
      message: "SourceNerve account sign-in could not be completed",
    });
  }
}

function routeOrQueueAuthCallback(callbackUrl: string): void {
  if (auth0Manager) void handleAuthCallbackUrl(callbackUrl);
  else queueAuthCallbackUrl(callbackUrl);
}

function queueAuthCallbackUrl(callbackUrl: string): void {
  if (!parseAuthCallbackUrl(callbackUrl).ok) return;
  if (pendingAuthCallbackUrls.length >= MAX_PENDING_AUTH_CALLBACKS) pendingAuthCallbackUrls.shift();
  pendingAuthCallbackUrls.push(callbackUrl);
}

function drainPendingAuthCallbacks(): void {
  for (const callbackUrl of pendingAuthCallbackUrls.splice(0)) {
    void handleAuthCallbackUrl(callbackUrl);
  }
}

async function runTrayDaemonAction(action: "start" | "stop" | "restart"): Promise<void> {
  const manager = daemonManager;
  if (!manager) return;
  try {
    if (action === "start") await manager.start();
    else if (action === "stop") await manager.stop();
    else await manager.restart();
  } catch (error) {
    publishMainRuntimeEvent({
      type: "log",
      component: "daemon",
      level: "error",
      message: error instanceof Error ? error.message : `daemon ${action} failed`,
      timestamp: new Date().toISOString(),
    });
  }
}

app.on("open-url", (event, callbackUrl) => {
  event.preventDefault();
  routeOrQueueAuthCallback(callbackUrl);
});

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const logDirectory = path.join(userData, "logs");
  runtimeLogStore = new RuntimeLogStore(logDirectory, {
    homeDirectory: app.getPath("home"),
  });
  desktopPreferences = new DesktopPreferencesStore(
    path.join(userData, "managed", "desktop-preferences.json"),
    process.platform,
  );
  await desktopPreferences.initialize();
  installSessionSecurity();
  if (app.isPackaged && !app.setAsDefaultProtocolClient("sourcenerve")) {
    publishMainRuntimeEvent({
      type: "log",
      component: "desktop",
      level: "warn",
      message: "SourceNerve OAuth protocol registration was not accepted by the operating system",
      timestamp: new Date().toISOString(),
    });
  }
  await initializeBootstrap();

  backgroundController = new BackgroundController({
    preferences: desktopPreferences,
    policy: desktopBehaviorPolicy,
    getDaemonState: () => daemonManager?.snapshot() ?? null,
    getPublicMcpState: () => publicMcpManager?.state() ?? null,
    showWindow: showMainWindow,
    startDaemon: () => runTrayDaemonAction("start"),
    stopDaemon: () => runTrayDaemonAction("stop"),
    restartDaemon: () => runTrayDaemonAction("restart"),
    openLogs: () => openDesktopLogs(logDirectory),
    quit: () => app.quit(),
  });
  await backgroundController.initialize().catch((error) => {
    publishMainRuntimeEvent({
      type: "log",
      component: "desktop",
      level: "warn",
      message: error instanceof Error ? error.message : "Desktop autostart reconciliation failed",
      timestamp: new Date().toISOString(),
    });
  });

  installDesktopIpcHandlers({
    runtimeInfo,
    sourceNerveClient: () => sourceNerveClient,
    daemonManager: () => daemonManager,
    workspaceManager: () => workspaceManager,
    auth0Manager: () => auth0Manager,
    workspaceGrantManager: () => workspaceGrantManager,
    providerManager: () => providerManager,
    publicMcpManager: () => publicMcpManager,
    runtimeLogStore: () => runtimeLogStore,
    isTrustedSender: isTrustedIpcSender,
    operations,
  });
  installBackgroundIpcHandlers({
    controller: () => backgroundController,
    isTrustedSender: isTrustedIpcSender,
  });

  drainPendingAuthCallbacks();
  const hideInitialWindow =
    launchedHidden &&
    backgroundController.shouldKeepRunningWithoutWindows() &&
    !pendingShowRequest;
  createWindow(!hideInitialWindow);
  pendingShowRequest = false;

  app.on("activate", showMainWindow);
});

app.on("before-quit", (event) => {
  if (allowQuitAfterShutdown) return;
  event.preventDefault();
  allowQuitAfterShutdown = true;

  const daemon = daemonManager;
  const daemonSnapshot = daemon?.snapshot();
  const managedDaemon =
    daemon && daemonSnapshot?.managed && daemonSnapshot.state !== "stopped"
      ? daemon
      : null;

  const controller = backgroundController;
  backgroundController = null;
  controller?.destroy();

  void shutdownForQuit(managedDaemon).finally(() => app.quit());
});

async function shutdownForQuit(managedDaemon: DaemonManager | null): Promise<void> {
  await publicMcpManager?.shutdown().catch(() => undefined);
  if (managedDaemon) await managedDaemon.stop().catch(() => undefined);
  await runtimeLogStore?.flush().catch(() => undefined);
}

app.on("window-all-closed", () => {
  if (!backgroundController?.shouldKeepRunningWithoutWindows()) app.quit();
});
