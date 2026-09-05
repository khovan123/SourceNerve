import type {
  DaemonHealth,
  ReadinessPayload,
  ServiceStatusPayload,
  StateBackupValidationView,
  WorkspaceSummary,
} from "../shared/desktop-api";

const DEFAULT_TIMEOUT_MS = 10_000;
const TASK_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024;
const TASK_MAX_REQUEST_BYTES = 1_100_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 1_024;
const HARNESS_DESKTOP_VIEW_HEADER = "x-sourcenerve-harness-view";
const HARNESS_DESKTOP_VIEW = "desktop-compact";

const TASK_API_PATHS = new Set([
  "/api/v1/tasks/begin",
  "/api/v1/tasks/get",
  "/api/v1/tasks/cancel",
  "/api/v1/tasks/proposals/create",
  "/api/v1/tasks/proposals/apply",
  "/api/v1/tasks/lifecycle/branch",
  "/api/v1/tasks/lifecycle/review",
  "/api/v1/tasks/lifecycle/commit",
  "/api/v1/tasks/lifecycle/push",
]);
const HARNESS_API_PATHS = new Set([
  "/api/v1/harness/context/route",
  "/api/v1/harness/agent/turns/begin",
  "/api/v1/harness/agent/turns/get",
  "/api/v1/harness/agent/turns/list",
  "/api/v1/harness/agent/turns/iteration",
  "/api/v1/harness/agent/turns/complete",
  "/api/v1/harness/agent/memory",
  "/api/v1/harness/agent/evaluations/run",
  "/api/v1/harness/agent/evaluations/list",
  "/api/v1/harness/agent/evaluations/judge",
  "/api/v1/harness/runs/begin",
  "/api/v1/harness/runs/list",
  "/api/v1/harness/runs/get",
  "/api/v1/harness/runs/events",
  "/api/v1/harness/runs/cancel",
  "/api/v1/harness/jobs/list",
  "/api/v1/harness/jobs/call",
  "/api/v1/harness/approvals/list",
  "/api/v1/harness/approvals/respond",
  "/api/v1/harness/approvals/native/resolve",
]);
const HARNESS_APPROVAL_API_PATHS = new Set([
  "/api/v1/harness/approvals/list",
  "/api/v1/harness/approvals/respond",
  "/api/v1/harness/approvals/native/resolve",
]);

export interface SourceNerveClientOptions {
  baseUrl: string;
  getBearer(): Promise<string>;
  timeoutMs?: number;
}

export interface WorkspaceSnapshotPayload {
  workspace: string;
  head: string;
  dirty: boolean;
}

export interface WorkspaceFileReadPayload {
  path: string;
  sha256: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface StateBackupCreatePayload {
  backup: string;
  bytes: number;
  retained: number;
  pruned: number;
  stateSchemaVersion: number;
}

export class SourceNerveClient {
  private readonly baseUrl: URL;
  private readonly getBearer: () => Promise<string>;
  private readonly timeoutMs: number;

  constructor(options: SourceNerveClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" || !isLoopbackHostname(baseUrl.hostname)) {
      throw new Error("Desktop SourceNerve client requires a loopback HTTP base URL");
    }
    if (baseUrl.hostname === "localhost") baseUrl.hostname = "127.0.0.1";
    this.baseUrl = baseUrl;
    this.getBearer = options.getBearer;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<DaemonHealth> {
    const response = await this.request("/healthz", { authenticated: false });
    if (!isRecord(response) || response.status !== "ok") throw new Error("SourceNerve health response is invalid");
    return { status: "ok" };
  }

  async serviceStatus(): Promise<ServiceStatusPayload> {
    return this.requestObject("/api/v1/status");
  }

  async readiness(): Promise<ReadinessPayload> {
    return this.requestObject("/api/v1/readiness");
  }

  async createStateBackup(): Promise<StateBackupCreatePayload> {
    const response = await this.request("/api/v1/state/backup", { authenticated: true, method: "POST", body: { retain: 5 } });
    if (!isRecord(response) || !isSafeBackupName(response.backup) || !nonNegativeInteger(response.bytes) || !nonNegativeInteger(response.retained) || !nonNegativeInteger(response.pruned) || !nonNegativeInteger(response.state_schema_version)) {
      throw new Error("SourceNerve state backup response is invalid");
    }
    return { backup: response.backup, bytes: response.bytes, retained: response.retained, pruned: response.pruned, stateSchemaVersion: response.state_schema_version };
  }

  async validateStateBackup(backup: string): Promise<StateBackupValidationView> {
    if (!isSafeBackupName(backup)) throw new Error("SourceNerve backup identifier is invalid");
    const response = await this.request("/api/v1/state/backup/validate", { authenticated: true, method: "POST", body: { backup } });
    if (!isRecord(response) || response.backup !== backup || typeof response.valid !== "boolean" || !nonNegativeInteger(response.bytes) || typeof response.integrity !== "string" || response.integrity.length > 128 || !nonNegativeInteger(response.migration_count) || !nonNegativeInteger(response.state_schema_version)) {
      throw new Error("SourceNerve state backup validation response is invalid");
    }
    return { backup, valid: response.valid, bytes: response.bytes, integrity: response.integrity, migrationCount: response.migration_count, stateSchemaVersion: response.state_schema_version };
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const response = await this.request("/api/v1/workspaces", { authenticated: true });
    if (!Array.isArray(response)) throw new Error("SourceNerve workspace response is invalid");
    return response.map(parseWorkspaceSummary);
  }

  async workspaceSnapshot(workspace: string): Promise<WorkspaceSnapshotPayload> {
    const response = await this.request("/api/v1/snapshot", { authenticated: true, method: "POST", body: { workspace } });
    if (!isRecord(response) || response.workspace !== workspace || !isCommitSha(response.head) || typeof response.dirty !== "boolean") throw new Error("SourceNerve workspace snapshot response is invalid");
    return { workspace, head: response.head, dirty: response.dirty };
  }

  async readWorkspaceFile(workspace: string, path: string, startLine = 1, endLine = 1): Promise<WorkspaceFileReadPayload> {
    const response = await this.request("/api/v1/read", { authenticated: true, method: "POST", body: { workspace, path, start_line: startLine, end_line: endLine } });
    if (!isRecord(response) || response.path !== path || typeof response.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(response.sha256) || !nonNegativeInteger(response.start_line) || !nonNegativeInteger(response.end_line) || typeof response.content !== "string") {
      throw new Error("SourceNerve file read response is invalid");
    }
    return { path: response.path, sha256: response.sha256, startLine: response.start_line, endLine: response.end_line, content: response.content };
  }

  async taskRequest(requestPath: string, body: object): Promise<unknown> {
    if (!TASK_API_PATHS.has(requestPath)) throw new Error("SourceNerve task endpoint is not allowlisted");
    return this.request(requestPath, {
      authenticated: true,
      method: "POST",
      body,
      timeoutMs: TASK_TIMEOUT_MS,
      maxRequestBytes: TASK_MAX_REQUEST_BYTES,
      includeGuardError: true,
    });
  }

  async harnessRequest(requestPath: string, body: object): Promise<unknown> {
    if (!HARNESS_API_PATHS.has(requestPath)) throw new Error("SourceNerve Harness endpoint is not allowlisted");
    return this.request(requestPath, {
      authenticated: true,
      method: "POST",
      body,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      includeGuardError: true,
      compactHarnessResponse: true,
    });
  }

  async harnessApprovalRequest(requestPath: string, body: object): Promise<unknown> {
    if (!HARNESS_APPROVAL_API_PATHS.has(requestPath)) throw new Error("SourceNerve Harness approval endpoint is not allowlisted");
    return this.harnessRequest(requestPath, body);
  }

  private async requestObject(path: string): Promise<Record<string, unknown>> {
    const response = await this.request(path, { authenticated: true });
    if (!isRecord(response)) throw new Error("SourceNerve API response is not an object");
    return response;
  }

  private async request(
    requestPath: string,
    options: {
      authenticated: boolean;
      method?: "GET" | "POST";
      body?: object;
      timeoutMs?: number;
      maxRequestBytes?: number;
      includeGuardError?: boolean;
      compactHarnessResponse?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    if (!requestPath.startsWith("/")) throw new Error("SourceNerve client paths must be absolute");
    const url = new URL(requestPath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error("SourceNerve client request escaped loopback origin");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    try {
      const headers = new Headers({ accept: "application/json" });
      if (options.compactHarnessResponse) headers.set(HARNESS_DESKTOP_VIEW_HEADER, HARNESS_DESKTOP_VIEW);
      if (options.authenticated) {
        const bearer = await this.getBearer();
        if (!bearer || bearer.length > 4096 || !/^[\x21-\x7e]+$/.test(bearer)) throw new Error("SourceNerve local bearer is unavailable");
        headers.set("authorization", `Bearer ${bearer}`);
      }
      let body: string | undefined;
      if (options.body) {
        body = JSON.stringify(options.body);
        if (Buffer.byteLength(body, "utf8") > (options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)) {
          throw new Error("SourceNerve Desktop request body exceeded size limit");
        }
        headers.set("content-type", "application/json");
      }
      const response = await fetch(url, { method: options.method ?? "GET", headers, body, redirect: "error", signal: controller.signal });
      if (!response.ok) {
        const detail = options.includeGuardError && [400, 403, 404, 409].includes(response.status)
          ? await safeGuardError(response)
          : null;
        throw new SourceNerveHttpError(response.status, detail ?? safeStatusText(response.status));
      }
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error("SourceNerve API response exceeded Desktop size limit");
      const text = await readTextBounded(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("SourceNerve API returned invalid JSON");
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export class SourceNerveHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SourceNerveHttpError";
    this.status = status;
  }
}

async function safeGuardError(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_ERROR_RESPONSE_BYTES) return null;
  try {
    const raw = await readTextBounded(response, MAX_ERROR_RESPONSE_BYTES);
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.error !== "string") return null;
    const clean = value.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!clean) return null;
    const bytes = Buffer.from(clean, "utf8");
    return bytes.length <= MAX_ERROR_MESSAGE_BYTES
      ? clean
      : `${bytes.subarray(0, MAX_ERROR_MESSAGE_BYTES).toString("utf8").replace(/�+$/g, "")}…`;
  } catch {
    return null;
  }
}

async function readTextBounded(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("SourceNerve API response exceeded Desktop size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

function parseWorkspaceSummary(value: unknown): WorkspaceSummary {
  if (!isRecord(value)) throw new Error("SourceNerve workspace item is invalid");
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.writable !== "boolean") throw new Error("SourceNerve workspace item has invalid required fields");
  return { id: value.id, name: value.name, writable: value.writable };
}
function isCommitSha(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value); }
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isSafeBackupName(value: unknown): value is string { return typeof value === "string" && /^backups\/sourcenerve-[A-Za-z0-9._-]{1,200}\.sqlite3$/.test(value); }
function isLoopbackHostname(hostname: string): boolean { return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1"; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeStatusText(status: number): string {
  if (status === 401) return "SourceNerve local authentication failed";
  if (status === 403) return "SourceNerve operation is not permitted";
  if (status === 404) return "SourceNerve endpoint is unavailable";
  if (status >= 500) return "SourceNerve service failed";
  return "SourceNerve request failed";
}