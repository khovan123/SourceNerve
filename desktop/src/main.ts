import {
  app,
  BrowserWindow,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { installAgentIpcHandlers } from "./main/agent-ipc";
import { DesktopAgentManager } from "./main/agent-manager";
import { loadDesktopAppIcon } from "./main/app-icon";
import { BackgroundController, openDesktopLogs } from "./main/background-controller";
import { installBackgroundIpcHandlers } from "./main/background-ipc";
import { prepareDesktopBootstrap } from "./main/bootstrap";
import { CloudflaredManager, resolveCloudflaredBinaryPath } from "./main/cloudflared-manager";
import { CodexHarnessRuntime, parseCodexNativeApprovalResolution } from "./main/codex-harness-runtime";
import { codexServerEventToRuntimeProgress } from "./main/codex-ui-progress";
import { ChatGptReviewWebDriver } from "./main/chatgpt-review-web-driver";
import type { ChatGptTransportProgress } from "./main/chatgpt-stream-progress";
import { ChromeExtensionReviewDriver, CompositeChatGptReviewDriver } from "./main/chrome-extension-review-driver";
import { ChromeExtensionBridge, chromeExtensionBridgeStatePath } from "./main/chrome-extension-bridge";
import { DesktopControlBridge } from "./main/desktop-control-bridge";
import { CodexAppServerHost } from "./main/codex-app-server-host";
import { CodexCliManager } from "./main/codex-cli-manager";
import { CodexRuntimePool } from "./main/codex-runtime-pool";
import { CodexSkillActivator } from "./main/codex-skill-activator";
import { CodexSkillCache } from "./main/codex-skill-cache";
import { CodexThinRunner } from "./main/codex-thin-runner";
import { CodexThreadStore } from "./main/codex-thread-store";
import { ConversationActivityStore } from "./main/conversation-activity-store";
import { CrashMarkerStore } from "./main/crash-marker-store";
import { existingDaemonLaunchPlan } from "./main/daemon-bootstrap";
import {
  DaemonManager,
  resolveDaemonBinaryPath,
} from "./main/daemon-manager";
import { installDiagnosticsIpcHandlers } from "./main/diagnostics-ipc";
import { parseHarnessRunSnapshot } from "./main/harness-parser";
import { DiagnosticsManager } from "./main/diagnostics-manager";
import { DesktopPreferencesStore } from "./main/desktop-preferences";
import {
  installDesktopIpcHandlers,
  OperationRegistry,
  publishRuntimeEvent,
} from "./main/ipc";
import { McpExtensionClient } from "./main/mcp-extension-client";
import { installMcpExtensionIpcHandlers } from "./main/mcp-extension-ipc";
import { McpExtensionManager } from "./main/mcp-extension-manager";
import { installMigrationIpcHandlers } from "./main/migration-ipc";
import { MigrationManager } from "./main/migration-manager";
import { NpmSkillsManager } from "./main/npm-skills-manager";
import {
  initializePluginHubRuntime,
  preparePluginSkillsForPrompt,
  refreshPluginWorkspaceScopes,
} from "./main/plugin-hub-ipc";
import { installPluginVerificationIpcHandlers } from "./main/plugin-verification-ipc";
import { PluginVerificationManager } from "./main/plugin-verification-manager";
import { ProviderManager } from "./main/provider-manager";
import { ProviderWorkflowClient } from "./main/provider-workflow-client";
import { installProviderWorkflowIpcHandlers } from "./main/provider-workflow-ipc";
import { ProviderWorkflowManager } from "./main/provider-workflow-manager";
import { PublicMcpManager } from "./main/public-mcp-manager";
import {
  RuntimeLogStore,
  sanitizeRuntimeEvent,
} from "./main/runtime-log-store";
import type { DesktopBehaviorPolicy } from "./main/runtime-profile";
import {
  isAllowedRendererNavigation,
  isTrustedRendererDocument,
  validateDevServerUrl,
} from "./main/security-policy";
import { SourceNerveClient } from "./main/sourcenerve-client";
import {
  shouldRestartForNewerInstalledInstance,
  sourceNerveSingleInstanceData,
} from "./main/single-instance-version-handoff";
import { installTaskIpcHandlers } from "./main/task-ipc";
import { DesktopTaskManager } from "./main/task-manager";
import { DesktopTaskRegistry } from "./main/task-registry";
import { WorkspaceGrantManager } from "./main/workspace-grant-manager";
import { WorkspaceManager } from "./main/workspace-manager";
import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type DesktopRuntimeEvent,
  type RuntimeInfo,
} from "./shared/desktop-api";

const WINDOW_MIN_WIDTH = 900;
const WINDOW_MIN_HEIGHT = 640;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;
const launchedHidden = process.argv.includes("--hidden");
const DISABLED_DESKTOP_BEHAVIOR_POLICY: DesktopBehaviorPolicy = {
  allowBackgroundMode: false,
  allowLaunchAtLogin: false,
  allowNotifications: false,
};

let sourceNerveClient: SourceNerveClient | null = null;
let daemonManager: DaemonManager | null = null;
let workspaceManager: WorkspaceManager | null = null;
let taskManager: DesktopTaskManager | null = null;
let agentManager: DesktopAgentManager | null = null;
let codexHarnessRuntime: CodexHarnessRuntime | null = null;
let chatGptReviewWebDriver: ChatGptReviewWebDriver | null = null;
let chatGptReviewDriver: CompositeChatGptReviewDriver | null = null;
let chromeExtensionBridge: ChromeExtensionBridge | null = null;
let desktopControlBridge: DesktopControlBridge | null = null;
let codexSkillCache: CodexSkillCache | null = null;
let mcpExtensionManager: McpExtensionManager | null = null;
let providerWorkflowManager: ProviderWorkflowManager | null = null;
let pluginVerificationManager: PluginVerificationManager | null = null;
let migrationManager: MigrationManager | null = null;
let diagnosticsManager: DiagnosticsManager | null = null;
let crashMarkerStore: CrashMarkerStore | null = null;
let workspaceGrantManager: WorkspaceGrantManager | null = null;
let providerManager: ProviderManager | null = null;
let cloudflaredManager: CloudflaredManager | null = null;
let publicMcpManager: PublicMcpManager | null = null;
let runtimeLogStore: RuntimeLogStore | null = null;
let conversationActivityStore: ConversationActivityStore | null = null;
let desktopPreferences: DesktopPreferencesStore | null = null;
let backgroundController: BackgroundController | null = null;
let desktopBehaviorPolicy: DesktopBehaviorPolicy = { ...DISABLED_DESKTOP_BEHAVIOR_POLICY };
let runtimeEndpoints: RuntimeInfo["endpoints"];
let mainWindow: BrowserWindow | null = null;
let rendererDevServerUrl: string | undefined;
let rendererEntryUrl: string | undefined;
let allowQuitAfterShutdown = false;
let pendingShowRequest = false;
let bootstrapStatus: RuntimeInfo["bootstrap"] = {
  ready: false,
  error: "Desktop bootstrap has not initialized",
};
const operations = new OperationRegistry();

if (process.platform === "linux") {
  // Must match the installed/user desktop entry so GNOME/KDE associate
  // notifications and windows with the SourceNerve icon instead of a generic app.
  app.setDesktopName("sourcenerve.desktop");
}

const singleInstanceLock = app.requestSingleInstanceLock(
  sourceNerveSingleInstanceData(app.getVersion()),
);
let restartForNewerInstalledVersion = false;
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
    if (
      !restartForNewerInstalledVersion
      && shouldRestartForNewerInstalledInstance(app.getVersion(), additionalData)
    ) {
      restartForNewerInstalledVersion = true;
      app.relaunch();
      app.quit();
      return;
    }
    if (restartForNewerInstalledVersion) return;

    if (app.isReady()) showMainWindow();
    else pendingShowRequest = true;
  });
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

function publishChatGptTransportProgress(progress: ChatGptTransportProgress): void {
  publishMainRuntimeEvent({
    type: "chatgpt-progress",
    taskId: progress.taskId,
    runId: progress.runId,
    workspace: progress.workspace,
    kind: "response",
    text: progress.text,
    generating: progress.generating,
    stage: progress.generating ? "streaming" : "completed",
    ...(progress.itemId ? { itemId: progress.itemId } : {}),
  });
}

function publishMainRuntimeEvent(event: DesktopRuntimeEvent): void {
  const sanitized = sanitizeRuntimeEvent(
    event,
    app.isReady() ? app.getPath("home") : process.env.HOME,
  );
  const safeEvents = conversationActivityStore?.record(sanitized) ?? [sanitized];
  for (const safeEvent of safeEvents) {
    if (
      safeEvent.type === "state" &&
      safeEvent.component === "daemon" &&
      (safeEvent.state === "crashed" || safeEvent.state === "stopped")
    ) {
      const snapshot = daemonManager?.snapshot();
      if (snapshot) void crashMarkerStore?.recordDaemonSnapshot(snapshot).catch(() => undefined);
    }
    backgroundController?.handleRuntimeEvent(safeEvent);
    const logEntry = runtimeLogStore?.record(safeEvent) ?? null;
    publishRuntimeEvent(mainWindow, safeEvent);
    if (logEntry && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.runtimeLogEvent, logEntry);
    }
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
    icon: loadDesktopAppIcon(),
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
    const getLocalBearer = async () => {
      const bearer = await bootstrap.secretStore.get("localBearer");
      if (!bearer) throw new Error("SourceNerve local bearer is unavailable");
      return bearer;
    };
    runtimeEndpoints = {
      localApiUrl,
      localMcpUrl: `${localApiUrl}${bootstrap.profile.daemon.mcpPath}`,
    };
    sourceNerveClient = new SourceNerveClient({
      baseUrl: localApiUrl,
      getBearer: getLocalBearer,
    });
    mcpExtensionManager = new McpExtensionManager({
      client: new McpExtensionClient({
        baseUrl: localApiUrl,
        getBearer: getLocalBearer,
      }),
      secretStore: bootstrap.secretStore,
      onEvent: publishMainRuntimeEvent,
    });
    const daemonBinaryPath = resolveDaemonBinaryPath({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    daemonManager = new DaemonManager({
      binaryPath: daemonBinaryPath,
      expectedVersion: app.getVersion(),
      client: sourceNerveClient,
      onEvent: publishMainRuntimeEvent,
    });
    workspaceManager = new WorkspaceManager({
      bootstrap,
      daemon: daemonManager,
    });

    conversationActivityStore = new ConversationActivityStore(
      path.join(bootstrap.paths.managedDirectory, "conversation-activity.json"),
    );
    await conversationActivityStore.initialize();

    const codexUserData = app.getPath("userData");
    const codexCliManager = new CodexCliManager();
    codexSkillCache = new CodexSkillCache(path.join(codexUserData, "skills", "cache"));
    const codexRuntimePool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(bootstrap.paths.managedDirectory, "codex-threads.json")),
      clientVersion: app.getVersion(),
      hostFactory: (options) => new CodexAppServerHost({
        ...options,
        command: codexCliManager.command() ?? "codex",
      }),
      serverRequestHandler: async (context, request) => {
        if (!codexHarnessRuntime) throw new Error("Desktop Codex Harness runtime is not initialized");
        return codexHarnessRuntime.handleServerRequest(context, request);
      },
      eventHandler: (context, event) => {
        const progress = codexServerEventToRuntimeProgress(context, event);
        if (progress) publishMainRuntimeEvent(progress);
      },
    });
    const codexRunner = new CodexThinRunner(
      codexRuntimePool,
      new CodexSkillActivator(
        codexSkillCache,
        path.join(bootstrap.paths.managedDirectory, "codex-runs"),
      ),
    );
    codexHarnessRuntime = new CodexHarnessRuntime({
      runner: codexRunner,
      listWorkspaces: () => workspaceManager!.listManagedWorkspaces(),
      loadRun: async (runId) => parseHarnessRunSnapshot(await sourceNerveClient!.harnessRequest(
        "/api/v1/harness/runs/get",
        { run_id: runId },
      )),
      resolveApproval: async (input) => parseCodexNativeApprovalResolution(
        await sourceNerveClient!.harnessApprovalRequest(
          "/api/v1/harness/approvals/native/resolve",
          {
            run_id: input.runId,
            request_id: input.requestId,
            method: input.method,
            payload: input.payload,
          },
        ),
      ),
    });
    await codexHarnessRuntime.initialize();

    const npmSkillsManager = new NpmSkillsManager({
      root: path.join(bootstrap.paths.managedDirectory, "npm-skills"),
      cache: codexSkillCache,
      workspaces: workspaceManager,
    });
    await npmSkillsManager.initialize();

    desktopControlBridge = new DesktopControlBridge();
    chromeExtensionBridge = new ChromeExtensionBridge({ statePath: chromeExtensionBridgeStatePath(app.getPath("userData")), userDataPath: app.getPath("userData"), onProgress: publishChatGptTransportProgress });
    const extensionBridgeState = await chromeExtensionBridge.start();
    publishRuntimeEvent(mainWindow, {
      type: "state",
      component: "desktop",
      state: "chrome-extension-bridge-ready",
      message: JSON.stringify({ origin: extensionBridgeState.origin, tokenPrefix: extensionBridgeState.tokenPrefix }),
    });
    publishRuntimeEvent(mainWindow, {
      type: "state",
      component: "desktop",
      state: "desktop-control-ready",
      message: JSON.stringify(await desktopControlBridge.state()),
    });

    chatGptReviewWebDriver = new ChatGptReviewWebDriver({ onProgress: publishChatGptTransportProgress });
    chatGptReviewDriver = new CompositeChatGptReviewDriver({
      embedded: chatGptReviewWebDriver,
      chromeExtension: new ChromeExtensionReviewDriver(chromeExtensionBridge),
    });

    taskManager = new DesktopTaskManager({
      client: sourceNerveClient,
      workspaceManager,
      registry: new DesktopTaskRegistry(path.join(bootstrap.paths.managedDirectory, "desktop-tasks.json")),
      codex: codexHarnessRuntime,
      activityStore: conversationActivityStore,
      codexSetup: codexCliManager,
      chatGptReview: chatGptReviewDriver,
      npmSkillPreflight: (workspaceId, prompt) => npmSkillsManager.prepareWorkspaceSkills(workspaceId, prompt),
      skillPreflight: (workspaceId, prompt) => preparePluginSkillsForPrompt({
        manager: () => mcpExtensionManager,
        workspaces: () => workspaceManager,
        codexSkills: () => codexSkillCache,
        isTrustedSender: isTrustedIpcSender,
      }, workspaceId, prompt),
      onEvent: publishMainRuntimeEvent,
    });
    await taskManager.initialize();
    agentManager = new DesktopAgentManager(sourceNerveClient);
    migrationManager = new MigrationManager({
      bootstrap,
      daemon: daemonManager,
      daemonBinaryPath,
      onEvent: publishMainRuntimeEvent,
    });

    const launchPlan = await existingDaemonLaunchPlan(bootstrap);
    if (launchPlan) daemonManager.configure(launchPlan);

    workspaceGrantManager = new WorkspaceGrantManager({
      bootstrap,
      daemonManager,
      workspaceManager,
    });
    await workspaceGrantManager.initialize();
    const managedWorkspaces = await workspaceManager.listManagedWorkspaces();
    if (managedWorkspaces.length > 0) {
      await workspaceGrantManager.workspaceChanged();
    }

    providerManager = new ProviderManager({
      bootstrap,
      workspaceManager,
      openExternal: async (url) => shell.openExternal(url),
      onEvent: publishMainRuntimeEvent,
      onCredentialChanged: async () => {
        await workspaceGrantManager?.workspaceChanged();
      },
    });
    await providerManager.initialize();

    providerWorkflowManager = new ProviderWorkflowManager({
      client: new ProviderWorkflowClient({
        baseUrl: localApiUrl,
        getBearer: getLocalBearer,
      }),
      tasks: taskManager,
      workspaces: workspaceManager,
      providers: providerManager,
    });

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

    await mcpExtensionManager.initialize().catch((error) => {
      publishMainRuntimeEvent({
        type: "log",
        component: "desktop",
        level: "warn",
        message: `MCP extension credential restore deferred: ${error instanceof Error ? error.message : "gateway unavailable"}`,
        timestamp: new Date().toISOString(),
      });
    });

    await initializePluginHubRuntime({
      manager: () => mcpExtensionManager,
      workspaces: () => workspaceManager,
      codexSkills: () => codexSkillCache,
      isTrustedSender: isTrustedIpcSender,
    }).catch((error) => {
      publishMainRuntimeEvent({
        type: "log",
        component: "desktop",
        level: "warn",
        message: `Plugin skill workspace reconciliation deferred: ${error instanceof Error ? error.message : "plugin runtime unavailable"}`,
        timestamp: new Date().toISOString(),
      });
    });
    void refreshPluginWorkspaceScopes({
      manager: () => mcpExtensionManager,
      workspaces: () => workspaceManager,
      codexSkills: () => codexSkillCache,
      isTrustedSender: isTrustedIpcSender,
    }).catch((error) => {
      publishMainRuntimeEvent({
        type: "log",
        component: "desktop",
        level: "warn",
        message: `Automatic workspace skill install reconciliation deferred: ${error instanceof Error ? error.message : "plugin runtime unavailable"}`,
        timestamp: new Date().toISOString(),
      });
    });

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
        cloudflared: cloudflaredManager,
        onEvent: publishMainRuntimeEvent,
      });
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

    try {
      pluginVerificationManager = new PluginVerificationManager({
        bootstrap,
        publicMcp: () => publicMcpManager,
        daemon: () => daemonManager,
        client: () => sourceNerveClient,
        openExternal: async (url) => shell.openExternal(url),
      });
    } catch (error) {
      pluginVerificationManager = null;
      publishMainRuntimeEvent({
        type: "log",
        component: "desktop",
        level: "warn",
        message: `plugin verification unavailable: ${error instanceof Error ? error.message : "invalid product metadata"}`,
        timestamp: new Date().toISOString(),
      });
    }

    diagnosticsManager = new DiagnosticsManager({
      bootstrap,
      runtimeInfo: () => ({ ...runtimeInfo(), apiVersion: DESKTOP_API_VERSION }),
      packaged: app.isPackaged,
      daemon: () => daemonManager,
      client: () => sourceNerveClient,
      workspaceManager: () => workspaceManager,
      providerManager: () => providerManager,
      publicMcpManager: () => publicMcpManager,
      runtimeLogStore: () => runtimeLogStore,
      desktopPreferences: () => desktopPreferences,
      crashMarkerStore: () => crashMarkerStore,
    });
    await diagnosticsManager.initialize();

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
    taskManager = null;
    mcpExtensionManager = null;
    providerWorkflowManager = null;
    pluginVerificationManager = null;
    migrationManager = null;
    diagnosticsManager = null;
    workspaceGrantManager = null;
    providerManager = null;
    publicMcpManager = null;
    cloudflaredManager = null;
    conversationActivityStore = null;
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

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const logDirectory = path.join(userData, "logs");
  runtimeLogStore = new RuntimeLogStore(logDirectory, {
    homeDirectory: app.getPath("home"),
  });
  crashMarkerStore = new CrashMarkerStore(
    path.join(userData, "managed", "last-exit.json"),
    app.getPath("home"),
  );
  await crashMarkerStore.initialize().catch((error) => {
    crashMarkerStore = null;
    publishMainRuntimeEvent({
      type: "log",
      component: "desktop",
      level: "warn",
      message: error instanceof Error ? error.message : "Desktop crash marker could not be initialized",
      timestamp: new Date().toISOString(),
    });
  });
  desktopPreferences = new DesktopPreferencesStore(
    path.join(userData, "managed", "desktop-preferences.json"),
    process.platform,
  );
  await desktopPreferences.initialize();
  installSessionSecurity();
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
    workspaceGrantManager: () => workspaceGrantManager,
    providerManager: () => providerManager,
    publicMcpManager: () => publicMcpManager,
    desktopControlBridge: () => desktopControlBridge,
    chromeExtensionBridge: () => chromeExtensionBridge,
    runtimeLogStore: () => runtimeLogStore,
    workspaceSkillsChanged: () => refreshPluginWorkspaceScopes({
      manager: () => mcpExtensionManager,
      workspaces: () => workspaceManager,
      codexSkills: () => codexSkillCache,
      isTrustedSender: isTrustedIpcSender,
    }),
    isTrustedSender: isTrustedIpcSender,
    operations,
  });
  installMcpExtensionIpcHandlers({
    manager: () => mcpExtensionManager,
    workspaces: () => workspaceManager,
    codexSkills: () => codexSkillCache,
    isTrustedSender: isTrustedIpcSender,
  });
  installTaskIpcHandlers({
    manager: () => taskManager,
    isTrustedSender: isTrustedIpcSender,
  });
  installAgentIpcHandlers({
    manager: () => agentManager,
    isTrustedSender: isTrustedIpcSender,
  });
  installProviderWorkflowIpcHandlers({
    manager: () => providerWorkflowManager,
    isTrustedSender: isTrustedIpcSender,
  });
  installPluginVerificationIpcHandlers({
    manager: () => pluginVerificationManager,
    isTrustedSender: isTrustedIpcSender,
  });
  installBackgroundIpcHandlers({
    controller: () => backgroundController,
    isTrustedSender: isTrustedIpcSender,
  });
  installMigrationIpcHandlers({
    manager: () => migrationManager,
    isTrustedSender: isTrustedIpcSender,
    onApplied: async () => {
      await workspaceGrantManager?.workspaceChanged();
    },
  });
  installDiagnosticsIpcHandlers({
    manager: () => diagnosticsManager,
    isTrustedSender: isTrustedIpcSender,
  });

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
  await chromeExtensionBridge?.stop().catch(() => undefined);
  chatGptReviewDriver = null;
  await chatGptReviewWebDriver?.shutdown().catch(() => undefined);
  await codexHarnessRuntime?.shutdown().catch(() => undefined);
  await conversationActivityStore?.flush().catch(() => undefined);
  if (managedDaemon) await managedDaemon.stop().catch(() => undefined);
  await crashMarkerStore?.markClean().catch(() => undefined);
  await runtimeLogStore?.flush().catch(() => undefined);
}

app.on("window-all-closed", () => {
  if (allowQuitAfterShutdown) return;
  if (!backgroundController?.shouldKeepRunningWithoutWindows()) app.quit();
});
