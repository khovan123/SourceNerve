import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererEntry = path.join(desktopRoot, ".vite", "renderer", "main_window", "index.html");
const preloadEntry = path.join(desktopRoot, ".vite", "build", "preload.js");
const SELECTION_ID = "523e4567-e89b-42d3-a456-426614174000";
const HEAD = "a".repeat(40);
let mainWindow;
let backupCreated = false;
let migrationApplied = false;

const ok = (value) => ({ ok: true, value });
const failure = (message) => ({ ok: false, error: { code: "invalid_request", message, retryable: false } });

function handle(channel, handler) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return failure(error instanceof Error ? error.message : "E2E harness operation failed");
    }
  });
}

handle("desktop:runtime-info", () => ok({
  platform: process.platform,
  arch: process.arch,
  desktopVersion: "0.1.0-e2e",
  electronVersion: process.versions.electron,
  apiVersion: 11,
  bootstrap: { ready: true, profileSchemaVersion: 1, secureStorageBackend: "e2e-ephemeral" },
  endpoints: {
    localApiUrl: "http://127.0.0.1:7331",
    localMcpUrl: "http://127.0.0.1:7331/mcp",
    publicMcpResource: "https://sourcenerve.example.test/mcp",
  },
}));
handle("desktop:daemon-state", () => ok({ state: "ready", managed: true, pid: process.pid, version: "0.1.0-e2e" }));
handle("desktop:daemon-restart", () => ok({ state: "ready", managed: true, pid: process.pid, version: "0.1.0-e2e" }));
handle("desktop:daemon-start", () => ok({ state: "ready", managed: true }));
handle("desktop:daemon-stop", () => ok({ state: "stopped", managed: true }));
handle("desktop:daemon-attach-external", () => failure("not used in migration/recovery E2E"));
handle("desktop:daemon-health", () => ok({ status: "ok" }));
handle("desktop:service-status", () => ok({ identity: { version: "0.1.0-e2e", build: "e2e" } }));
handle("desktop:readiness", () => ok({ ready: true }));
handle("desktop:list-workspaces", () => ok([]));
handle("desktop:workspace-list-managed", () => ok([]));
handle("desktop:auth0-state", () => ok({ status: "signed-out", workspaceGrants: [] }));
handle("desktop:provider-states", () => ok([
  { provider: "github", status: "disconnected", baseUrl: "https://api.github.com" },
  { provider: "gitlab", status: "disconnected", baseUrl: "https://gitlab.com/api/v4" },
]));
handle("desktop:public-mcp-state", () => ok({ state: "not-enrolled", tunnelRunning: false }));
handle("desktop:behavior-state", () => ok({ backgroundMode: false, closeBehavior: "quit", launchAtLogin: false, notificationsEnabled: false }));
handle("desktop:behavior-update", (value) => ok(value));

handle("desktop:legacy-import-pick", () => ok({
  selectionId: SELECTION_ID,
  configPath: "/legacy/sourcenerve.toml",
  workspaces: [{
    id: "legacy-workspace",
    name: "Legacy Workspace",
    root: "/legacy/repository",
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    provider: "github",
    repository: "fogewise/legacy-repo",
    validation: { state: "ready" },
  }],
  state: {
    path: "/legacy/state/sourcenerve.sqlite3",
    databaseExists: true,
    status: "compatible",
    schemaVersion: 4,
    supportedSchemaVersion: 4,
    integrity: "ok",
    allowedStrategies: ["copy", "reference", "fresh"],
    recommendedStrategy: "copy",
  },
  legacyProduct: {
    serverBind: "127.0.0.1:7331",
    oauthIssuer: "https://legacy-auth.example.test/",
    oauthResource: "https://legacy.example.test/mcp",
    allowOperatorBearer: true,
    warnings: ["Legacy OAuth and server settings will not override Desktop product defaults."],
  },
  reconnect: {
    localBearer: true,
    auth0: true,
    providers: ["github"],
    shellEnvironmentInspected: false,
  },
  backupRequired: true,
}));
handle("desktop:legacy-import-apply", (input) => {
  if (input.selectionId !== SELECTION_ID) return failure("invalid one-shot migration selection");
  migrationApplied = true;
  return ok({
    importedWorkspaces: 1,
    stateStrategy: input.stateStrategy,
    statePath: "/desktop/state/sourcenerve.sqlite3",
    backupPath: "/desktop/backups/pre-import.sqlite3",
    sourceStateRemoved: false,
    reconnect: {
      localBearer: true,
      auth0: true,
      providers: ["github"],
      shellEnvironmentInspected: false,
    },
    rollback: ["Restore the pre-import backup.", "Remove the imported workspace registration."],
  });
});

handle("desktop:recovery-state", () => ok({
  crash: {
    previousMainExit: { clean: false, startedAt: "2026-08-20T00:00:00.000Z" },
    lastDaemonExit: { timestamp: "2026-08-20T00:01:00.000Z", state: "crashed", exitCode: 1, message: "simulated crash marker" },
  },
  ...(backupCreated ? { latestBackup: "backups/sourcenerve-e2e.sqlite3" } : {}),
  stateDirectoryHash: "state:e2e:hash",
  logsDirectoryHash: "logs:e2e:hash",
}));
handle("desktop:recovery-readiness", () => ok({
  checkedAt: new Date().toISOString(),
  health: "ok",
  serviceStatus: { identity: { version: "0.1.0-e2e" } },
  readiness: { ready: true },
}));
handle("desktop:recovery-backup-create-validate", () => {
  backupCreated = true;
  return ok({
    backup: "backups/sourcenerve-e2e.sqlite3",
    valid: true,
    bytes: 8192,
    integrity: "ok",
    migrationCount: 4,
    stateSchemaVersion: 4,
  });
});
handle("desktop:recovery-backup-validate-latest", () => ok({
  backup: "backups/sourcenerve-e2e.sqlite3",
  valid: true,
  bytes: 8192,
  integrity: "ok",
  migrationCount: 4,
  stateSchemaVersion: 4,
}));
handle("desktop:recovery-open-state-directory", () => ok({ opened: true }));
handle("desktop:recovery-open-logs-directory", () => ok({ opened: true }));
handle("desktop:recovery-reset-ui-settings", () => ok({ ok: true, message: "Desktop UI preferences reset.", affectedWorkspaces: 0 }));
handle("desktop:support-bundle-preview", () => ok({
  selectionId: "623e4567-e89b-42d3-a456-426614174000",
  generatedAt: new Date().toISOString(),
  bytes: 96,
  sha256: "b".repeat(64),
  formats: ["text", "zip"],
  text: "SourceNerve support bundle\nAuthorization: [REDACTED]\nrepositoryRootHash=repo:e2e\n",
}));
handle("desktop:support-bundle-export", (_selectionId, format) => ok({ saved: true, format, bytes: format === "zip" ? 128 : 96 }));
handle("desktop:diagnostics-copy", () => ok({ copied: true, characters: 96 }));
handle("desktop:runtime-logs", () => ok({ entries: [], droppedEntries: 0, maxEntries: 1000, maxBytes: 524288 }));
handle("desktop:cancel-operation", () => ok({ cancelled: true }));

for (const channel of [
  "desktop:workspace-pick-repository",
  "desktop:workspace-save",
  "desktop:workspace-remove",
  "desktop:provider-connect",
  "desktop:provider-disconnect",
  "desktop:provider-repositories",
  "desktop:provider-validate-repository",
  "desktop:provider-validate-transport",
  "desktop:auth0-sign-in",
  "desktop:auth0-refresh",
  "desktop:auth0-logout",
  "desktop:public-mcp-enroll",
  "desktop:public-mcp-retry",
  "desktop:public-mcp-rotate",
  "desktop:public-mcp-revoke",
  "desktop:public-mcp-re-enroll",
]) {
  handle(channel, () => failure(`migration/recovery E2E channel not exercised: ${channel}`));
}

app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  await mainWindow.loadFile(rendererEntry);
  mainWindow.webContents.executeJavaScript(`window.__E2E_MIGRATION_APPLIED__ = ${migrationApplied ? "true" : "false"}`);
});

app.on("window-all-closed", () => app.quit());
