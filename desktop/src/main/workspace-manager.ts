import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";

import type {
  DesktopError,
  DesktopRuntimeEvent,
  ManagedWorkspaceView,
  WorkspaceIndexResult,
  WorkspaceProvider,
  WorkspaceRepositorySelection,
  WorkspaceSaveInput,
} from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import type { ManagedWorkspace } from "./runtime-profile";
import type { SourceNerveClient } from "./sourcenerve-client";
import type { OperationRegistry } from "./ipc";
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from "./workspace-store";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const SELECTION_TTL_MS = 10 * 60_000;
const MAX_PENDING_SELECTIONS = 32;
const WORKSPACE_INDEX_OPERATION_PREFIX = "workspace-index.";
const REMOTE_HEAD_TIMEOUT_MS = 5_000;
const COMMON_DEFAULT_BRANCHES = ["main", "master", "trunk"] as const;
const DAEMON_STABLE_TIMEOUT_MS = 25_000;
const DAEMON_STABLE_POLL_MS = 100;
const BACKGROUND_INDEX_INITIAL_DELAY_MS = 5_000;
const BACKGROUND_INDEX_INTERVAL_MS = 30_000;
const WORKSPACE_ID_PATH_HASH_CHARS = 10;

interface RepositoryInspection {
  root: string;
  remotes: string[];
  defaultRemote: string;
  defaultBranch: string;
  provider?: WorkspaceProvider;
  repository?: string;
  head: string;
  branch?: string;
  dirty: boolean;
  localWritable: boolean;
}

interface PendingSelection {
  root: string;
  expiresAt: number;
}

export class WorkspaceManagerError extends Error {
  readonly desktopError: DesktopError;

  constructor(
    code: DesktopError["code"],
    message: string,
    options: { retryable?: boolean; fieldDetails?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "WorkspaceManagerError";
    this.desktopError = {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.fieldDetails ? { fieldDetails: options.fieldDetails } : {}),
    };
  }
}

export class WorkspaceManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly daemon: DaemonManager;
  private readonly client: SourceNerveClient;
  private readonly operations: OperationRegistry;
  private readonly onEvent: (event: DesktopRuntimeEvent) => void;
  private readonly onWorkspaceIndexed?: (workspaceId: string) => Promise<void> | void;
  private readonly now: () => number;
  private readonly pendingSelections = new Map<string, PendingSelection>();
  private readonly activeIndexes = new Map<string, Promise<WorkspaceIndexResult>>();
  private readonly backgroundIndexErrors = new Map<string, string>();
  private backgroundIndexTimer: NodeJS.Timeout | null = null;
  private backgroundIndexSweep: Promise<void> | null = null;

  constructor(options: {
    bootstrap: DesktopBootstrapState;
    daemon: DaemonManager;
    client: SourceNerveClient;
    operations: OperationRegistry;
    onEvent: (event: DesktopRuntimeEvent) => void;
    onWorkspaceIndexed?: (workspaceId: string) => Promise<void> | void;
    now?: () => number;
  }) {
    this.bootstrap = options.bootstrap;
    this.daemon = options.daemon;
    this.client = options.client;
    this.operations = options.operations;
    this.onEvent = options.onEvent;
    this.onWorkspaceIndexed = options.onWorkspaceIndexed;
    this.now = options.now ?? Date.now;
    this.scheduleBackgroundIndex(BACKGROUND_INDEX_INITIAL_DELAY_MS);
  }

  async stageRepositorySelection(selectedPath: string): Promise<WorkspaceRepositorySelection> {
    this.pruneExpiredSelections();
    if (this.pendingSelections.size >= MAX_PENDING_SELECTIONS) {
      throw new WorkspaceManagerError(
        "invalid_request",
        "Too many pending repository selections. Close unused workspace forms and try again.",
      );
    }

    const inspection = await inspectRepository(selectedPath);
    const selectionId = randomUUID();
    this.pendingSelections.set(selectionId, {
      root: inspection.root,
      expiresAt: this.now() + SELECTION_TTL_MS,
    });
    return toRepositorySelection(selectionId, inspection);
  }

  async listManagedWorkspaces(): Promise<ManagedWorkspaceView[]> {
    const workspaces = (await loadWorkspaceRegistry(this.bootstrap.paths.workspaceRegistryPath)) ?? [];
    const daemonState = this.daemon.snapshot().state;
    const canQueryRuntime = daemonState === "ready" || daemonState === "external";

    const views: ManagedWorkspaceView[] = [];
    for (const workspace of workspaces) {
      try {
        const inspection = await inspectRepository(workspace.root, workspace.remote, workspace.defaultBranch);
        let index: ManagedWorkspaceView["index"] = { state: "unavailable" };
        if (canQueryRuntime) {
          try {
            const graph = await this.client.workspaceGraphStatus(workspace.id);
            const state = !graph.indexedHead
              ? "not-indexed"
              : graph.indexedHead === inspection.head
                ? "current"
                : "stale";
            index = {
              state,
              ...(graph.indexedHead ? { indexedHead: graph.indexedHead } : {}),
              graphVersion: graph.graphVersion,
              parsedFiles: graph.parsedFiles,
              failedFiles: graph.failedFiles,
            };
          } catch {
            index = { state: "unavailable" };
          }
        }
        views.push(toManagedWorkspaceView(workspace, inspection, index));
      } catch (error) {
        views.push({
          id: workspace.id,
          name: workspace.name,
          root: workspace.root,
          access: workspace.access,
          remote: workspace.remote,
          defaultBranch: workspace.defaultBranch,
          ...(workspace.provider ? { provider: workspace.provider } : {}),
          ...(workspace.repository ? { repository: workspace.repository } : {}),
          validation: {
            state: "invalid",
            message: safeRepositoryValidationMessage(error),
          },
          index: { state: "unavailable" },
        });
      }
    }
    return views;
  }

  async saveWorkspace(input: WorkspaceSaveInput): Promise<ManagedWorkspaceView> {
    const previousRegistry = await this.requireManagedRegistryForMutation();
    const original = input.originalId
      ? previousRegistry.find((workspace) => workspace.id === input.originalId)
      : undefined;
    if (input.originalId && !original) {
      throw new WorkspaceManagerError("not_found", "Workspace is no longer registered.");
    }

    const root = input.selectionId
      ? this.consumeSelection(input.selectionId)
      : original?.root;
    if (!root) {
      throw new WorkspaceManagerError(
        "invalid_request",
        "Choose a repository with the native directory picker before saving this workspace.",
        { fieldDetails: { repository: "repository selection is required" } },
      );
    }

    const inspection = await inspectRepository(root, input.remote, input.defaultBranch);
    if (input.access === "read-write" && !inspection.localWritable) {
      throw new WorkspaceManagerError(
        "forbidden",
        "The selected repository is not locally writable. Choose read-only access or repair filesystem permissions.",
        { fieldDetails: { access: "repository is not writable" } },
      );
    }

    const duplicateId = previousRegistry.find(
      (workspace) => workspace.id === input.id && workspace.id !== input.originalId,
    );
    if (duplicateId) {
      throw new WorkspaceManagerError("invalid_request", "Workspace ID is already in use.", {
        fieldDetails: { id: "duplicate workspace id" },
      });
    }

    for (const workspace of previousRegistry) {
      if (workspace.id === input.originalId) continue;
      try {
        if ((await realpath(workspace.root)) === inspection.root) {
          throw new WorkspaceManagerError(
            "invalid_request",
            "This repository is already registered as another workspace.",
            { fieldDetails: { repository: "duplicate repository root" } },
          );
        }
      } catch (error) {
        if (error instanceof WorkspaceManagerError) throw error;
      }
    }

    const nextWorkspace: ManagedWorkspace = {
      id: input.id,
      name: input.name.trim(),
      root: inspection.root,
      access: input.access,
      remote: input.remote,
      defaultBranch: input.defaultBranch,
      ...(inspection.provider ? { provider: inspection.provider } : {}),
      ...(inspection.repository ? { repository: inspection.repository } : {}),
    };
    const nextRegistry = original
      ? previousRegistry.map((workspace) => workspace.id === input.originalId ? nextWorkspace : workspace)
      : [...previousRegistry, nextWorkspace];

    await this.applyRegistryTransaction(previousRegistry, nextRegistry);

    const [view] = await this.viewConfiguredWorkspace(nextWorkspace);
    this.scheduleBackgroundIndex(BACKGROUND_INDEX_INITIAL_DELAY_MS);
    return view;
  }

  async removeWorkspace(workspaceId: string): Promise<{ removed: boolean }> {
    const previousRegistry = await this.requireManagedRegistryForMutation();
    if (!previousRegistry.some((workspace) => workspace.id === workspaceId)) return { removed: false };
    const nextRegistry = previousRegistry.filter((workspace) => workspace.id !== workspaceId);
    await this.applyRegistryTransaction(previousRegistry, nextRegistry);
    this.backgroundIndexErrors.delete(workspaceId);
    return { removed: true };
  }

  indexWorkspace(workspaceId: string): Promise<WorkspaceIndexResult> {
    const active = this.activeIndexes.get(workspaceId);
    if (active) return active;
    const operation = this.runIndexWorkspace(workspaceId);
    this.activeIndexes.set(workspaceId, operation);
    void operation.finally(() => {
      if (this.activeIndexes.get(workspaceId) === operation) this.activeIndexes.delete(workspaceId);
    }).catch(() => undefined);
    return operation;
  }

  private async runIndexWorkspace(workspaceId: string): Promise<WorkspaceIndexResult> {
    const registry = await this.requireManagedRegistry();
    const workspace = registry.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new WorkspaceManagerError("not_found", "Workspace is not registered.");

    await inspectRepository(workspace.root, workspace.remote, workspace.defaultBranch);
    const daemon = await this.waitForDaemonStable(true);
    if (daemon.state !== "ready" && daemon.state !== "external") {
      throw new WorkspaceManagerError("not_ready", "SourceNerve daemon must be ready before indexing a workspace.", { retryable: true });
    }

    const active = await this.client.listWorkspaces();
    if (!active.some((candidate) => candidate.id === workspaceId)) {
      throw new WorkspaceManagerError("not_ready", "The running SourceNerve daemon does not contain this workspace. Apply the managed configuration first.", { retryable: true });
    }

    const operationId = `${WORKSPACE_INDEX_OPERATION_PREFIX}${workspaceId}`;
    let signal: AbortSignal;
    try {
      signal = this.operations.start(operationId);
    } catch {
      throw new WorkspaceManagerError("invalid_request", "Workspace indexing operation is already active.", { retryable: true });
    }
    this.onEvent({ type: "progress", operationId, stage: "index-started", current: 0, total: 100 });
    const progressController = new AbortController();
    const progressRelay = this.relayWorkspaceIndexProgress(workspaceId, operationId, progressController.signal);
    try {
      const result = await this.client.indexWorkspace(workspaceId, signal);
      progressController.abort();
      await progressRelay;
      this.onEvent({ type: "progress", operationId, stage: "index-complete", current: 100, total: 100 });
      this.onEvent({ type: "state", component: "workspace", state: "indexed", message: workspaceId });
      if (this.onWorkspaceIndexed) {
        void Promise.resolve(this.onWorkspaceIndexed(workspaceId)).catch(() => undefined);
      }
      return result;
    } catch (error) {
      progressController.abort();
      await progressRelay;
      if (signal.aborted) {
        this.onEvent({ type: "progress", operationId, stage: "index-cancelled" });
        throw new WorkspaceManagerError("cancelled", "Workspace indexing was cancelled.", { retryable: true });
      }
      this.onEvent({ type: "progress", operationId, stage: "index-failed" });
      throw error;
    } finally {
      this.operations.finish(operationId);
    }
  }

  private async relayWorkspaceIndexProgress(
    workspaceId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let lastProgressKey = "";
    while (!signal.aborted) {
      try {
        const progress = await this.client.workspaceIndexProgress(workspaceId, signal);
        if (progress.active && progress.total > 0) {
          const progressKey = `${progress.stage}:${progress.current}:${progress.total}`;
          if (progressKey !== lastProgressKey) {
            lastProgressKey = progressKey;
            this.onEvent({
              type: "progress",
              operationId,
              stage: progress.stage,
              current: progress.current,
              total: progress.total,
            });
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await delay(150);
    }
  }

  private scheduleBackgroundIndex(delayMs: number): void {
    if (this.backgroundIndexTimer) clearTimeout(this.backgroundIndexTimer);
    const timer = setTimeout(() => {
      if (this.backgroundIndexTimer === timer) this.backgroundIndexTimer = null;
      void this.runBackgroundIndexSweep();
    }, delayMs);
    timer.unref();
    this.backgroundIndexTimer = timer;
  }

  private runBackgroundIndexSweep(): Promise<void> {
    const active = this.backgroundIndexSweep;
    if (active) return active;
    const sweep = this.backgroundIndexStaleWorkspaces();
    this.backgroundIndexSweep = sweep;
    void sweep
      .catch((error) => this.reportBackgroundIndexError("runtime", error))
      .finally(() => {
        if (this.backgroundIndexSweep === sweep) this.backgroundIndexSweep = null;
        this.scheduleBackgroundIndex(BACKGROUND_INDEX_INTERVAL_MS);
      });
    return sweep;
  }

  private async backgroundIndexStaleWorkspaces(): Promise<void> {
    const daemon = this.daemon.snapshot();
    if (daemon.state !== "ready" && daemon.state !== "external") return;

    const [registry, active] = await Promise.all([
      this.requireManagedRegistry(),
      this.client.listWorkspaces(),
    ]);
    const activeIds = new Set(active.map((workspace) => workspace.id));

    for (const workspace of registry) {
      if (!activeIds.has(workspace.id)) continue;
      try {
        const inspection = await inspectRepository(
          workspace.root,
          workspace.remote,
          workspace.defaultBranch,
        );
        const graph = await this.client.workspaceGraphStatus(workspace.id);
        if (graph.indexedHead === inspection.head) {
          this.backgroundIndexErrors.delete(workspace.id);
          continue;
        }
        await this.indexWorkspace(workspace.id);
        this.backgroundIndexErrors.delete(workspace.id);
      } catch (error) {
        this.reportBackgroundIndexError(workspace.id, error);
      }
    }
  }

  private reportBackgroundIndexError(workspaceId: string, error: unknown): void {
    const message = error instanceof Error && error.message
      ? error.message
      : "unknown background indexing error";
    if (this.backgroundIndexErrors.get(workspaceId) === message) return;
    this.backgroundIndexErrors.set(workspaceId, message);
    this.onEvent({
      type: "log",
      component: "desktop",
      level: "warn",
      message: `Background index deferred for ${workspaceId}: ${message}`,
      timestamp: new Date().toISOString(),
    });
  }

  private async viewConfiguredWorkspace(workspace: ManagedWorkspace): Promise<[ManagedWorkspaceView, RepositoryInspection]> {
    const inspection = await inspectRepository(workspace.root, workspace.remote, workspace.defaultBranch);
    let index: ManagedWorkspaceView["index"] = { state: "unavailable" };
    const daemonState = this.daemon.snapshot().state;
    if (daemonState === "ready" || daemonState === "external") {
      try {
        const graph = await this.client.workspaceGraphStatus(workspace.id);
        index = {
          state: !graph.indexedHead ? "not-indexed" : graph.indexedHead === inspection.head ? "current" : "stale",
          ...(graph.indexedHead ? { indexedHead: graph.indexedHead } : {}),
          graphVersion: graph.graphVersion,
          parsedFiles: graph.parsedFiles,
          failedFiles: graph.failedFiles,
        };
      } catch {
        index = { state: "unavailable" };
      }
    }
    return [toManagedWorkspaceView(workspace, inspection, index), inspection];
  }

  private async requireManagedRegistry(): Promise<ManagedWorkspace[]> {
    return (await loadWorkspaceRegistry(this.bootstrap.paths.workspaceRegistryPath)) ?? [];
  }

  private async requireManagedRegistryForMutation(): Promise<ManagedWorkspace[]> {
    const registry = await loadWorkspaceRegistry(this.bootstrap.paths.workspaceRegistryPath);
    if (registry !== null) return registry;
    if (await fileExists(this.bootstrap.paths.configPath)) {
      throw new WorkspaceManagerError("invalid_request", "An existing unmanaged SourceNerve configuration was found. Import it before using the managed workspace editor.");
    }
    return [];
  }

  private consumeSelection(selectionId: string): string {
    this.pruneExpiredSelections();
    const selection = this.pendingSelections.get(selectionId);
    if (!selection) {
      throw new WorkspaceManagerError("invalid_request", "Repository selection expired. Choose the repository again.", { fieldDetails: { repository: "selection expired" } });
    }
    this.pendingSelections.delete(selectionId);
    return selection.root;
  }

  private pruneExpiredSelections(): void {
    const now = this.now();
    for (const [id, selection] of this.pendingSelections) if (selection.expiresAt <= now) this.pendingSelections.delete(id);
  }

  private async applyRegistryTransaction(_previousRegistry: ManagedWorkspace[], nextRegistry: ManagedWorkspace[]): Promise<void> {
    await this.waitForDaemonStable(false);
    // The managed workspace registry is the durable source of truth. Runtime
    // materialization is owned by WorkspaceGrantManager so a workspace mutation
    // produces exactly one config write/restart after grants are reconciled.
    // Never roll the registry back because a later daemon activation is transient.
    await saveWorkspaceRegistry(this.bootstrap.paths.workspaceRegistryPath, nextRegistry);
  }

  private async waitForDaemonStable(allowExternal: boolean) {
    const deadline = Date.now() + DAEMON_STABLE_TIMEOUT_MS;
    while (true) {
      const snapshot = this.daemon.snapshot();
      if (snapshot.state === "incompatible") {
        throw new WorkspaceManagerError(
          "not_ready",
          "The running SourceNerve daemon is incompatible with this Desktop build.",
          { retryable: true },
        );
      }
      if (!snapshot.managed && snapshot.state === "external" && !allowExternal) {
        throw new WorkspaceManagerError(
          "not_ready",
          "A SourceNerve daemon not owned by this Desktop is running. Stop it before changing managed workspaces.",
          { retryable: true },
        );
      }
      if (snapshot.state !== "starting" && snapshot.state !== "stopping") return snapshot;
      if (Date.now() >= deadline) {
        throw new WorkspaceManagerError(
          "not_ready",
          "SourceNerve daemon is still changing state. Wait for the current runtime operation to finish and retry.",
          { retryable: true },
        );
      }
      await delay(DAEMON_STABLE_POLL_MS);
    }
  }
}

export async function inspectRepository(
  selectedPath: string,
  requestedRemote?: string,
  requestedDefaultBranch?: string,
): Promise<RepositoryInspection> {
  let canonical: string;
  try {
    canonical = await realpath(selectedPath);
  } catch {
    throw new WorkspaceManagerError("invalid_request", "The selected repository directory is unavailable.");
  }
  const topLevelRaw = await gitRequired(canonical, ["rev-parse", "--show-toplevel"], "The selected directory is not a Git repository.");
  let topLevel: string;
  try {
    topLevel = await realpath(topLevelRaw.trim());
  } catch {
    throw new WorkspaceManagerError("invalid_request", "The selected Git repository root is unavailable.");
  }
  if (topLevel !== canonical) throw new WorkspaceManagerError("invalid_request", "Choose the Git repository root rather than a subdirectory.");
  const head = (await gitRequired(canonical, ["rev-parse", "--verify", "HEAD"], "The selected repository has no commit to index.")).trim();
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new WorkspaceManagerError("invalid_request", "The selected repository HEAD is invalid.");
  const remotes = (await gitRequired(canonical, ["remote"], "Unable to inspect Git remotes."))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.length === 0) throw new WorkspaceManagerError("invalid_request", "The selected repository must have at least one configured Git remote.");
  const remote = requestedRemote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
  if (!remotes.includes(remote)) {
    throw new WorkspaceManagerError("invalid_request", "The selected Git remote no longer exists.", { fieldDetails: { remote: "remote is not configured" } });
  }
  const branch = await gitOptional(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const defaultBranch = requestedDefaultBranch ?? (await discoverDefaultBranch(canonical, remote, branch));
  if (!defaultBranch) {
    throw new WorkspaceManagerError("invalid_request", "Unable to determine the repository default branch. Select a valid branch explicitly.", { fieldDetails: { defaultBranch: "default branch could not be detected" } });
  }
  await validateBranchExists(canonical, remote, defaultBranch);
  const remoteUrl = (await gitRequired(canonical, ["remote", "get-url", remote], "Unable to inspect the selected Git remote.")).trim();
  const providerMetadata = providerFromRemoteUrl(remoteUrl);
  const status = await gitRequired(canonical, ["status", "--porcelain=v1"], "Unable to inspect repository status.");
  return {
    root: canonical,
    remotes,
    defaultRemote: remote,
    defaultBranch,
    ...providerMetadata,
    head,
    ...(branch ? { branch } : {}),
    dirty: status.length > 0,
    localWritable: await isWritable(canonical),
  };
}

export function providerFromRemoteUrl(remoteUrl: string): { provider?: WorkspaceProvider; repository?: string } {
  const parsed = parseRemote(remoteUrl.trim());
  if (!parsed) return {};
  const host = parsed.host.toLowerCase();
  const repository = normalizeRepositoryPath(parsed.repository);
  if (!repository) return {};
  if (host === "github.com") return { provider: "github", repository };
  if (host === "gitlab.com") return { provider: "gitlab", repository };
  return {};
}

export function suggestWorkspaceId(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  return normalized || "workspace";
}

export function suggestWorkspaceIdForRoot(root: string): string {
  const base = suggestWorkspaceId(path.basename(root));
  const suffix = `-${createHash("sha256").update(root).digest("hex").slice(0, WORKSPACE_ID_PATH_HASH_CHARS)}`;
  const prefix = base.slice(0, 128 - suffix.length).replace(/[-._]+$/g, "") || "workspace";
  return `${prefix}${suffix}`;
}

function toRepositorySelection(selectionId: string, inspection: RepositoryInspection): WorkspaceRepositorySelection {
  const name = path.basename(inspection.root);
  return {
    selectionId,
    root: inspection.root,
    suggestedId: suggestWorkspaceIdForRoot(inspection.root),
    suggestedName: name.slice(0, 128) || "Workspace",
    remote: inspection.defaultRemote,
    remotes: inspection.remotes,
    defaultBranch: inspection.defaultBranch,
    ...(inspection.provider ? { provider: inspection.provider } : {}),
    ...(inspection.repository ? { repository: inspection.repository } : {}),
    head: inspection.head,
    ...(inspection.branch ? { branch: inspection.branch } : {}),
    dirty: inspection.dirty,
    localWritable: inspection.localWritable,
  };
}

function toManagedWorkspaceView(workspace: ManagedWorkspace, inspection: RepositoryInspection, index: ManagedWorkspaceView["index"]): ManagedWorkspaceView {
  return {
    id: workspace.id,
    name: workspace.name,
    root: workspace.root,
    access: workspace.access,
    remote: workspace.remote,
    defaultBranch: workspace.defaultBranch,
    ...(workspace.provider ? { provider: workspace.provider } : {}),
    ...(workspace.repository ? { repository: workspace.repository } : {}),
    validation: { state: "ready" },
    head: inspection.head,
    ...(inspection.branch ? { branch: inspection.branch } : {}),
    dirty: inspection.dirty,
    localWritable: inspection.localWritable,
    index,
  };
}

async function discoverDefaultBranch(root: string, remote: string, currentBranch?: string): Promise<string | undefined> {
  const remoteHead = await gitOptional(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (remoteHead) {
    const prefix = `${remote}/`;
    if (remoteHead.startsWith(prefix)) return remoteHead.slice(prefix.length);
  }
  for (const candidate of COMMON_DEFAULT_BRANCHES) {
    const local = await gitExitSuccess(root, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    const remoteRef = await gitExitSuccess(root, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`]);
    if (local || remoteRef) return candidate;
  }
  const remoteSymref = await gitOptional(root, ["ls-remote", "--symref", remote, "HEAD"], REMOTE_HEAD_TIMEOUT_MS);
  if (remoteSymref) {
    const match = remoteSymref.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match?.[1]) return match[1];
  }
  return currentBranch;
}

async function validateBranchExists(root: string, remote: string, branch: string): Promise<void> {
  if (!branch || branch.length > 256 || branch.startsWith("-") || /[\u0000-\u0020\u007f]/.test(branch)) {
    throw new WorkspaceManagerError("invalid_request", "Default branch is invalid.", { fieldDetails: { defaultBranch: "invalid Git branch name" } });
  }
  const valid = await gitExitSuccess(root, ["check-ref-format", "--branch", branch]);
  if (!valid) throw new WorkspaceManagerError("invalid_request", "Default branch is invalid.", { fieldDetails: { defaultBranch: "invalid Git branch name" } });
  const local = await gitExitSuccess(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const remoteRef = await gitExitSuccess(root, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]);
  if (!local && !remoteRef) {
    throw new WorkspaceManagerError("invalid_request", "Default branch does not exist locally or on the selected remote.", { fieldDetails: { defaultBranch: "branch was not found" } });
  }
}

function parseRemote(remoteUrl: string): { host: string; repository: string } | null {
  const scp = remoteUrl.match(/^(?:[^@\s]+@)?([^:\s/]+):(.+)$/);
  if (scp && !remoteUrl.includes("://")) return { host: scp[1], repository: scp[2] };
  try {
    const parsed = new URL(remoteUrl);
    if (!parsed.hostname) return null;
    return { host: parsed.hostname, repository: parsed.pathname };
  } catch {
    return null;
  }
}

function normalizeRepositoryPath(value: string): string | undefined {
  const normalized = value.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (normalized.length < 3 || normalized.length > 512 || normalized.includes("..") || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(normalized)) return undefined;
  return normalized;
}

async function gitRequired(root: string, args: string[], safeMessage: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnvironment(),
      windowsHide: true,
    });
    return stdout;
  } catch {
    throw new WorkspaceManagerError("invalid_request", safeMessage);
  }
}

async function gitOptional(root: string, args: string[], timeout = 0): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: gitEnvironment(),
      windowsHide: true,
      ...(timeout > 0 ? { timeout } : {}),
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function gitExitSuccess(root: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024,
      env: gitEnvironment(),
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
  };
}

async function isWritable(root: string): Promise<boolean> {
  try {
    await access(root, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRepositoryValidationMessage(error: unknown): string {
  if (error instanceof WorkspaceManagerError) return error.desktopError.message;
  return "Repository validation failed. Choose the repository again or repair the local Git checkout.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
