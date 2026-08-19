import { app, BrowserWindow } from "electron";
import path from "node:path";

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
import { SourceNerveClient } from "./main/sourcenerve-client";
import type { RuntimeInfo } from "./shared/desktop-api";

const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 640;

let sourceNerveClient: SourceNerveClient | null = null;
let daemonManager: DaemonManager | null = null;
let allowQuitAfterDaemonShutdown = false;
let bootstrapStatus: RuntimeInfo["bootstrap"] = {
  ready: false,
  error: "Desktop bootstrap has not initialized",
};
const operations = new OperationRegistry();

function runtimeInfo(): Omit<RuntimeInfo, "apiVersion"> {
  return {
    platform: process.platform,
    arch: process.arch,
    desktopVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    bootstrap: bootstrapStatus,
  };
}

function createWindow(): BrowserWindow {
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
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && new URL(targetUrl).origin !== new URL(currentUrl).origin) {
      event.preventDefault();
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  window.once("ready-to-show", () => {
    window.show();
    publishRuntimeEvent({
      type: "state",
      component: "desktop",
      state: bootstrapStatus.ready ? "ready" : "needs-attention",
      message: bootstrapStatus.error,
    });
  });
  return window;
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
      onEvent: publishRuntimeEvent,
    });

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

    // A previously configured installation resumes its managed daemon automatically.
    // Fresh installs remain stopped until the workspace onboarding flow materializes
    // the first runtime config; no TOML/env/token copy-paste is required.
    if (launchPlan) {
      void daemonManager.start().catch((error) => {
        const message = error instanceof Error ? error.message : "managed daemon startup failed";
        console.error(`[desktop] daemon startup failed: ${message}`);
      });
    }
  } catch (error) {
    sourceNerveClient = null;
    daemonManager = null;
    const message = error instanceof Error ? error.message : "Desktop bootstrap failed";
    bootstrapStatus = { ready: false, error: message };
    console.error(`[desktop] bootstrap unavailable: ${message}`);
  }
}

app.whenReady().then(async () => {
  await initializeBootstrap();
  installDesktopIpcHandlers({
    runtimeInfo,
    sourceNerveClient: () => sourceNerveClient,
    daemonManager: () => daemonManager,
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
