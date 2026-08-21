import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererEntry = path.join(desktopRoot, ".vite", "renderer", "main_window", "index.html");
const preloadEntry = path.join(desktopRoot, ".vite", "build", "preload.js");
const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROPOSAL_ID = "223e4567-e89b-42d3-a456-426614174000";
const CHANGESET_ID = "323e4567-e89b-42d3-a456-426614174000";
const BASE_HEAD = "a".repeat(40);
const COMMIT_HEAD = "c".repeat(40);
const REVIEW_SHA = "d".repeat(64);
const PATCH_SHA = "e".repeat(64);
const NOW = 1_777_777_777;

let mainWindow;
let auth = { status: "signed-out" };
let publicMcp = { state: "not-enrolled", tunnelRunning: false };
let providers = [providerState("github"), providerState("gitlab")];
let workspace = null;
let task = null;
let proposal = null;
let pull = null;
let pluginVerified = false;
let challenge = { configured: false, verified: false };

const ok = (value) => ({ ok: true, value });
const failure = (message) => ({
  ok: false,
  error: { code: "invalid_request", message, retryable: false },
});

function providerState(provider, connected = false) {
  return connected
    ? {
        provider,
        status: "connected",
        baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4",
        login: "desktop-e2e",
        name: "Desktop E2E",
        providerUserId: "1001",
        connectedAt: NOW,
      }
    : {
        provider,
        status: "disconnected",
        baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4",
      };
}

function managedWorkspace(access = workspace?.access ?? "read-write") {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    root: "/tmp/sourcenerve-e2e-repo",
    access,
    remote: "origin",
    defaultBranch: "main",
    provider: "github",
    repository: "fogewise/source-nerve-e2e",
    validation: { state: "ready" },
    head: BASE_HEAD,
    branch: workspace.indexed ? "main" : "main",
    dirty: false,
    localWritable: access === "read-write",
    index: workspace.indexed
      ? { state: "current", indexedHead: BASE_HEAD, graphVersion: 7, parsedFiles: 3, failedFiles: 0 }
      : { state: "not-indexed" },
  };
}

function taskLifecycle() {
  const phase = task?.phase ?? "snapshot";
  return {
    taskId: TASK_ID,
    phase,
    ...(task?.branch ? { branch: task.branch } : {}),
    ...(task?.reviewed ? { reviewedDiffSha256: REVIEW_SHA } : {}),
    ...(task?.commit ? { commitSha: COMMIT_HEAD } : {}),
    ...(task?.pushed ? { pushSha: COMMIT_HEAD } : {}),
    ...(pull ? { pullNumber: pull.number, pullHeadSha: pull.headSha } : {}),
    ...(task?.merged ? { mergeSha: "f".repeat(40) } : {}),
    ...(task?.synced ? { defaultSyncedHead: "f".repeat(40) } : {}),
    provider: "github",
    updatedAt: NOW,
  };
}

function taskSnapshot() {
  if (!task) return null;
  return {
    task: {
      id: TASK_ID,
      workspace: workspace?.id ?? "e2e-workspace",
      baseHead: BASE_HEAD,
      graphVersion: 7,
      status: task.status,
      contextQuery: "quality gate",
      contextSha256: "b".repeat(64),
      createdAt: NOW,
      updatedAt: NOW,
    },
    proposals: proposal ? [{ ...proposal }] : [],
    events: [],
    lifecycle: taskLifecycle(),
  };
}

function taskList() {
  if (!task) return [];
  return [{
    taskId: TASK_ID,
    workspace: workspace?.id ?? "e2e-workspace",
    createdAt: new Date(NOW * 1000).toISOString(),
    snapshot: taskSnapshot(),
  }];
}

function pluginFields() {
  return {
    name: "SourceNerve",
    description: "Repository intelligence and guarded repository workflows through SourceNerve",
    publicMcpResource: "https://sourcenerve.example.test/mcp",
    oauthIssuer: "https://auth.sourcenerve.example.test/",
    oauthResource: "https://sourcenerve.example.test/mcp",
    oauthScopes: ["openid", "profile", "sourcenerve:read"],
    privacyUrl: "https://sourcenerve.example.test/privacy",
    termsUrl: "https://sourcenerve.example.test/terms",
    supportUrl: "https://sourcenerve.example.test/support",
    iconUrl: "https://sourcenerve.example.test/icon.svg",
    chatgptSetupUrl: "https://chatgpt.com/",
  };
}

function pluginView() {
  const accountReady = auth.status === "authenticated";
  const publicReady = publicMcp.state === "ready";
  const checks = [
    ["auth0", "SourceNerve account", accountReady],
    ["public-mcp", "Public MCP", publicReady],
    ["local-daemon", "Local SourceNerve daemon", pluginVerified],
    ["oauth-discovery", "OAuth issuer discovery", pluginVerified],
    ["privacy", "Privacy policy", pluginVerified],
    ["terms", "Terms of service", pluginVerified],
    ["support", "Support page", pluginVerified],
    ["icon", "Plugin icon", pluginVerified],
  ].map(([id, label, ready]) => ({
    id,
    label,
    state: ready ? "ready" : pluginVerified ? "error" : "not-checked",
    message: ready ? `${label} ready.` : "Run verification to check this requirement.",
  }));
  const ready = pluginVerified && accountReady && publicReady;
  return {
    status: ready ? "ready-to-connect" : "needs-attention",
    account: {
      status: auth.status,
      ...(auth.identity ? { identity: auth.identity } : {}),
      workspaceGrants: auth.workspaceGrants ?? [],
    },
    publicMcp,
    fields: pluginFields(),
    checks,
    challenge,
    ...(pluginVerified ? { lastVerifiedAt: new Date().toISOString() } : {}),
  };
}

function workflowState() {
  if (!task) throw new Error("task unavailable");
  return {
    taskId: TASK_ID,
    workspace: workspace.id,
    provider: "github",
    repository: "fogewise/source-nerve-e2e",
    defaultBranch: "main",
    lifecyclePhase: task.phase,
    ...(task.pushed ? { taskPushSha: COMMIT_HEAD } : {}),
    ...(task.branch ? { taskBranch: task.branch } : {}),
    ...(pull ? { pullNumber: pull.number, pullHeadSha: pull.headSha, pull } : {}),
    ...(task.merged ? { mergeSha: "f".repeat(40) } : {}),
    ...(task.synced ? { defaultSyncedHead: "f".repeat(40) } : {}),
  };
}

function emitState(component, state, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("desktop:runtime-event", {
    type: "state",
    component,
    state,
    ...(message ? { message } : {}),
  });
}

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
handle("desktop:daemon-start", () => ok({ state: "ready", managed: true }));
handle("desktop:daemon-stop", () => ok({ state: "stopped", managed: true }));
handle("desktop:daemon-restart", () => ok({ state: "ready", managed: true }));
handle("desktop:daemon-attach-external", () => failure("not used in E2E"));
handle("desktop:daemon-health", () => ok({ status: "ok" }));
handle("desktop:service-status", () => ok({ identity: { version: "0.1.0-e2e", build: "e2e" } }));
handle("desktop:readiness", () => ok({ ready: Boolean(workspace?.indexed) }));
handle("desktop:list-workspaces", () => ok(workspace ? [{ id: workspace.id, name: workspace.name, writable: workspace.access === "read-write" }] : []));
handle("desktop:workspace-list-managed", () => ok(workspace ? [managedWorkspace()] : []));
handle("desktop:workspace-pick-repository", () => ok({
  selectionId: "423e4567-e89b-42d3-a456-426614174000",
  root: "/tmp/sourcenerve-e2e-repo",
  suggestedId: "e2e-workspace",
  suggestedName: "E2E Workspace",
  remote: "origin",
  remotes: ["origin"],
  defaultBranch: "main",
  provider: "github",
  repository: "fogewise/source-nerve-e2e",
  head: BASE_HEAD,
  branch: "main",
  dirty: false,
  localWritable: true,
}));
handle("desktop:workspace-save", (input) => {
  workspace = { id: input.id, name: input.name, access: input.access, indexed: false };
  emitState("workspace", "ready");
  return ok(managedWorkspace());
});
handle("desktop:workspace-remove", () => {
  workspace = null;
  emitState("workspace", "removed");
  return ok({ removed: true });
});
handle("desktop:workspace-index", () => {
  workspace.indexed = true;
  emitState("workspace", "indexed");
  return ok({
    workspace: workspace.id,
    head: BASE_HEAD,
    discoveredFiles: 3,
    indexedTextFiles: 3,
    graph: { parsedFiles: 3, partialFiles: 0, failedFiles: 0, symbols: 7, edges: 3, unresolvedReferences: 0 },
  });
});
handle("desktop:provider-validate-transport", () => ok({ workspace: workspace?.id ?? "e2e-workspace", ready: true, transport: "https", message: "E2E transport ready" }));
handle("desktop:cancel-operation", () => ok({ cancelled: true }));

handle("desktop:auth0-state", () => ok(auth));
handle("desktop:auth0-sign-in", () => {
  auth = {
    status: "authenticated",
    identity: { subject: "auth0|desktop-e2e", name: "Desktop E2E", email: "desktop-e2e@example.invalid" },
    expiresAt: NOW + 3600,
    scopes: ["openid", "profile", "email"],
    workspaceGrants: workspace ? [{ workspace: workspace.id, access: workspace.access }] : [],
  };
  emitState("auth", "authenticated");
  return ok(auth);
});
handle("desktop:auth0-refresh", () => ok(auth));
handle("desktop:auth0-logout", () => {
  auth = { status: "signed-out" };
  emitState("auth", "signed-out");
  return ok(auth);
});

handle("desktop:provider-states", () => ok(providers));
handle("desktop:provider-connect", (provider) => {
  providers = providers.map((item) => item.provider === provider ? providerState(provider, true) : item);
  emitState("provider", "connected");
  return ok(providers.find((item) => item.provider === provider));
});
handle("desktop:provider-disconnect", (provider) => {
  providers = providers.map((item) => item.provider === provider ? providerState(provider, false) : item);
  emitState("provider", "disconnected");
  return ok(providers.find((item) => item.provider === provider));
});
handle("desktop:provider-repositories", (provider) => ok([{
  provider,
  slug: "fogewise/source-nerve-e2e",
  name: "source-nerve-e2e",
  defaultBranch: "main",
  private: true,
  writable: true,
  webUrl: "https://github.com/fogewise/source-nerve-e2e",
  httpsCloneUrl: "https://github.com/fogewise/source-nerve-e2e.git",
}])) ;
handle("desktop:provider-validate-repository", (provider, repository) => ok({
  provider,
  slug: repository,
  name: repository.split("/").at(-1),
  defaultBranch: "main",
  private: true,
  writable: true,
  webUrl: `https://github.com/${repository}`,
}));

handle("desktop:public-mcp-state", () => ok(publicMcp));
for (const channel of ["desktop:public-mcp-enroll", "desktop:public-mcp-retry", "desktop:public-mcp-rotate", "desktop:public-mcp-re-enroll"]) {
  handle(channel, () => {
    publicMcp = {
      state: "ready",
      tunnelRunning: true,
      hostname: "sourcenerve.example.test",
      publicMcpUrl: "https://sourcenerve.example.test/mcp",
      lastCheckedAt: Date.now(),
      message: "E2E public MCP ready",
    };
    emitState("public-mcp", "ready");
    return ok(publicMcp);
  });
}
handle("desktop:public-mcp-revoke", () => {
  publicMcp = { state: "revoked", tunnelRunning: false };
  emitState("public-mcp", "revoked");
  return ok(publicMcp);
});

handle("desktop:plugin-verification-state", () => ok(pluginView()));
handle("desktop:plugin-verification-run", () => {
  pluginVerified = true;
  const view = pluginView();
  return ok({ view, toolCount: 12, serverName: "sourcenerve", serverVersion: "0.1.0-e2e" });
});
handle("desktop:plugin-verification-copy-fields", () => {
  const text = JSON.stringify(pluginFields());
  clipboard.writeText(text);
  return ok({ copied: true, characters: text.length });
});
handle("desktop:plugin-verification-open-chatgpt", () => ok({ opened: true }));
handle("desktop:plugin-verification-export-icon", () => ok({ saved: true, bytes: 512 }));
handle("desktop:plugin-domain-challenge-set", () => {
  challenge = { configured: true, verified: true, lastVerifiedAt: new Date().toISOString() };
  return ok({ ...challenge, message: "E2E domain challenge verified." });
});
handle("desktop:plugin-domain-challenge-verify", () => ok({ ...challenge, message: challenge.verified ? "E2E domain challenge verified." : "Not configured." }));
handle("desktop:plugin-domain-challenge-remove", () => {
  challenge = { configured: false, verified: false };
  return ok({ ...challenge, message: "E2E domain challenge removed." });
});

handle("desktop:tasks-list", () => ok(taskList()));
handle("desktop:tasks-begin", () => {
  task = { status: "active", phase: "snapshot" };
  emitState("task", "ready");
  return ok({ snapshot: taskSnapshot(), replayed: false });
});
handle("desktop:tasks-remember", () => ok(taskSnapshot()));
handle("desktop:tasks-get", () => ok(taskSnapshot()));
handle("desktop:tasks-cancel", () => {
  task.status = "cancelled";
  return ok(taskSnapshot());
});
handle("desktop:tasks-branch", (input) => {
  task.branch = input.branch;
  task.phase = "branched";
  return ok({ lifecycle: taskLifecycle(), replayed: false });
});
handle("desktop:tasks-propose", (input) => {
  proposal = {
    id: PROPOSAL_ID,
    taskId: TASK_ID,
    expectedHead: BASE_HEAD,
    patchSha256: PATCH_SHA,
    changedPaths: input.expectedFiles.map((item) => item.path),
    status: "proposed",
    createdAt: NOW,
  };
  return ok({ proposal: { ...proposal }, replayed: false });
});
handle("desktop:tasks-apply", () => {
  proposal.status = "applied";
  proposal.changesetId = CHANGESET_ID;
  proposal.appliedAt = NOW;
  task.status = "applied";
  task.phase = "patched";
  return ok({
    taskId: TASK_ID,
    proposalId: PROPOSAL_ID,
    changesetId: CHANGESET_ID,
    head: BASE_HEAD,
    changedPaths: [...proposal.changedPaths],
    diff: "diff --git a/e2e.txt b/e2e.txt\nnew file mode 100644\n+quality gate\n",
  });
});
handle("desktop:tasks-review", () => {
  task.reviewed = true;
  task.phase = "reviewed";
  return ok({
    lifecycle: taskLifecycle(),
    review: {
      workspace: workspace.id,
      branch: task.branch,
      head: BASE_HEAD,
      dirty: true,
      status: "A  e2e.txt",
      diff: "diff --git a/e2e.txt b/e2e.txt\nnew file mode 100644\n+quality gate\n",
      diffSha256: REVIEW_SHA,
    },
    replayed: false,
  });
});
handle("desktop:tasks-commit", () => {
  task.commit = true;
  task.phase = "committed";
  return ok({
    lifecycle: taskLifecycle(),
    commit: {
      workspace: workspace.id,
      branch: task.branch,
      parentHead: BASE_HEAD,
      commit: COMMIT_HEAD,
      clean: true,
      status: "",
    },
    replayed: false,
  });
});
handle("desktop:tasks-push", () => {
  task.pushed = true;
  task.phase = "pushed";
  return ok({
    lifecycle: taskLifecycle(),
    push: { workspace: workspace.id, remote: "origin", branch: task.branch, head: COMMIT_HEAD },
    replayed: false,
  });
});
handle("desktop:intelligence-read-file", () => ok({ path: "existing.txt", sha256: "1".repeat(64), startLine: 1, endLine: 1, content: "existing" }));

handle("desktop:provider-workflow-state", () => ok(workflowState()));
handle("desktop:provider-workflow-issue-create", (input) => ok({
  issue: { provider: "github", repository: "fogewise/source-nerve-e2e", number: 71, title: input.title, state: "open", url: "https://github.com/fogewise/source-nerve-e2e/issues/71" },
  replayed: false,
}));
handle("desktop:provider-workflow-pull-create", (input) => {
  pull = {
    provider: "github",
    repository: "fogewise/source-nerve-e2e",
    number: 79,
    title: input.title,
    state: "open",
    draft: Boolean(input.draft),
    baseBranch: "main",
    headBranch: task.branch,
    headSha: COMMIT_HEAD,
    mergeable: true,
    mergeState: "clean",
    url: "https://github.com/fogewise/source-nerve-e2e/pull/79",
  };
  task.phase = "pr_open";
  return ok({ pull: { ...pull }, replayed: false });
});
handle("desktop:provider-workflow-pull-refresh", () => ok({ ...pull }));
handle("desktop:provider-workflow-pull-merge", (input) => {
  if (!pull || input.expectedHeadSha !== pull.headSha) return failure("Pull head changed; refresh before merge");
  pull = { ...pull, state: "merged", mergeable: false, mergeState: "merged" };
  task.merged = true;
  task.phase = "merged";
  return ok({ pull: { ...pull }, mergeSha: "f".repeat(40), replayed: false });
});
handle("desktop:provider-workflow-default-sync", () => {
  task.synced = true;
  task.phase = "completed";
  return ok({ taskId: TASK_ID, workspace: workspace.id, defaultBranch: "main", head: "f".repeat(40), replayed: false });
});

for (const channel of [
  "desktop:runtime-logs",
  "desktop:diagnostics-copy",
  "desktop:support-bundle-preview",
  "desktop:recovery-state",
  "desktop:recovery-rebuild-indexes",
  "desktop:recovery-backup-create-validate",
  "desktop:recovery-backup-validate-latest",
  "desktop:recovery-open-state-directory",
  "desktop:recovery-open-logs-directory",
  "desktop:recovery-reset-ui-settings",
  "desktop:recovery-readiness",
  "desktop:behavior-state",
  "desktop:behavior-update",
  "desktop:legacy-import-pick",
]) {
  handle(channel, () => failure(`E2E harness channel not exercised: ${channel}`));
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
});

app.on("window-all-closed", () => app.quit());
