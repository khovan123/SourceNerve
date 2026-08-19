import {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
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
  isAllowedExternalHttpsUrl,
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
const AUTH_PROTOCOL = "sourcenerve";

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
const selectedWorkspaceRoots = new Set<string>();
const queuedAuthCallbacks: string[] = [];

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

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

function registerAuthProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
  }
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

    workspaceGrantManager = new WorkspaceGrantManager({
      bootstrap,
      daemonManager,
      workspaceManager,
    });
    await workspaceGrantManager.initialize();

    auth0Manager = new Auth0Manager({
      bootstrap,
      openExternal: async (url) => {
        if (!isAllowedExternalHttpsUrl(url, [bootstrap.profile.auth0.issuer])) {
          throw new Error("Auth0 authorization URL escaped the configured issuer origin");
        }
        await shell.openExternal(url);
      },
      onEvent: publishMainRuntimeEvent,
    });
    await auth0Manager.initialize();

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
    auth0Manager = null;
    workspaceGrantManager = null;
    const message = error instanceof Error ? error.message : "Desktop bootstrap failed";
    bootstrapStatus = { ready: false, error: message };
    console.error(`[desktop] bootstrap unavailable: ${message}`);
  }
}

async function routeAuthCallback(callbackUrl: string): Promise<void> {
  const parsed = parseAuthCallbackUrl(callbackUrl);
  if (!parsed.ok) {
    console.warn("[desktop] rejected malformed SourceNerve OAuth callback");
    return;
  }
  const auth = auth0Manager;
  if (!auth) {
    if (queuedAuthCallbacks.length < 2) queuedAuthCallbacks.push(callbackUrl);
    return;
  }
  try {
    const state = await auth.handleCallback(parsed.value);
    if (state.status === "authenticated" && state.identity && workspaceGrantManager) {
      await workspaceGrantManager.grantCurrentIdentity(state.identity);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "SourceNerve account callback failed";
    publishMainRuntimeEvent({
      type: "state",
      component: "auth",
      state: "error",
      message: message.replace(/[\r\n\0]/g, " ").slice(0, 512),
    });
  }
}

function authCallbackFromArgs(args: readonly string[]): string | null {
  const candidates = args.filter((value) => value.startsWith("sourcenerve://oauth/callback"));
  return candidates.length === 1 ? candidates[0] : null;
}

app.on("open-url", (event, callbackUrl) => {
  event.preventDefault();
  void routeAuthCallback(callbackUrl);
});

app.on("second-instance", (_event, commandLine) => {
  const callbackUrl = authCallbackFromArgs(commandLine);
  if (callbackUrl) void routeAuthCallback(callbackUrl);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

if (primaryInstance) {
  app.whenReady().then(async () => {
    installSessionSecurity();
    registerAuthProtocol();
    await initializeBootstrap();
    installDesktopIpcHandlers({
      runtimeInfo,
      sourceNerveClient: () => sourceNerveClient,
      daemonManager: () => daemonManager,
      workspaceManager: () => workspaceManager,
      auth0Manager: () => auth0Manager,
      workspaceGrantManager: () => workspaceGrantManager,
      pickWorkspaceDirectory,
      isWorkspaceRootAuthorized,
      isTrustedSender: isTrustedIpcSender,
      operations,
    });
    createWindow();

    const initialCallback = authCallbackFromArgs(process.argv);
    if (initialCallback) queuedAuthCallbacks.push(initialCallback);
    while (queuedAuthCallbacks.length > 0) {
      const callback = queuedAuthCallbacks.shift();
      if (callback) await routeAuthCallback(callback);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

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
