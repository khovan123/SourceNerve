import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DesktopRuntimeEvent,
  GitProvider,
  GitTransportValidation,
  ProviderAccountView,
  ProviderRepositorySummary,
} from "../shared/desktop-api";
import type { ProviderPullListState } from "../shared/provider-workflow-api";
import type { DesktopBootstrapState } from "./bootstrap";
import {
  defaultProviderCliClient,
  providerCliLoginCommand,
  providerCliName,
  type ProviderCliClient,
  type ProviderCliPullSummary,
} from "./provider-cli";
import type { CliProviderProfile } from "./runtime-profile";
import type { WorkspaceManager } from "./workspace-manager";

const execFileAsync = promisify(execFile);
const METADATA_SCHEMA_VERSION = 2 as const;
const GIT_TIMEOUT_MS = 12_000;

interface StoredProviderAccount {
  provider: GitProvider;
  login: string;
  name?: string;
  providerUserId: string;
  baseUrl: string;
  connectedAt: number;
}

interface ProviderMetadataFile {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  accounts: StoredProviderAccount[];
}

export interface ProviderManagerOptions {
  bootstrap: DesktopBootstrapState;
  workspaceManager: WorkspaceManager;
  // Kept optional so existing main-process construction remains source compatible.
  // Provider authentication no longer opens OAuth URLs itself.
  openExternal?: (url: string) => Promise<void>;
  onEvent?: (event: DesktopRuntimeEvent) => void;
  onCredentialChanged?: () => Promise<void>;
  cliClient?: ProviderCliClient;
  now?: () => number;
}

export class ProviderManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly workspaceManager: WorkspaceManager;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly onCredentialChanged?: () => Promise<void>;
  private readonly cliClient: ProviderCliClient;
  private readonly now: () => number;
  private readonly metadataPath: string;
  private readonly accounts = new Map<GitProvider, StoredProviderAccount>();
  private readonly errors = new Map<GitProvider, string>();

  constructor(options: ProviderManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.workspaceManager = options.workspaceManager;
    this.onEvent = options.onEvent;
    this.onCredentialChanged = options.onCredentialChanged;
    this.cliClient = options.cliClient ?? defaultProviderCliClient;
    this.now = options.now ?? Date.now;
    this.metadataPath = path.join(options.bootstrap.paths.managedDirectory, "provider-sessions.json");
  }

  async initialize(): Promise<ProviderAccountView[]> {
    for (const account of await readMetadata(this.metadataPath)) this.accounts.set(account.provider, account);
    for (const provider of PROVIDERS) await this.refreshProvider(provider, false);
    await this.persistMetadata();
    return this.states();
  }

  states(): ProviderAccountView[] {
    return PROVIDERS.map((provider) => this.state(provider));
  }

  state(provider: GitProvider): ProviderAccountView {
    const profile = this.profile(provider);
    const account = this.accounts.get(provider);
    const error = this.errors.get(provider);
    if (account) {
      return {
        provider,
        status: error ? "error" : "connected",
        login: account.login,
        name: account.name,
        providerUserId: account.providerUserId,
        baseUrl: account.baseUrl,
        connectedAt: account.connectedAt,
        error,
      };
    }
    return {
      provider,
      status: "disconnected",
      baseUrl: profile.apiBaseUrl,
      error,
    };
  }

  async connect(provider: GitProvider): Promise<ProviderAccountView> {
    await this.refreshProvider(provider, true);
    await this.persistMetadata();
    await this.onCredentialChanged?.();
    this.publish(provider, "connected", `${providerCliName(provider)} CLI session detected`);
    return this.state(provider);
  }

  async disconnect(provider: GitProvider): Promise<ProviderAccountView> {
    this.accounts.delete(provider);
    this.errors.set(
      provider,
      `SourceNerve forgot this provider session only. The external ${providerCliName(provider)} CLI login was not modified.`,
    );
    await this.persistMetadata();
    await this.onCredentialChanged?.();
    this.publish(provider, "disconnected", "CLI credentials were left untouched");
    return this.state(provider);
  }

  async listRepositories(provider: GitProvider): Promise<ProviderRepositorySummary[]> {
    await this.requireConnected(provider);
    return this.cliClient.repositories(provider);
  }

  async validateRepository(provider: GitProvider, repository: string): Promise<ProviderRepositorySummary> {
    await this.requireConnected(provider);
    return this.cliClient.repository(provider, repository);
  }

  async listPullRequests(
    provider: GitProvider,
    repository: string,
    state: ProviderPullListState,
    limit: number,
  ): Promise<ProviderCliPullSummary[]> {
    await this.requireConnected(provider);
    return this.cliClient.pulls(provider, repository, state, limit);
  }

  async validateGitTransport(workspaceId: string): Promise<GitTransportValidation> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(workspaceId)) throw new Error("invalid workspace id");
    const workspace = (await this.workspaceManager.listManagedWorkspaces()).find((item) => item.id === workspaceId);
    if (!workspace) throw new Error(`workspace '${workspaceId}' is not registered`);
    if (workspace.validation.state !== "ready") {
      throw new Error(`workspace '${workspaceId}' must be repaired before Git transport validation`);
    }

    const remoteUrl = (await git(workspace.root, ["remote", "get-url", workspace.remote])).trim();
    const transport = classifyGitTransport(remoteUrl);
    try {
      await git(workspace.root, ["ls-remote", "--exit-code", workspace.remote, "HEAD"], true);
      return {
        workspace: workspaceId,
        ready: true,
        transport,
        message: `Non-interactive ${transport.toUpperCase()} Git transport is ready.`,
      };
    } catch {
      const providerHint = workspace.provider === "github"
        ? " For HTTPS remotes, run 'gh auth setup-git --hostname github.com'."
        : workspace.provider === "gitlab"
          ? " Ensure glab authentication and the Git credential helper are configured."
          : "";
      return {
        workspace: workspaceId,
        ready: false,
        transport,
        message:
          transport === "ssh"
            ? "SSH Git transport is not ready non-interactively. Check SSH agent/key and known-host configuration."
            : transport === "https"
              ? `HTTPS Git transport is not ready non-interactively.${providerHint}`
              : "Git transport is not ready non-interactively for the configured remote.",
      };
    }
  }

  private async refreshProvider(provider: GitProvider, failWhenUnavailable: boolean): Promise<void> {
    try {
      const account = await this.cliClient.account(provider);
      this.accounts.set(provider, {
        provider,
        login: account.login,
        name: account.name,
        providerUserId: account.providerUserId,
        baseUrl: this.profile(provider).apiBaseUrl,
        connectedAt: this.accounts.get(provider)?.connectedAt ?? this.now(),
      });
      this.errors.delete(provider);
      this.publish(provider, "connected", `${providerCliName(provider)} CLI authenticated`);
    } catch (error) {
      this.accounts.delete(provider);
      const message = safeError(error) || cliSetupMessage(provider);
      this.errors.set(provider, message);
      this.publish(provider, "disconnected", message);
      if (failWhenUnavailable) throw new Error(message);
    }
  }

  private async requireConnected(provider: GitProvider): Promise<void> {
    try {
      const account = await this.cliClient.account(provider);
      const current = this.accounts.get(provider);
      this.accounts.set(provider, {
        provider,
        login: account.login,
        name: account.name,
        providerUserId: account.providerUserId,
        baseUrl: this.profile(provider).apiBaseUrl,
        connectedAt: current?.connectedAt ?? this.now(),
      });
      this.errors.delete(provider);
    } catch (error) {
      this.accounts.delete(provider);
      const message = safeError(error) || cliSetupMessage(provider);
      this.errors.set(provider, message);
      throw new Error(message);
    }
  }

  private profile(provider: GitProvider): CliProviderProfile {
    return this.bootstrap.profile.gitProviders[provider];
  }

  private async persistMetadata(): Promise<void> {
    const accounts = [...this.accounts.values()].sort((a, b) => a.provider.localeCompare(b.provider));
    await mkdir(path.dirname(this.metadataPath), { recursive: true, mode: 0o700 });
    if (accounts.length === 0) {
      await unlink(this.metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    const temporary = `${this.metadataPath}.tmp-${process.pid}`;
    const payload: ProviderMetadataFile = { schemaVersion: METADATA_SCHEMA_VERSION, accounts };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.metadataPath);
  }

  private publish(provider: GitProvider, state: string, message?: string): void {
    this.onEvent?.({
      type: "state",
      component: "git",
      state,
      message: message ? `${providerLabel(provider)}: ${message}` : providerLabel(provider),
    });
  }
}

// Retained as a compatibility export for the IPC error mapper while provider HTTP
// calls migrate behind gh/glab CLI. New provider code does not throw this class.
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

const PROVIDERS = ["github", "gitlab"] as const;

async function readMetadata(filePath: string): Promise<StoredProviderAccount[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("provider metadata file is oversized");
    const value = JSON.parse(raw) as Partial<ProviderMetadataFile>;
    if (value.schemaVersion !== METADATA_SCHEMA_VERSION || !Array.isArray(value.accounts)) return [];
    return value.accounts.map(validateStoredAccount);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function validateStoredAccount(value: unknown): StoredProviderAccount {
  if (!isRecord(value) || (value.provider !== "github" && value.provider !== "gitlab")) {
    throw new Error("invalid provider account metadata");
  }
  if (typeof value.login !== "string" || !boundedText(value.login, 256)) throw new Error("invalid provider account login");
  if (typeof value.providerUserId !== "string" || !boundedText(value.providerUserId, 128)) {
    throw new Error("invalid provider user id");
  }
  if (typeof value.baseUrl !== "string" || !isCredentialFreeHttps(value.baseUrl)) {
    throw new Error("invalid provider API base URL");
  }
  if (typeof value.connectedAt !== "number" || !Number.isFinite(value.connectedAt)) {
    throw new Error("invalid provider connected timestamp");
  }
  return {
    provider: value.provider,
    login: value.login,
    name: typeof value.name === "string" && boundedText(value.name, 256) ? value.name : undefined,
    providerUserId: value.providerUserId,
    baseUrl: value.baseUrl,
    connectedAt: value.connectedAt,
  };
}

async function git(cwd: string, args: string[], network = false): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...(network ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes" } : {}),
  };
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
  ] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    env: environment,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function classifyGitTransport(value: string): "ssh" | "https" | "other" {
  if (/^(?:[^@\s]+@)?[^:\s/]+:.+/.test(value) && !value.includes("://")) return "ssh";
  try {
    const url = new URL(value);
    if (url.protocol === "ssh:") return "ssh";
    if (url.protocol === "https:") return "https";
  } catch {
    return "other";
  }
  return "other";
}

function cliSetupMessage(provider: GitProvider): string {
  return `${providerLabel(provider)} is not available through ${providerCliName(provider)} CLI. Run '${providerCliLoginCommand(provider)}' in a terminal, then retry.`;
}

function providerLabel(provider: GitProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function boundedText(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCredentialFreeHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider CLI operation failed";
  return message.replace(/[\r\n\0]/g, " ").slice(0, 512).trim();
}
