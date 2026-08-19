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
import type { DesktopBootstrapState } from "./bootstrap";
import type { DeviceProviderProfile } from "./runtime-profile";
import type { WorkspaceManager } from "./workspace-manager";

const execFileAsync = promisify(execFile);
const METADATA_SCHEMA_VERSION = 1 as const;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_BYTES = 4096;
const MAX_REPOSITORIES = 500;
const MAX_PAGES = 5;
const MIN_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 60;
const GIT_TIMEOUT_MS = 12_000;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

interface ProviderSecretStore {
  get(name: "githubToken" | "gitlabToken"): Promise<string | null>;
  set(name: "githubToken" | "gitlabToken", value: string): Promise<void>;
  delete(name: "githubToken" | "gitlabToken"): Promise<void>;
}

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

interface PendingDeviceLogin {
  provider: GitProvider;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  generation: number;
}

interface JsonResponse {
  value: unknown;
  headers: Headers;
  status: number;
}

export interface ProviderManagerOptions {
  bootstrap: DesktopBootstrapState;
  workspaceManager: WorkspaceManager;
  openExternal(url: string): Promise<void>;
  onEvent?: (event: DesktopRuntimeEvent) => void;
  onCredentialChanged?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  delayImpl?: (milliseconds: number) => Promise<void>;
}

export class ProviderManager {
  private readonly bootstrap: DesktopBootstrapState;
  private readonly secretStore: ProviderSecretStore;
  private readonly workspaceManager: WorkspaceManager;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly onCredentialChanged?: () => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly delayImpl: (milliseconds: number) => Promise<void>;
  private readonly metadataPath: string;
  private readonly accounts = new Map<GitProvider, StoredProviderAccount>();
  private readonly errors = new Map<GitProvider, string>();
  private readonly pending = new Map<GitProvider, PendingDeviceLogin>();
  private generation = 0;

  constructor(options: ProviderManagerOptions) {
    this.bootstrap = options.bootstrap;
    this.secretStore = options.bootstrap.secretStore;
    this.workspaceManager = options.workspaceManager;
    this.openExternal = options.openExternal;
    this.onEvent = options.onEvent;
    this.onCredentialChanged = options.onCredentialChanged;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.delayImpl = options.delayImpl ?? delay;
    this.metadataPath = path.join(options.bootstrap.paths.managedDirectory, "provider-sessions.json");
  }

  async initialize(): Promise<ProviderAccountView[]> {
    for (const account of await readMetadata(this.metadataPath)) this.accounts.set(account.provider, account);
    for (const provider of PROVIDERS) {
      const token = await this.secretStore.get(secretName(provider));
      if (!token) {
        this.accounts.delete(provider);
        this.errors.delete(provider);
        continue;
      }
      try {
        const account = await this.fetchAccount(provider, token);
        this.accounts.set(provider, {
          provider,
          login: account.login,
          name: account.name,
          providerUserId: account.providerUserId,
          baseUrl: this.profile(provider).apiBaseUrl,
          connectedAt: this.accounts.get(provider)?.connectedAt ?? this.now(),
        });
        this.errors.delete(provider);
        this.publish(provider, "connected");
      } catch (error) {
        this.errors.set(provider, safeError(error));
        this.publish(provider, "error", "Provider session validation failed");
      }
    }
    await this.persistMetadata();
    return this.states();
  }

  states(): ProviderAccountView[] {
    return PROVIDERS.map((provider) => this.state(provider));
  }

  state(provider: GitProvider): ProviderAccountView {
    const profile = this.profile(provider);
    const account = this.accounts.get(provider);
    const pending = this.pending.get(provider);
    const error = this.errors.get(provider);
    if (pending) {
      return {
        provider,
        status: "awaiting-user",
        baseUrl: profile.apiBaseUrl,
        deviceLogin: {
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          expiresAt: pending.expiresAt,
        },
      };
    }
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
      status: error ? "error" : "disconnected",
      baseUrl: profile.apiBaseUrl,
      error,
    };
  }

  async connect(provider: GitProvider): Promise<ProviderAccountView> {
    const profile = this.profile(provider);
    if (!profile.clientId || PLACEHOLDER_PATTERN.test(profile.clientId)) {
      throw new Error(`${providerLabel(provider)} OAuth client ID is not configured for this Desktop build`);
    }

    this.cancelPending(provider);
    this.errors.delete(provider);
    const response = await this.formRequest(profile.deviceCodeUrl, {
      client_id: profile.clientId,
      scope: profile.scopes.join(" "),
    });
    const payload = parseDeviceAuthorization(response.value);
    const verificationUri = validateVerificationUri(payload.verificationUri, profile);
    const verificationComplete = payload.verificationUriComplete
      ? validateVerificationUri(payload.verificationUriComplete, profile)
      : verificationUri;
    const generation = ++this.generation;
    const pending: PendingDeviceLogin = {
      provider,
      deviceCode: payload.deviceCode,
      userCode: payload.userCode,
      verificationUri,
      expiresAt: this.now() + payload.expiresInSeconds * 1000,
      intervalSeconds: boundedInterval(payload.intervalSeconds),
      generation,
    };
    this.pending.set(provider, pending);
    this.publish(provider, "awaiting-user");

    try {
      await this.openExternal(verificationComplete);
    } catch (error) {
      this.pending.delete(provider);
      this.errors.set(provider, safeError(error));
      this.publish(provider, "error", "Unable to open provider authorization page");
      throw error;
    }

    void this.pollDeviceLogin(pending).catch((error) => {
      if (this.pending.get(provider)?.generation !== generation) return;
      this.pending.delete(provider);
      this.errors.set(provider, safeError(error));
      this.publish(provider, "error", safeError(error));
    });
    return this.state(provider);
  }

  async disconnect(provider: GitProvider): Promise<ProviderAccountView> {
    this.cancelPending(provider);
    await this.secretStore.delete(secretName(provider));
    this.accounts.delete(provider);
    this.errors.delete(provider);
    await this.persistMetadata();
    await this.onCredentialChanged?.();
    this.publish(provider, "disconnected");
    return this.state(provider);
  }

  async listRepositories(provider: GitProvider): Promise<ProviderRepositorySummary[]> {
    const token = await this.requireToken(provider);
    return provider === "github"
      ? this.listGitHubRepositories(token)
      : this.listGitLabRepositories(token);
  }

  async validateRepository(provider: GitProvider, repository: string): Promise<ProviderRepositorySummary> {
    if (!validRepositorySlug(repository)) throw new Error("provider repository slug is invalid");
    const token = await this.requireToken(provider);
    if (provider === "github") {
      const parts = repository.split("/");
      if (parts.length !== 2) throw new Error("GitHub repository slug must be owner/repository");
      const url = apiUrl(this.profile(provider), `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`);
      return parseGitHubRepository((await this.apiRequest(provider, token, url)).value);
    }
    const url = apiUrl(this.profile(provider), `/projects/${encodeURIComponent(repository)}`);
    return parseGitLabRepository((await this.apiRequest(provider, token, url)).value);
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
      return {
        workspace: workspaceId,
        ready: false,
        transport,
        message:
          transport === "ssh"
            ? "SSH Git transport is not ready non-interactively. Check SSH agent/key and known-host configuration."
            : transport === "https"
              ? "HTTPS Git transport is not ready non-interactively. Configure a Git credential helper for push/pull."
              : "Git transport is not ready non-interactively for the configured remote.",
      };
    }
  }

  private async pollDeviceLogin(pending: PendingDeviceLogin): Promise<void> {
    let intervalSeconds = pending.intervalSeconds;
    while (this.now() < pending.expiresAt) {
      await this.delayImpl(intervalSeconds * 1000);
      if (this.pending.get(pending.provider)?.generation !== pending.generation) return;

      const profile = this.profile(pending.provider);
      const response = await this.formRequest(
        profile.tokenUrl,
        {
          client_id: profile.clientId,
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        true,
      );
      if (!isRecord(response.value)) throw new Error("provider token response is invalid");
      const oauthError = response.value.error;
      if (typeof oauthError === "string") {
        if (oauthError === "authorization_pending") continue;
        if (oauthError === "slow_down") {
          intervalSeconds = Math.min(MAX_POLL_INTERVAL_SECONDS, intervalSeconds + 5);
          continue;
        }
        if (oauthError === "expired_token" || oauthError === "token_expired") {
          throw new Error(`${providerLabel(pending.provider)} device authorization expired`);
        }
        if (oauthError === "access_denied") {
          throw new Error(`${providerLabel(pending.provider)} authorization was denied`);
        }
        if (oauthError === "device_flow_disabled") {
          throw new Error("GitHub device flow is disabled for the configured OAuth application");
        }
        if (oauthError === "unsupported_grant_type") {
          throw new Error(`${providerLabel(pending.provider)} device authorization is not supported`);
        }
        throw new Error(`${providerLabel(pending.provider)} authorization failed (${safeProviderError(oauthError)})`);
      }

      const token = parseAccessToken(response.value);
      const account = await this.fetchAccount(pending.provider, token);
      await this.secretStore.set(secretName(pending.provider), token);
      this.accounts.set(pending.provider, {
        provider: pending.provider,
        login: account.login,
        name: account.name,
        providerUserId: account.providerUserId,
        baseUrl: profile.apiBaseUrl,
        connectedAt: this.now(),
      });
      this.pending.delete(pending.provider);
      this.errors.delete(pending.provider);
      await this.persistMetadata();
      try {
        await this.onCredentialChanged?.();
      } catch (error) {
        await this.secretStore.delete(secretName(pending.provider));
        this.accounts.delete(pending.provider);
        await this.persistMetadata();
        throw error;
      }
      this.publish(pending.provider, "connected");
      return;
    }
    throw new Error(`${providerLabel(pending.provider)} device authorization expired`);
  }

  private async fetchAccount(
    provider: GitProvider,
    token: string,
  ): Promise<{ login: string; name?: string; providerUserId: string }> {
    const profile = this.profile(provider);
    const response = await this.apiRequest(provider, token, apiUrl(profile, "/user"));
    if (!isRecord(response.value)) throw new Error(`${providerLabel(provider)} account response is invalid`);
    const login = provider === "github" ? response.value.login : response.value.username;
    if (typeof login !== "string" || !boundedText(login, 256)) {
      throw new Error(`${providerLabel(provider)} account login is invalid`);
    }
    const id = response.value.id;
    if ((typeof id !== "number" && typeof id !== "string") || String(id).length > 128) {
      throw new Error(`${providerLabel(provider)} account id is invalid`);
    }
    const name = typeof response.value.name === "string" && boundedText(response.value.name, 256)
      ? response.value.name
      : undefined;
    return { login, name, providerUserId: String(id) };
  }

  private async listGitHubRepositories(token: string): Promise<ProviderRepositorySummary[]> {
    const results: ProviderRepositorySummary[] = [];
    const profile = this.profile("github");
    for (let page = 1; page <= MAX_PAGES && results.length < MAX_REPOSITORIES; page += 1) {
      const url = new URL(apiUrl(profile, "/user/repos"));
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("sort", "updated");
      url.searchParams.set("affiliation", "owner,collaborator,organization_member");
      const response = await this.apiRequest("github", token, url.toString());
      if (!Array.isArray(response.value)) throw new Error("GitHub repository response is invalid");
      for (const item of response.value) results.push(parseGitHubRepository(item));
      if (response.value.length < 100) break;
    }
    return results.slice(0, MAX_REPOSITORIES);
  }

  private async listGitLabRepositories(token: string): Promise<ProviderRepositorySummary[]> {
    const results: ProviderRepositorySummary[] = [];
    const profile = this.profile("gitlab");
    for (let page = 1; page <= MAX_PAGES && results.length < MAX_REPOSITORIES; page += 1) {
      const url = new URL(apiUrl(profile, "/projects"));
      url.searchParams.set("membership", "true");
      url.searchParams.set("simple", "true");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("order_by", "last_activity_at");
      url.searchParams.set("sort", "desc");
      const response = await this.apiRequest("gitlab", token, url.toString());
      if (!Array.isArray(response.value)) throw new Error("GitLab project response is invalid");
      for (const item of response.value) results.push(parseGitLabRepository(item));
      if (response.value.length < 100) break;
    }
    return results.slice(0, MAX_REPOSITORIES);
  }

  private async requireToken(provider: GitProvider): Promise<string> {
    const token = await this.secretStore.get(secretName(provider));
    if (!token || !validAccessToken(token)) throw new Error(`${providerLabel(provider)} is not connected`);
    return token;
  }

  private profile(provider: GitProvider): DeviceProviderProfile {
    return this.bootstrap.profile.gitProviders[provider];
  }

  private async formRequest(
    url: string,
    fields: Record<string, string>,
    allowOAuthError = false,
  ): Promise<JsonResponse> {
    const body = new URLSearchParams(fields).toString();
    if (Buffer.byteLength(body, "utf8") > 16 * 1024) throw new Error("provider OAuth request is oversized");
    return this.fetchJson(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      },
      allowOAuthError,
    );
  }

  private async apiRequest(provider: GitProvider, token: string, url: string): Promise<JsonResponse> {
    const target = new URL(url);
    const apiOrigin = new URL(this.profile(provider).apiBaseUrl).origin;
    if (
      target.protocol !== "https:" ||
      target.origin !== apiOrigin ||
      target.username ||
      target.password ||
      target.hash
    ) {
      throw new Error(`${providerLabel(provider)} API request escaped the configured API origin`);
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (provider === "github") headers["x-github-api-version"] = "2022-11-28";
    return this.fetchJson(target.toString(), { method: "GET", headers });
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    allowOAuthError = false,
  ): Promise<JsonResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("provider response is oversized");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("provider response is oversized");
      let value: unknown;
      try {
        value = text ? (JSON.parse(text) as unknown) : {};
      } catch {
        throw new Error("provider response is not valid JSON");
      }
      if (!response.ok) {
        if (
          allowOAuthError &&
          isRecord(value) &&
          typeof value.error === "string" &&
          /^[A-Za-z0-9._-]{1,128}$/.test(value.error)
        ) {
          return { value, headers: response.headers, status: response.status };
        }
        throw new ProviderHttpError(response.status, providerHttpError(response.status));
      }
      return { value, headers: response.headers, status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  private cancelPending(provider: GitProvider): void {
    if (this.pending.delete(provider)) this.generation += 1;
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
    const payload: ProviderMetadataFile = {
      schemaVersion: METADATA_SCHEMA_VERSION,
      accounts,
    };
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
    if (value.schemaVersion !== METADATA_SCHEMA_VERSION || !Array.isArray(value.accounts)) {
      throw new Error("provider metadata file is invalid");
    }
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
  if (typeof value.login !== "string" || !boundedText(value.login, 256)) {
    throw new Error("invalid provider account login");
  }
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

function parseDeviceAuthorization(value: unknown): {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
} {
  if (!isRecord(value)) throw new Error("provider device authorization response is invalid");
  const deviceCode = value.device_code;
  const userCode = value.user_code;
  const verificationUri = value.verification_uri;
  if (
    !boundedTokenField(deviceCode, 1024) ||
    !boundedTokenField(userCode, 128) ||
    typeof verificationUri !== "string"
  ) {
    throw new Error("provider device authorization response is missing required fields");
  }
  const expiresIn = Number(value.expires_in);
  const interval = value.interval === undefined ? MIN_POLL_INTERVAL_SECONDS : Number(value.interval);
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 3600) {
    throw new Error("provider device authorization expiry is invalid");
  }
  if (!Number.isFinite(interval) || interval < 1 || interval > MAX_POLL_INTERVAL_SECONDS) {
    throw new Error("provider device polling interval is invalid");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete:
      typeof value.verification_uri_complete === "string"
        ? value.verification_uri_complete
        : undefined,
    expiresInSeconds: expiresIn,
    intervalSeconds: interval,
  };
}

function validateVerificationUri(value: string, profile: DeviceProviderProfile): string {
  const url = new URL(value);
  const expectedOrigin = new URL(profile.verificationOrigin).origin;
  if (
    url.protocol !== "https:" ||
    url.origin !== expectedOrigin ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("provider verification URL escaped the configured origin");
  }
  return url.toString();
}

function parseAccessToken(value: Record<string, unknown>): string {
  const token = value.access_token;
  const tokenType = value.token_type;
  if (
    !validAccessToken(token) ||
    (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer")
  ) {
    throw new Error("provider token response is missing a valid bearer access token");
  }
  return token;
}

function parseGitHubRepository(value: unknown): ProviderRepositorySummary {
  if (!isRecord(value) || typeof value.full_name !== "string" || !validRepositorySlug(value.full_name)) {
    throw new Error("GitHub repository item is invalid");
  }
  if (typeof value.name !== "string" || !boundedText(value.name, 256)) {
    throw new Error("GitHub repository name is invalid");
  }
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  return {
    provider: "github",
    slug: value.full_name,
    name: value.name,
    defaultBranch:
      typeof value.default_branch === "string" && boundedText(value.default_branch, 256)
        ? value.default_branch
        : undefined,
    private: value.private === true,
    writable:
      permissions.push === true ||
      permissions.admin === true ||
      permissions.maintain === true,
    webUrl: safeHttpsField(value.html_url, "GitHub repository web URL"),
    httpsCloneUrl: optionalSafeCloneUrl(value.clone_url, "https:"),
    sshCloneUrl: optionalSshCloneUrl(value.ssh_url),
  };
}

function parseGitLabRepository(value: unknown): ProviderRepositorySummary {
  if (
    !isRecord(value) ||
    typeof value.path_with_namespace !== "string" ||
    !validRepositorySlug(value.path_with_namespace)
  ) {
    throw new Error("GitLab project item is invalid");
  }
  if (typeof value.name !== "string" || !boundedText(value.name, 256)) {
    throw new Error("GitLab project name is invalid");
  }
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  const projectAccess = isRecord(permissions.project_access)
    ? Number(permissions.project_access.access_level)
    : 0;
  const groupAccess = isRecord(permissions.group_access)
    ? Number(permissions.group_access.access_level)
    : 0;
  return {
    provider: "gitlab",
    slug: value.path_with_namespace,
    name: value.name,
    defaultBranch:
      typeof value.default_branch === "string" && boundedText(value.default_branch, 256)
        ? value.default_branch
        : undefined,
    private: value.visibility !== "public",
    writable: Math.max(projectAccess || 0, groupAccess || 0) >= 30,
    webUrl: safeHttpsField(value.web_url, "GitLab project web URL"),
    httpsCloneUrl: optionalSafeCloneUrl(value.http_url_to_repo, "https:"),
    sshCloneUrl: optionalSshCloneUrl(value.ssh_url_to_repo),
  };
}

function apiUrl(profile: DeviceProviderProfile, suffix: string): string {
  const base = profile.apiBaseUrl.replace(/\/+$/, "");
  if (!suffix.startsWith("/")) throw new Error("provider API suffix must be absolute");
  return `${base}${suffix}`;
}

async function git(cwd: string, args: string[], network = false): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    ...(network
      ? {
          GIT_SSH_COMMAND:
            "ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes",
        }
      : {}),
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

function secretName(provider: GitProvider): "githubToken" | "gitlabToken" {
  return provider === "github" ? "githubToken" : "gitlabToken";
}

function providerLabel(provider: GitProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function boundedInterval(value: number): number {
  return Math.min(
    MAX_POLL_INTERVAL_SECONDS,
    Math.max(MIN_POLL_INTERVAL_SECONDS, Math.ceil(value)),
  );
}

function validAccessToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= MAX_TOKEN_BYTES &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function boundedTokenField(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value)
  );
}

function validRepositorySlug(value: string): boolean {
  if (
    value.length < 3 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..",
    )
  );
}

function boundedText(value: string, max: number): boolean {
  return (
    value.length >= 1 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function safeHttpsField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isCredentialFreeHttps(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalSafeCloneUrl(value: unknown, protocol: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== protocol || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function optionalSshCloneUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f\s]/.test(value)
  ) {
    return undefined;
  }
  if (/^(?:[^@\s]+@)?[^:\s/]+:.+/.test(value) || value.startsWith("ssh://")) {
    return value;
  }
  return undefined;
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

function providerHttpError(status: number): string {
  if (status === 401) return "Provider authentication failed";
  if (status === 403) return "Provider permission is insufficient";
  if (status === 404) return "Provider resource was not found";
  if (status === 429) return "Provider rate limit was reached";
  if (status >= 500) return "Provider service is unavailable";
  return "Provider request failed";
}

function safeProviderError(value: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : "provider_error";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider operation failed";
  return message.replace(/[\r\n\0]/g, " ").slice(0, 512).trim() || "Provider operation failed";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
