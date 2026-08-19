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
import { prepareDesktopBootstrap } from "./main/bootstrap";
import { existingDaemonLaunchPlan } from "./main/daemon-bootstrap";
import {
  DaemonManager,
  resolveDaemonBinaryPath,
} from "./main/daemon-manager";
import {
  installDesktopIpcHandlers,
  OperationRegistry,
  publishRuntimeEvent,
} from "./main/ipc";
import {
  isAllowedRendererNavigation,
  isTrustedRendererDocument,
  parseAuthCallbackUrl,
  validateDevServerUrl,
} from "./main/security-policy";
import { SourceNerveClient } from "./main/sourcenerve-client";
import { WorkspaceGrantManager } from "./main/workspace-grant-manager";
import { WorkspaceManager } from "./main/workspace-manager";
import type { DesktopRuntimeEvent, RuntimeInfo } from "./shared/desktop-api";

const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 640;

let sourceNerveClient: SourceNerveClient | null = null;
let daemonManager: DaemonManager | null = null;
let workspaceManager: WorkspaceManager | null = null;
let auth0Manager: Auth0Manager | null = null;
let workspaceGrantManager: WorkspaceGrantManager | null = null;
let mainWindow: BrowserWindow | null = null;
let rendererDevServerUrl: string | undefined;
let rendererEntryUrl: string | undefined;
let allowQuitAfterDaemonShutdown = false;
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
    if (callbackUrl) void handleAuthCallbackUrl(callbackUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function runtimeInfo(): Omit<RuntimeInfo, "apiVersion"> {
  return {
    platform: process.platform,
    arch: process.arch,
    desktopVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    bootstrap: bootstrapStatus,
  };
}

function publishMainRuntimeEvent(event: DesktopRuntimeEvent): void {
  publishRuntimeEvent(mainWindow, event);
}

function resolveRendererDevServer(): string | undefined {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) return undefined;
  const result = validateDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  if (!result.ok) {
    throw new Error(`unsafe Desktop development renderer URL: ${result.error}`);
  }
  return result.value;
}

function createWindow(): BrowserWindow {
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

  if (rendererDevServerUrl) {
    void window.loadURL(rendererDevServerUrl);
  } else {
    void window.loadFile(packagedEntryPath);
  }

  window.once("ready-to-show", () => {
    window.show();
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

function installSessionSecurity(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
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
  const currentUrl = window.webContents.getURL();
  return isTrustedRendererDocument(frame.url, currentUrl, rendererDevServerUrl);
}

async function initializeBootstrap(): Promise<void> {
  try {
    const bootstrap = await prepareDesktopBootstrap({
      appPath: app.getAppPath(),
      userData: app.getPath("userData"),
      packaged: app.isPackaged,
    });
    sourceNerveClient = new SourceNerveClient({
      baseUrl: `http://${bootstrap.profile.daemon.bind}`,
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
    if (launchPlan) {
      daemonManager.configure(launchPlan);
    }

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

    bootstrapStatus = {
      ready: true,
      profileSchemaVersion: bootstrap.profile.schemaVersion,
      secureStorageBackend: bootstrap.storageBackend,
    };
    console.info(
      `[desktop] bootstrap ready: profile=v${bootstrap.profile.schemaVersion} secureStorage=${bootstrap.storageBackend}`,
    );

    if (launchPlan && daemonManager.snapshot().state === "stopped") {
      void daemonManager.start().catch((error) => {
        const message = error instanceof Error ? error.message : "managed daemon startup failed";
        console.error(`[desktop] daemon startup failed: ${message}`);
      });
    }
  } catch (error) {
    sourceNerveClient = null;
    daemonManager = null;
    workspaceManager = null;
    auth0Manager = null;
    workspaceGrantManager = null;
    const message = error instanceof Error ? error.message : "Desktop bootstrap failed";
    bootstrapStatus = { ready: false, error: message };
    console.error(`[desktop] bootstrap unavailable: ${message}`);
  }
}

async function handleAuthCallbackUrl(callbackUrl: string): Promise<void> {
  const parsed = parseAuthCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    console.warn("[desktop] rejected malformed SourceNerve OAuth callback");
    return;
  }
  const manager = auth0Manager;
  if (!manager) {
    publishMainRuntimeEvent({
      type: "state",
      component: "auth",
      state: "error",
      message: "SourceNerve account manager is not initialized",
    });
    return;
  }
  try {
    const state = await manager.handleCallback(parsed.value);
    if (state.status === "authenticated" && state.identity && workspaceGrantManager) {
      await workspaceGrantManager.grantCurrentIdentity(state.identity);
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

app.on("open-url", (event, callbackUrl) => {
  event.preventDefault();
  void handleAuthCallbackUrl(callbackUrl);
});

app.whenReady().then(async () => {
  installSessionSecurity();
  if (app.isPackaged && !app.setAsDefaultProtocolClient("sourcenerve")) {
    console.warn("[desktop] SourceNerve OAuth protocol registration was not accepted by the operating system");
  }
  await initializeBootstrap();
  installDesktopIpcHandlers({
    runtimeInfo,
    sourceNerveClient: () => sourceNerveClient,
    daemonManager: () => daemonManager,
    workspaceManager: () => workspaceManager,
    auth0Manager: () => auth0Manager,
    workspaceGrantManager: () => workspaceGrantManager,
    isTrustedSender: isTrustedIpcSender,
    operations,
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", (event) => {
  if (allowQuitAfterDaemonShutdown) return;
  const manager = daemonManager;
  const snapshot = manager?.snapshot();
  if (!manager || !snapshot?.managed || snapshot.state === "stopped") return;

  event.preventDefault();
  allowQuitAfterDaemonShutdown = true;
  void manager
    .stop()
    .catch((error) => {
      const message = error instanceof Error ? error.message : "managed daemon shutdown failed";
      console.error(`[desktop] daemon shutdown failed: ${message}`);
    })
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
