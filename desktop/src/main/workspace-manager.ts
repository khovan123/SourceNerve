import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DesktopRuntimeEvent,
  GitProvider,
  ManagedWorkspaceInput,
  ManagedWorkspaceView,
  WorkspaceIndexResult,
  WorkspaceValidation,
} from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import { materializeRuntime, type ManagedWorkspace } from "./runtime-profile";
import type { SourceNerveClient } from "./sourcenerve-client";

const execFileAsync = promisify(execFile);
const REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_GIT_OUTPUT = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

interface StoredWorkspace extends ManagedWorkspaceInput {
  lastIndexedHead?: string;
  lastIndexedStatusHash?: string;
  graphVersion?: number;
}

interface RegistryFile {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  workspaces: StoredWorkspace[];
}

export interface WorkspaceManagerOptions {
  bootstrap: DesktopBootstrapState;
  daemonManager: DaemonManager;
  sourceNerveClient: SourceNerveClient;
  onEvent?: (event: DesktopRuntimeEvent) => void;
}

export class WorkspaceManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly daemonManager: DaemonManager;
  private readonly sourceNerveClient: SourceNerveClient;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly registryPath: string;
  private workspaces: StoredWorkspace[] = [];

  constructor(options: WorkspaceManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.daemonManager = options.daemonManager;
    this.sourceNerveClient = options.sourceNerveClient;
    this.onEvent = options.onEvent;
    this.registryPath = path.join(this.bootstrap.paths.managedDirectory, "workspaces.json");
  }

  async initialize(): Promise<void> {
    this.workspaces = await readRegistry(this.registryPath);
  }

  async list(): Promise<ManagedWorkspaceView[]> {
    return Promise.all(this.workspaces.map((workspace) => this.toView(workspace)));
  }

  async validate(input: ManagedWorkspaceInput, editingId?: string): Promise<WorkspaceValidation> {
    const normalized = normalizeInput(input);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!validWorkspaceId(normalized.id)) errors.push("Workspace ID must be 1-128 letters, numbers, '.', '_' or '-'.");
    if (!normalized.name || normalized.name.length > 128) errors.push("Display name must be 1-128 characters.");
    if (!normalized.root || normalized.root.length > 4096 || normalized.root.includes("\0")) errors.push("Repository root is invalid.");
    if (!validRemoteName(normalized.remote)) errors.push("Git remote name is invalid.");
    if (!validBranchName(normalized.defaultBranch)) errors.push("Default branch name is invalid.");
    if (normalized.repository && !normalized.provider) errors.push("Repository slug requires an explicit provider.");
    if (normalized.repository && !validRepositorySlug(normalized.repository)) errors.push("Repository slug is invalid.");

    const duplicateId = this.workspaces.find((item) => item.id === normalized.id && item.id !== editingId);
    if (duplicateId) errors.push(`Workspace ID '${normalized.id}' is already registered.`);

    if (errors.length > 0) {
      return emptyValidation(errors, warnings);
    }

    let selectedRoot: string;
    try {
      selectedRoot = await realpath(normalized.root);
      const selectedStat = await stat(selectedRoot);
      if (!selectedStat.isDirectory()) errors.push("Repository root must be a directory.");
    } catch {
      errors.push("Repository root does not exist or cannot be resolved.");
      return emptyValidation(errors, warnings);
    }

    let gitRoot: string;
    try {
      const topLevel = await git(selectedRoot, ["rev-parse", "--show-toplevel"]);
      gitRoot = await realpath(topLevel.trim());
    } catch {
      errors.push("Selected directory is not inside a valid Git worktree.");
      return emptyValidation(errors, warnings);
    }

    if (selectedRoot !== gitRoot) {
      warnings.push("Selected path is inside a repository; SourceNerve will register the canonical Git root.");
    }

    for (const existing of this.workspaces) {
      if (existing.id === editingId) continue;
      try {
        if ((await realpath(existing.root)) === gitRoot) {
          errors.push(`Repository root is already registered by workspace '${existing.id}'.`);
          break;
        }
      } catch {
        // Existing broken entries remain visible for repair but do not block a valid canonical path.
      }
    }

    let filesystemWritable = false;
    try {
      await access(gitRoot, fsConstants.W_OK);
      filesystemWritable = true;
    } catch {
      filesystemWritable = false;
    }
    if (normalized.access === "read-write" && !filesystemWritable) {
      errors.push("Repository directory is not writable but workspace access is read-write.");
    }

    let head: string | undefined;
    let currentBranch: string | undefined;
    let statusText: string | undefined;
    try {
      head = (await git(gitRoot, ["rev-parse", "HEAD"])).trim();
      currentBranch = (await git(gitRoot, ["branch", "--show-current"])).trim() || "(detached HEAD)";
      statusText = (await git(gitRoot, ["status", "--porcelain=v1"])).slice(0, 64 * 1024);
    } catch {
      errors.push("Git HEAD/status could not be read.");
    }

    let remoteUrl: string | undefined;
    try {
      remoteUrl = (await git(gitRoot, ["remote", "get-url", normalized.remote])).trim();
    } catch {
      errors.push(`Git remote '${normalized.remote}' is not configured.`);
    }

    let defaultBranchExists = false;
    if (remoteUrl) {
      defaultBranchExists =
        (await gitRefExists(gitRoot, `refs/remotes/${normalized.remote}/${normalized.defaultBranch}`)) ||
        (await gitRefExists(gitRoot, `refs/heads/${normalized.defaultBranch}`));
      if (!defaultBranchExists) {
        errors.push(`Default branch '${normalized.defaultBranch}' does not exist locally or under remote '${normalized.remote}'.`);
      }
    }

    const derived = remoteUrl ? deriveProviderMetadata(remoteUrl) : {};
    let provider = normalized.provider ?? derived.provider;
    let repository = normalized.repository ?? derived.repository;

    if (normalized.provider && derived.provider && normalized.provider !== derived.provider) {
      errors.push(`Configured provider '${normalized.provider}' conflicts with Git remote host.`);
    }
    if (normalized.repository && derived.repository && normalizeSlug(normalized.repository) !== normalizeSlug(derived.repository)) {
      errors.push(`Configured repository '${normalized.repository}' conflicts with Git remote '${derived.repository}'.`);
    }
    if (provider && !repository) {
      errors.push("Provider repository slug could not be derived; enter it explicitly.");
    }
    if (!provider && repository) {
      errors.push("Repository slug requires a provider.");
    }
    if (!provider && remoteUrl) {
      warnings.push("Repository host is not GitHub/GitLab; provider lifecycle features will stay disabled.");
    }

    return {
      valid: errors.length === 0,
      canonicalRoot: gitRoot,
      head,
      currentBranch,
      dirty: statusText !== undefined ? statusText.length > 0 : undefined,
      status: statusText,
      remoteUrl,
      defaultBranchExists,
      filesystemWritable,
      provider,
      repository,
      errors,
      warnings,
    };
  }

  async save(input: ManagedWorkspaceInput): Promise<ManagedWorkspaceView> {
    const editingId = this.workspaces.some((item) => item.id === input.id) ? input.id : undefined;
    const validation = await this.validate(input, editingId);
    if (!validation.valid || !validation.canonicalRoot) {
      throw new WorkspaceValidationError(validation);
    }

    const currentState = this.daemonManager.snapshot();
    if (!currentState.managed && (currentState.state === "external" || currentState.state === "incompatible")) {
      throw new Error("cannot apply workspace configuration while an external SourceNerve daemon owns the local port");
    }

    const normalized = normalizeInput({
      ...input,
      root: validation.canonicalRoot,
      provider: validation.provider,
      repository: validation.repository,
    });
    const stored: StoredWorkspace = normalized;
    const existingIndex = this.workspaces.findIndex((item) => item.id === stored.id);
    const next = [...this.workspaces];
    if (existingIndex >= 0) next[existingIndex] = stored;
    else next.push(stored);

    await this.persistAndApply(next);
    this.workspaces = next;
    this.onEvent?.({ type: "state", component: "workspace", state: "workspace-ready" });
    return this.toView(stored);
  }

  async remove(id: string): Promise<boolean> {
    if (!validWorkspaceId(id)) throw new Error("invalid workspace id");
    const next = this.workspaces.filter((item) => item.id !== id);
    if (next.length === this.workspaces.length) return false;

    const currentState = this.daemonManager.snapshot();
    if (!currentState.managed && (currentState.state === "external" || currentState.state === "incompatible")) {
      throw new Error("cannot apply workspace configuration while an external SourceNerve daemon owns the local port");
    }

    if (next.length === 0) {
      if (currentState.managed && currentState.state !== "stopped") {
        await this.daemonManager.stop();
      }
      await writeRegistry(this.registryPath, next);
      await unlink(this.bootstrap.paths.configPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      await this.persistAndApply(next);
    }
    this.workspaces = next;
    this.onEvent?.({ type: "state", component: "workspace", state: next.length === 0 ? "removed" : "workspace-ready" });
    return true;
  }

  async index(id: string): Promise<WorkspaceIndexResult> {
    if (!validWorkspaceId(id)) throw new Error("invalid workspace id");
    const workspace = this.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error(`workspace '${id}' is not registered`);
    const daemon = this.daemonManager.snapshot();
    if (daemon.state !== "ready" && daemon.state !== "external") {
      throw new Error("SourceNerve daemon must be ready before workspace indexing");
    }

    const operationId = `workspace-index.${id}`;
    this.onEvent?.({ type: "progress", operationId, stage: "indexing", current: 0, total: 1 });
    await this.sourceNerveClient.indexWorkspace(id);
    const [snapshot, graph] = await Promise.all([
      this.sourceNerveClient.workspaceSnapshot(id),
      this.sourceNerveClient.graphStatus(id),
    ]);

    workspace.lastIndexedHead = snapshot.head;
    workspace.lastIndexedStatusHash = statusHash(snapshot.status);
    workspace.graphVersion = graph.graphVersion;
    await writeRegistry(this.registryPath, this.workspaces);

    this.onEvent?.({ type: "progress", operationId, stage: "index-ready", current: 1, total: 1 });
    this.onEvent?.({ type: "state", component: "workspace", state: "index-ready" });
    return {
      workspace: id,
      indexed: true,
      graphVersion: graph.graphVersion,
      head: snapshot.head,
      dirty: snapshot.dirty,
    };
  }

  private async persistAndApply(next: StoredWorkspace[]): Promise<void> {
    const localBearer = await this.bootstrap.secretStore.get("localBearer");
    if (!localBearer) throw new Error("SourceNerve local bearer is unavailable");
    const githubToken = await this.bootstrap.secretStore.get("githubToken");

    const materialized = await materializeRuntime({
      productProfile: this.bootstrap.profile,
      configPath: this.bootstrap.paths.configPath,
      stateDirectory: this.bootstrap.paths.stateDirectory,
      localBearer,
      workspaces: next.map(toRuntimeWorkspace),
      githubToken,
    });

    this.daemonManager.configure({
      configPath: materialized.configPath,
      environment: materialized.environment,
      redactedSecrets: [localBearer, ...(githubToken ? [githubToken] : [])],
    });

    const state = this.daemonManager.snapshot();
    if (state.managed && state.state === "ready") await this.daemonManager.restart();
    else if (state.state === "stopped" || state.state === "crashed") await this.daemonManager.start();

    await writeRegistry(this.registryPath, next);
  }

  private async toView(workspace: StoredWorkspace): Promise<ManagedWorkspaceView> {
    const validation = await this.validate(workspace, workspace.id);
    const indexed = Boolean(
      validation.head &&
        workspace.lastIndexedHead === validation.head &&
        workspace.lastIndexedStatusHash === statusHash(validation.status ?? ""),
    );
    return {
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      access: workspace.access,
      remote: workspace.remote,
      defaultBranch: workspace.defaultBranch,
      provider: workspace.provider,
      repository: workspace.repository,
      validation,
      indexed,
      graphVersion: indexed ? workspace.graphVersion : undefined,
    };
  }
}

export class WorkspaceValidationError extends Error {
  readonly validation: WorkspaceValidation;

  constructor(validation: WorkspaceValidation) {
    super(validation.errors[0] ?? "workspace validation failed");
    this.name = "WorkspaceValidationError";
    this.validation = validation;
  }
}

export function deriveProviderMetadata(remoteUrl: string): {
  provider?: GitProvider;
  repository?: string;
} {
  const parsed = parseRemote(remoteUrl.trim());
  if (!parsed) return {};
  const host = parsed.host.toLowerCase();
  const repository = parsed.repository.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!validRepositorySlug(repository)) return {};
  if (host === "github.com") return { provider: "github", repository };
  if (host === "gitlab.com") return { provider: "gitlab", repository };
  return {};
}

function parseRemote(value: string): { host: string; repository: string } | null {
  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(value);
  if (scp && !value.includes("://")) return { host: scp[1], repository: scp[2] };
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    return { host: url.hostname, repository: url.pathname };
  } catch {
    return null;
  }
}

function normalizeInput(input: ManagedWorkspaceInput): ManagedWorkspaceInput {
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    root: input.root.trim(),
    access: input.access,
    remote: input.remote.trim(),
    defaultBranch: input.defaultBranch.trim(),
    provider: input.provider,
    repository: input.repository?.trim() || undefined,
  };
}

function toRuntimeWorkspace(workspace: StoredWorkspace): ManagedWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    root: workspace.root,
    access: workspace.access,
    remote: workspace.remote,
    defaultBranch: workspace.defaultBranch,
    provider: workspace.provider,
    repository: workspace.repository,
  };
}

async function readRegistry(filePath: string): Promise<StoredWorkspace[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("workspace registry exceeds 1 MB");
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    if (parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.workspaces)) {
      throw new Error("unsupported Desktop workspace registry schema");
    }
    return parsed.workspaces.map((item) => normalizeStoredWorkspace(item));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeRegistry(filePath: string, workspaces: StoredWorkspace[]): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const payload: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, workspaces };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function normalizeStoredWorkspace(value: unknown): StoredWorkspace {
  if (!value || typeof value !== "object") throw new Error("invalid Desktop workspace registry entry");
  const item = value as Partial<StoredWorkspace>;
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.root !== "string" ||
    (item.access !== "read-only" && item.access !== "read-write") ||
    typeof item.remote !== "string" ||
    typeof item.defaultBranch !== "string"
  ) {
    throw new Error("invalid Desktop workspace registry entry");
  }
  if (item.provider !== undefined && item.provider !== "github" && item.provider !== "gitlab") {
    throw new Error("invalid Desktop workspace provider");
  }
  if (item.repository !== undefined && typeof item.repository !== "string") {
    throw new Error("invalid Desktop workspace repository slug");
  }
  return {
    ...normalizeInput(item as ManagedWorkspaceInput),
    lastIndexedHead: typeof item.lastIndexedHead === "string" ? item.lastIndexedHead : undefined,
    lastIndexedStatusHash: typeof item.lastIndexedStatusHash === "string" ? item.lastIndexedStatusHash : undefined,
    graphVersion: typeof item.graphVersion === "number" ? item.graphVersion : undefined,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true,
  });
  return stdout;
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: number }).code : undefined;
    if (code === 1) return false;
    return false;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"] as const;
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
  for (const name of allowed) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function emptyValidation(errors: string[], warnings: string[]): WorkspaceValidation {
  return {
    valid: false,
    defaultBranchExists: false,
    filesystemWritable: false,
    errors,
    warnings,
  };
}

function statusHash(status: string): string {
  return createHash("sha256").update(status).digest("hex");
}

function validWorkspaceId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function validRemoteName(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

function validBranchName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    !value.startsWith("-") &&
    !value.endsWith("/") &&
    !value.includes("..") &&
    !/[\s~^:?*\\\[\]\x00-\x1f\x7f]/.test(value)
  );
}

function validRepositorySlug(value: string): boolean {
  if (value.length < 3 || value.length > 512 || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
}

function normalizeSlug(value: string): string {
  return value.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
}
