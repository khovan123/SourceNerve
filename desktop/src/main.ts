import {
  app,
  BrowserWindow,
  dialog,
  session,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
import { WorkspaceManager } from "./main/workspace-manager";
import type { DesktopRuntimeEvent, RuntimeInfo } from "./shared/desktop-api";

const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 640;

let sourceNerveClient: SourceNerveClient | null = null;
let daemonManager: DaemonManager | null = null;
let workspaceManager: WorkspaceManager | null = null;
let mainWindow: BrowserWindow | null = null;
let rendererDevServerUrl: string | undefined;
let rendererEntryUrl: string | undefined;
let allowQuitAfterDaemonShutdown = false;
let bootstrapStatus: RuntimeInfo["bootstrap"] = {
  ready: false,
  error: "Desktop bootstrap has not initialized",
};
const operations = new OperationRegistry();
const selectedWorkspaceRoots = new Set<string>();

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

async function pickWorkspaceDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "Choose a Git repository",
    buttonLabel: "Choose repository",
    properties: ["openDirectory"],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length !== 1) return null;
  const selected = result.filePaths[0];
  selectedWorkspaceRoots.add(selected);
  return selected;
}

async function isWorkspaceRootAuthorized(root: string): Promise<boolean> {
  if (selectedWorkspaceRoots.has(root)) return true;
  const manager = workspaceManager;
  if (!manager) return false;
  const existing = await manager.list();
  return existing.some((workspace) => workspace.root === root);
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
      daemonManager,
      sourceNerveClient,
      onEvent: publishMainRuntimeEvent,
    });
    await workspaceManager.initialize();

    const launchPlan = await existingDaemonLaunchPlan(bootstrap);
    if (launchPlan) {
      daemonManager.configure(launchPlan);
    }

    bootstrapStatus = {
      ready: true,
      profileSchemaVersion: bootstrap.profile.schemaVersion,
      secureStorageBackend: bootstrap.storageBackend,
    };
    console.info(
      `[desktop] bootstrap ready: profile=v${bootstrap.profile.schemaVersion} secureStorage=${bootstrap.storageBackend}`,
    );

    if (launchPlan) {
      void daemonManager.start().catch((error) => {
        const message = error instanceof Error ? error.message : "managed daemon startup failed";
        console.error(`[desktop] daemon startup failed: ${message}`);
      });
    }
  } catch (error) {
    sourceNerveClient = null;
    daemonManager = null;
    workspaceManager = null;
    const message = error instanceof Error ? error.message : "Desktop bootstrap failed";
    bootstrapStatus = { ready: false, error: message };
    console.error(`[desktop] bootstrap unavailable: ${message}`);
  }
}

app.on("open-url", (event, callbackUrl) => {
  event.preventDefault();
  const parsed = parseAuthCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    console.warn("[desktop] rejected malformed SourceNerve OAuth callback");
    return;
  }
  publishMainRuntimeEvent({
    type: "state",
    component: "auth",
    state: "callback-received",
    message:
      parsed.value.kind === "error"
        ? "Authentication callback reported an authorization error"
        : undefined,
  });
});

app.whenReady().then(async () => {
  installSessionSecurity();
  await initializeBootstrap();
  installDesktopIpcHandlers({
    runtimeInfo,
    sourceNerveClient: () => sourceNerveClient,
    daemonManager: () => daemonManager,
    workspaceManager: () => workspaceManager,
    pickWorkspaceDirectory,
    isWorkspaceRootAuthorized,
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
