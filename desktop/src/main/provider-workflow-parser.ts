import type { GitProvider } from "../shared/desktop-api";
import type {
  ProviderIssueView,
  ProviderPullView,
} from "../shared/provider-workflow-api";

export function parseProviderPull(
  value: unknown,
  context: { provider: GitProvider; repository: string },
): ProviderPullView {
  const root = requireRecord(value, "provider pull response");
  const item = unwrapRecord(root, ["pull", "pull_request", "merge_request", "observation"]);
  const number = positiveInteger(first(item, ["number", "pull_number", "iid"]), "pull number");
  const merged = optionalBoolean(first(item, ["merged", "is_merged"]));
  const rawState = optionalText(first(item, ["state", "status"]), 64)?.toLowerCase();
  const state = merged === true || rawState === "merged"
    ? "merged"
    : rawState === "closed"
      ? "closed"
      : rawState === "open" || rawState === "opened"
        ? "open"
        : invalidState(rawState);
  const draft = optionalBoolean(first(item, ["draft", "work_in_progress", "is_draft"]));
  if (draft === undefined) throw invalid("pull draft flag is missing");
  const baseBranch = boundedText(first(item, ["base_branch", "base", "target_branch"]), 1, 256, "pull base branch");
  const headBranch = boundedText(first(item, ["head_branch", "head", "source_branch"]), 1, 256, "pull head branch");
  const headSha = commitSha(first(item, ["head_sha", "head_oid", "sha"]), "pull head SHA");
  const title = optionalText(first(item, ["title"]), 1024) ?? `Change request #${number}`;
  const mergeable = optionalBoolean(first(item, ["mergeable", "can_merge"]));
  const mergeState = optionalText(first(item, ["merge_state", "mergeable_state", "detailed_merge_status"]), 256);
  const rawUrl = optionalText(first(item, ["url", "html_url", "web_url"]), 2048);
  const url = rawUrl ? safeProviderUrl(rawUrl, context.provider, context.repository) : undefined;
  return {
    provider: context.provider,
    repository: context.repository,
    number,
    title,
    state,
    draft,
    baseBranch,
    headBranch,
    headSha,
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(mergeState ? { mergeState } : {}),
    ...(url ? { url } : {}),
  };
}

export function parseProviderIssue(
  value: unknown,
  context: { provider: GitProvider; repository: string; fallbackTitle: string },
): ProviderIssueView | null {
  if (!isRecord(value)) return null;
  const item = unwrapRecord(value, ["issue"]);
  const rawNumber = first(item, ["number", "issue_number", "iid"]);
  if (rawNumber === undefined) return null;
  const number = positiveInteger(rawNumber, "issue number");
  const stateValue = optionalText(first(item, ["state", "status"]), 64)?.toLowerCase();
  const state = stateValue === "closed" ? "closed" : stateValue === "open" || stateValue === "opened" || stateValue === undefined ? "open" : invalidIssueState(stateValue);
  const title = optionalText(first(item, ["title"]), 1024) ?? context.fallbackTitle;
  const rawUrl = optionalText(first(item, ["url", "html_url", "web_url"]), 2048);
  const url = rawUrl ? safeProviderUrl(rawUrl, context.provider, context.repository) : undefined;
  return {
    provider: context.provider,
    repository: context.repository,
    number,
    title,
    state,
    ...(url ? { url } : {}),
  };
}

export function replayedFlag(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.replayed === true;
}

function safeProviderUrl(value: string, provider: GitProvider, repository: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("provider URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw invalid("provider URL must be credential-free HTTPS");
  const expectedHost = provider === "github" ? "github.com" : "gitlab.com";
  if (url.hostname.toLowerCase() !== expectedHost) throw invalid("provider URL origin is unexpected");
  const repositoryPrefix = `/${repository.replace(/^\/+|\/+$/g, "")}`.toLowerCase();
  if (!url.pathname.toLowerCase().startsWith(repositoryPrefix)) throw invalid("provider URL repository is unexpected");
  url.hash = "";
  return url.toString();
}

function unwrapRecord(root: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  for (const key of keys) {
    const candidate = root[key];
    if (isRecord(candidate)) return candidate;
  }
  return root;
}

function first(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid(`${label} is invalid`);
  return value;
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function boundedText(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid("provider text field is invalid");
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid("provider boolean field is invalid");
  return value;
}

function invalidState(value: string | undefined): never {
  throw invalid(`pull state is unsupported${value ? `: ${value}` : ""}`);
}

function invalidIssueState(value: string): never {
  throw invalid(`issue state is unsupported: ${value}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Error {
  return new Error(`SourceNerve provider response invalid: ${message}`);
}
