import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitProvider, ProviderRepositorySummary } from "../shared/desktop-api";
import type { ProviderChangeState, ProviderPullListState } from "../shared/provider-workflow-api";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REPOSITORIES = 500;
const MAX_PAGES = 5;
const MAX_TOKEN_BYTES = 4096;
const MAX_PULLS = 100;

export interface ProviderCliAccount {
  login: string;
  name?: string;
  providerUserId: string;
}

export interface ProviderCliPullSummary {
  provider: GitProvider;
  repository: string;
  number: number;
  title: string;
  state: ProviderChangeState;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  headSha?: string;
  author?: string;
  mergeable?: boolean;
  mergeState?: string;
  updatedAt?: string;
  url?: string;
}

export interface ProviderCliClient {
  account(provider: GitProvider): Promise<ProviderCliAccount>;
  repositories(provider: GitProvider): Promise<ProviderRepositorySummary[]>;
  repository(provider: GitProvider, repository: string): Promise<ProviderRepositorySummary>;
  pulls(
    provider: GitProvider,
    repository: string,
    state: ProviderPullListState,
    limit: number,
  ): Promise<ProviderCliPullSummary[]>;
  token(provider: GitProvider): Promise<string>;
}

export type ProviderCliErrorReason = "not-installed" | "not-authenticated" | "invalid-output" | "failed";

export class ProviderCliError extends Error {
  readonly provider: GitProvider;
  readonly reason: ProviderCliErrorReason;

  constructor(provider: GitProvider, reason: ProviderCliErrorReason, message: string) {
    super(message);
    this.name = "ProviderCliError";
    this.provider = provider;
    this.reason = reason;
  }
}

export const defaultProviderCliClient: ProviderCliClient = {
  account: providerCliAccount,
  repositories: providerCliRepositories,
  repository: providerCliRepository,
  pulls: providerCliPulls,
  token: providerCliToken,
};

export function providerCliName(provider: GitProvider): "gh" | "glab" {
  return provider === "github" ? "gh" : "glab";
}

export function providerCliLoginCommand(provider: GitProvider): string {
  return provider === "github"
    ? "gh auth login --hostname github.com"
    : "glab auth login --hostname gitlab.com";
}

export async function providerCliAccount(provider: GitProvider): Promise<ProviderCliAccount> {
  const value = await cliJson(provider, provider === "github"
    ? ["api", "--hostname", "github.com", "user"]
    : ["api", "--hostname", "gitlab.com", "user"]);
  if (!isRecord(value)) throw invalidOutput(provider, "account response is not an object");
  const login = provider === "github" ? value.login : value.username;
  const id = value.id;
  if (typeof login !== "string" || !boundedText(login, 256)) {
    throw invalidOutput(provider, "account login is invalid");
  }
  if ((typeof id !== "number" && typeof id !== "string") || !boundedText(String(id), 128)) {
    throw invalidOutput(provider, "account id is invalid");
  }
  const name = typeof value.name === "string" && boundedText(value.name, 256) ? value.name : undefined;
  return { login, name, providerUserId: String(id) };
}

export async function providerCliRepositories(provider: GitProvider): Promise<ProviderRepositorySummary[]> {
  const results: ProviderRepositorySummary[] = [];
  for (let page = 1; page <= MAX_PAGES && results.length < MAX_REPOSITORIES; page += 1) {
    const endpoint = provider === "github"
      ? `user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member`
      : `projects?membership=true&simple=true&per_page=100&page=${page}&order_by=last_activity_at&sort=desc`;
    const value = await cliJson(provider, ["api", "--hostname", providerHostname(provider), endpoint]);
    if (!Array.isArray(value)) throw invalidOutput(provider, "repository response is not an array");
    for (const item of value) {
      results.push(provider === "github" ? parseGitHubRepository(item) : parseGitLabRepository(item));
    }
    if (value.length < 100) break;
  }
  return results.slice(0, MAX_REPOSITORIES);
}

export async function providerCliRepository(
  provider: GitProvider,
  repository: string,
): Promise<ProviderRepositorySummary> {
  if (!validRepositorySlug(repository)) throw new Error("provider repository slug is invalid");
  const endpoint = provider === "github"
    ? `repos/${repository.split("/").map(encodeURIComponent).join("/")}`
    : `projects/${encodeURIComponent(repository)}`;
  const value = await cliJson(provider, ["api", "--hostname", providerHostname(provider), endpoint]);
  return provider === "github" ? parseGitHubRepository(value) : parseGitLabRepository(value);
}

export async function providerCliPulls(
  provider: GitProvider,
  repository: string,
  state: ProviderPullListState,
  limit: number,
): Promise<ProviderCliPullSummary[]> {
  if (!validRepositorySlug(repository)) throw new Error("provider repository slug is invalid");
  const boundedLimit = Math.max(1, Math.min(MAX_PULLS, Math.floor(limit)));
  if (provider === "github") {
    const endpoint = `repos/${repository.split("/").map(encodeURIComponent).join("/")}/pulls?state=${state}&per_page=${boundedLimit}&sort=updated&direction=desc`;
    const value = await cliJson(provider, ["api", "--hostname", "github.com", endpoint]);
    if (!Array.isArray(value)) throw invalidOutput(provider, "pull request response is not an array");
    return value.slice(0, boundedLimit).map((item) => parseGitHubPull(repository, item));
  }

  const stateQuery = state === "open" ? "&state=opened" : "";
  const endpoint = `projects/${encodeURIComponent(repository)}/merge_requests?scope=all&per_page=100&order_by=updated_at&sort=desc${stateQuery}`;
  const value = await cliJson(provider, ["api", "--hostname", "gitlab.com", endpoint]);
  if (!Array.isArray(value)) throw invalidOutput(provider, "merge request response is not an array");
  const parsed = value.map((item) => parseGitLabPull(repository, item));
  return parsed
    .filter((item) => state === "all" || (state === "open" ? item.state === "open" : item.state !== "open"))
    .slice(0, boundedLimit);
}

export async function providerCliToken(provider: GitProvider): Promise<string> {
  let token: string;
  if (provider === "github") {
    token = (await runCli(provider, ["auth", "token", "--hostname", "github.com"])).trim();
  } else {
    // glab auth status intentionally writes its human-readable status, including
    // --show-token output, to stderr. Parse both streams without logging either.
    const output = await runCliOutput(provider, ["auth", "status", "--hostname", "gitlab.com", "--show-token"]);
    token = parseGitLabToken(`${output.stdout}\n${output.stderr}`);
  }
  if (!validAccessToken(token)) {
    throw invalidOutput(provider, "CLI did not return a usable authentication token");
  }
  return token;
}

async function cliJson(provider: GitProvider, args: string[]): Promise<unknown> {
  const stdout = await runCli(provider, args);
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw invalidOutput(provider, "CLI returned invalid JSON");
  }
}

async function runCli(provider: GitProvider, args: string[]): Promise<string> {
  return (await runCliOutput(provider, args)).stdout;
}

async function runCliOutput(provider: GitProvider, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const binary = providerCliName(provider);
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      env: cliEnvironment(),
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ProviderCliError(
        provider,
        "not-installed",
        `${providerLabel(provider)} CLI '${binary}' is not installed. Install it, run '${providerCliLoginCommand(provider)}', then retry.`,
      );
    }
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string"
      ? (error as { stderr: string }).stderr
      : "";
    const combined = `${error instanceof Error ? error.message : ""} ${stderr}`.toLowerCase();
    if (/not logged|not authenticated|authenticate|auth login|login required|no accounts|token.*invalid/.test(combined)) {
      throw new ProviderCliError(
        provider,
        "not-authenticated",
        `${providerLabel(provider)} CLI is not authenticated. Run '${providerCliLoginCommand(provider)}' in a terminal, then retry.`,
      );
    }
    throw new ProviderCliError(provider, "failed", `${providerLabel(provider)} CLI command failed`);
  }
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
    "GH_CONFIG_DIR",
    "GLAB_CONFIG_DIR",
  ] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  // Intentionally do not forward GH_TOKEN/GITHUB_TOKEN/GITLAB_TOKEN/
  // GITLAB_ACCESS_TOKEN/OAUTH_TOKEN. SourceNerve trusts the user's CLI-managed
  // credential store, not ambient shell tokens.
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_NO_UPDATE_NOTIFIER = "1";
  environment.GLAB_CHECK_UPDATE = "false";
  environment.NO_COLOR = "1";
  return environment;
}

function parseGitLabToken(output: string): string {
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:token|api token)\s*:\s*(\S+)\s*$/i);
    if (match) return match[1];
  }
  return "";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseGitHubRepository(value: unknown): ProviderRepositorySummary {
  if (!isRecord(value) || typeof value.full_name !== "string" || !validRepositorySlug(value.full_name)) {
    throw invalidOutput("github", "repository item is invalid");
  }
  if (typeof value.name !== "string" || !boundedText(value.name, 256)) {
    throw invalidOutput("github", "repository name is invalid");
  }
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  return {
    provider: "github",
    slug: value.full_name,
    name: value.name,
    defaultBranch: typeof value.default_branch === "string" && boundedText(value.default_branch, 256)
      ? value.default_branch
      : undefined,
    private: value.private === true,
    writable: permissions.push === true || permissions.admin === true || permissions.maintain === true,
    webUrl: safeHttpsField(value.html_url, "GitHub repository web URL"),
    httpsCloneUrl: optionalSafeCloneUrl(value.clone_url, "https:"),
    sshCloneUrl: optionalSshCloneUrl(value.ssh_url),
  };
}

function parseGitLabRepository(value: unknown): ProviderRepositorySummary {
  if (!isRecord(value) || typeof value.path_with_namespace !== "string" || !validRepositorySlug(value.path_with_namespace)) {
    throw invalidOutput("gitlab", "project item is invalid");
  }
  if (typeof value.name !== "string" || !boundedText(value.name, 256)) {
    throw invalidOutput("gitlab", "project name is invalid");
  }
  const permissions = isRecord(value.permissions) ? value.permissions : {};
  const projectAccess = isRecord(permissions.project_access) ? Number(permissions.project_access.access_level) : 0;
  const groupAccess = isRecord(permissions.group_access) ? Number(permissions.group_access.access_level) : 0;
  return {
    provider: "gitlab",
    slug: value.path_with_namespace,
    name: value.name,
    defaultBranch: typeof value.default_branch === "string" && boundedText(value.default_branch, 256)
      ? value.default_branch
      : undefined,
    private: value.visibility !== "public",
    writable: Math.max(projectAccess || 0, groupAccess || 0) >= 30,
    webUrl: safeHttpsField(value.web_url, "GitLab project web URL"),
    httpsCloneUrl: optionalSafeCloneUrl(value.http_url_to_repo, "https:"),
    sshCloneUrl: optionalSshCloneUrl(value.ssh_url_to_repo),
  };
}

function parseGitHubPull(repository: string, value: unknown): ProviderCliPullSummary {
  if (!isRecord(value) || typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1) {
    throw invalidOutput("github", "pull request number is invalid");
  }
  if (typeof value.title !== "string" || !boundedText(value.title, 1024)) {
    throw invalidOutput("github", "pull request title is invalid");
  }
  const base = isRecord(value.base) ? value.base : {};
  const head = isRecord(value.head) ? value.head : {};
  const user = isRecord(value.user) ? value.user : {};
  const state: ProviderChangeState = typeof value.merged_at === "string"
    ? "merged"
    : value.state === "closed"
      ? "closed"
      : "open";
  return {
    provider: "github",
    repository,
    number: value.number,
    title: value.title,
    state,
    draft: value.draft === true,
    baseBranch: requiredBranch(base.ref, "GitHub pull request base branch"),
    headBranch: requiredBranch(head.ref, "GitHub pull request head branch"),
    ...(typeof head.sha === "string" && /^[0-9a-f]{40}$/i.test(head.sha) ? { headSha: head.sha } : {}),
    ...(typeof user.login === "string" && boundedText(user.login, 256) ? { author: user.login } : {}),
    ...(typeof value.mergeable === "boolean" ? { mergeable: value.mergeable } : {}),
    ...(typeof value.mergeable_state === "string" && boundedText(value.mergeable_state, 128)
      ? { mergeState: value.mergeable_state }
      : {}),
    ...(typeof value.updated_at === "string" && validIsoDate(value.updated_at) ? { updatedAt: value.updated_at } : {}),
    ...(typeof value.html_url === "string" ? { url: safeProviderPullUrl(value.html_url, "github") } : {}),
  };
}

function parseGitLabPull(repository: string, value: unknown): ProviderCliPullSummary {
  if (!isRecord(value) || typeof value.iid !== "number" || !Number.isSafeInteger(value.iid) || value.iid < 1) {
    throw invalidOutput("gitlab", "merge request number is invalid");
  }
  if (typeof value.title !== "string" || !boundedText(value.title, 1024)) {
    throw invalidOutput("gitlab", "merge request title is invalid");
  }
  const author = isRecord(value.author) ? value.author : {};
  const state: ProviderChangeState = value.state === "merged"
    ? "merged"
    : value.state === "closed"
      ? "closed"
      : "open";
  const titleDraft = /^(?:draft|wip)\s*:/i.test(value.title);
  return {
    provider: "gitlab",
    repository,
    number: value.iid,
    title: value.title,
    state,
    draft: value.draft === true || value.work_in_progress === true || titleDraft,
    baseBranch: requiredBranch(value.target_branch, "GitLab merge request target branch"),
    headBranch: requiredBranch(value.source_branch, "GitLab merge request source branch"),
    ...(typeof value.sha === "string" && /^[0-9a-f]{40}$/i.test(value.sha) ? { headSha: value.sha } : {}),
    ...(typeof author.username === "string" && boundedText(author.username, 256) ? { author: author.username } : {}),
    ...(typeof value.detailed_merge_status === "string" && boundedText(value.detailed_merge_status, 128)
      ? { mergeState: value.detailed_merge_status }
      : {}),
    ...(typeof value.updated_at === "string" && validIsoDate(value.updated_at) ? { updatedAt: value.updated_at } : {}),
    ...(typeof value.web_url === "string" ? { url: safeProviderPullUrl(value.web_url, "gitlab") } : {}),
  };
}

function requiredBranch(value: unknown, label: string): string {
  if (typeof value !== "string" || !boundedText(value, 512)) throw new Error(`${label} is invalid`);
  return value;
}

function validIsoDate(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function safeProviderPullUrl(value: string, provider: GitProvider): string {
  const url = safeHttpsField(value, `${providerLabel(provider)} pull request web URL`);
  const parsed = new URL(url);
  if (parsed.hostname !== providerHostname(provider)) {
    throw invalidOutput(provider, "pull request web URL host is invalid");
  }
  return url;
}

function providerHostname(provider: GitProvider): string {
  return provider === "github" ? "github.com" : "gitlab.com";
}

function providerLabel(provider: GitProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function invalidOutput(provider: GitProvider, message: string): ProviderCliError {
  return new ProviderCliError(provider, "invalid-output", `${providerLabel(provider)} ${message}`);
}

function validAccessToken(value: string): boolean {
  return value.length >= 20 && value.length <= MAX_TOKEN_BYTES && /^[\x21-\x7e]+$/.test(value);
}

function validRepositorySlug(value: string): boolean {
  if (value.length < 3 || value.length > 512 || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function boundedText(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeHttpsField(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} is invalid`);
  }
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
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  if (/^(?:[^@\s]+@)?[^:\s/]+:.+/.test(value) || value.startsWith("ssh://")) return value;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
