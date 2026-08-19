import type {
  DaemonHealth,
  ReadinessPayload,
  ServiceStatusPayload,
  StateBackupValidationView,
  WorkspaceIndexResult,
  WorkspaceSummary,
} from "../shared/desktop-api";

const DEFAULT_TIMEOUT_MS = 10_000;
const INDEX_TIMEOUT_MS = 5 * 60_000;
const INTELLIGENCE_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const INTELLIGENCE_API_PATHS = new Set([
  "/api/v1/memory/search",
  "/api/v1/search",
  "/api/v1/read",
  "/api/v1/graph/status",
  "/api/v1/graph/symbols/search",
  "/api/v1/graph/symbols/context",
  "/api/v1/graph/trace/callers",
  "/api/v1/graph/trace/callees",
  "/api/v1/graph/references",
  "/api/v1/graph/impact",
  "/api/v1/architecture/map",
  "/api/v1/architecture/cluster",
  "/api/v1/architecture/rebuild",
  "/api/v1/context/pack",
  "/api/v1/semantic/ann/status",
  "/api/v1/semantic/providers/status",
  "/api/v1/semantic/search-text",
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

export interface WorkspaceGraphStatusPayload {
  workspace: string;
  graphVersion: number;
  indexedHead?: string;
  parsedFiles: number;
  failedFiles: number;
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
    if (baseUrl.hostname === "localhost") {
      baseUrl.hostname = "127.0.0.1";
    }
    this.baseUrl = baseUrl;
    this.getBearer = options.getBearer;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<DaemonHealth> {
    const response = await this.request("/healthz", { authenticated: false });
    if (!isRecord(response) || response.status !== "ok") {
      throw new Error("SourceNerve health response is invalid");
    }
    return { status: "ok" };
  }

  async serviceStatus(): Promise<ServiceStatusPayload> {
    return this.requestObject("/api/v1/status");
  }

  async readiness(): Promise<ReadinessPayload> {
    return this.requestObject("/api/v1/readiness");
  }

  async createStateBackup(): Promise<StateBackupCreatePayload> {
    const response = await this.request("/api/v1/state/backup", {
      authenticated: true,
      method: "POST",
      body: { retain: 5 },
    });
    if (
      !isRecord(response) ||
      !isSafeBackupName(response.backup) ||
      !nonNegativeInteger(response.bytes) ||
      !nonNegativeInteger(response.retained) ||
      !nonNegativeInteger(response.pruned) ||
      !nonNegativeInteger(response.state_schema_version)
    ) {
      throw new Error("SourceNerve state backup response is invalid");
    }
    return {
      backup: response.backup,
      bytes: response.bytes,
      retained: response.retained,
      pruned: response.pruned,
      stateSchemaVersion: response.state_schema_version,
    };
  }

  async validateStateBackup(backup: string): Promise<StateBackupValidationView> {
    if (!isSafeBackupName(backup)) throw new Error("SourceNerve backup identifier is invalid");
    const response = await this.request("/api/v1/state/backup/validate", {
      authenticated: true,
      method: "POST",
      body: { backup },
    });
    if (
      !isRecord(response) ||
      response.backup !== backup ||
      typeof response.valid !== "boolean" ||
      !nonNegativeInteger(response.bytes) ||
      typeof response.integrity !== "string" ||
      response.integrity.length > 128 ||
      !nonNegativeInteger(response.migration_count) ||
      !nonNegativeInteger(response.state_schema_version)
    ) {
      throw new Error("SourceNerve state backup validation response is invalid");
    }
    return {
      backup,
      valid: response.valid,
      bytes: response.bytes,
      integrity: response.integrity,
      migrationCount: response.migration_count,
      stateSchemaVersion: response.state_schema_version,
    };
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const response = await this.request("/api/v1/workspaces", { authenticated: true });
    if (!Array.isArray(response)) {
      throw new Error("SourceNerve workspace response is invalid");
    }
    return response.map(parseWorkspaceSummary);
  }

  async workspaceSnapshot(workspace: string): Promise<WorkspaceSnapshotPayload> {
    const response = await this.request("/api/v1/snapshot", {
      authenticated: true,
      method: "POST",
      body: { workspace },
    });
    if (
      !isRecord(response) ||
      response.workspace !== workspace ||
      !isCommitSha(response.head) ||
      typeof response.dirty !== "boolean"
    ) {
      throw new Error("SourceNerve workspace snapshot response is invalid");
    }
    return { workspace, head: response.head, dirty: response.dirty };
  }

  async workspaceGraphStatus(workspace: string): Promise<WorkspaceGraphStatusPayload> {
    const response = await this.request("/api/v1/graph/status", {
      authenticated: true,
      method: "POST",
      body: { workspace },
    });
    if (
      !isRecord(response) ||
      response.workspace !== workspace ||
      !nonNegativeInteger(response.graph_version) ||
      !nonNegativeInteger(response.parsed_files) ||
      !nonNegativeInteger(response.failed_files) ||
      (response.indexed_head !== null && response.indexed_head !== undefined && !isCommitSha(response.indexed_head))
    ) {
      throw new Error("SourceNerve graph status response is invalid");
    }
    return {
      workspace,
      graphVersion: response.graph_version,
      ...(typeof response.indexed_head === "string" ? { indexedHead: response.indexed_head } : {}),
      parsedFiles: response.parsed_files,
      failedFiles: response.failed_files,
    };
  }

  async indexWorkspace(workspace: string, signal?: AbortSignal): Promise<WorkspaceIndexResult> {
    const response = await this.request("/api/v1/index", {
      authenticated: true,
      method: "POST",
      body: { workspace },
      timeoutMs: INDEX_TIMEOUT_MS,
      signal,
    });
    if (
      !isRecord(response) ||
      response.workspace !== workspace ||
      !isCommitSha(response.head) ||
      !nonNegativeInteger(response.discovered_files) ||
      !nonNegativeInteger(response.indexed_text_files) ||
      !isRecord(response.graph)
    ) {
      throw new Error("SourceNerve workspace index response is invalid");
    }
    const graph = response.graph;
    for (const field of [
      "parsed_files",
      "partial_files",
      "failed_files",
      "symbols",
      "edges",
      "unresolved_references",
    ] as const) {
      if (!nonNegativeInteger(graph[field])) {
        throw new Error("SourceNerve workspace index graph response is invalid");
      }
    }
    return {
      workspace,
      head: response.head,
      discoveredFiles: response.discovered_files,
      indexedTextFiles: response.indexed_text_files,
      graph: {
        parsedFiles: graph.parsed_files,
        partialFiles: graph.partial_files,
        failedFiles: graph.failed_files,
        symbols: graph.symbols,
        edges: graph.edges,
        unresolvedReferences: graph.unresolved_references,
      },
    };
  }

  async intelligenceRequest(
    requestPath: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!INTELLIGENCE_API_PATHS.has(requestPath)) {
      throw new Error("SourceNerve intelligence endpoint is not allowlisted");
    }
    return this.request(requestPath, {
      authenticated: true,
      method: "POST",
      ...(body ? { body } : {}),
      timeoutMs: INTELLIGENCE_TIMEOUT_MS,
    });
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
      body?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    if (!requestPath.startsWith("/")) throw new Error("SourceNerve client paths must be absolute");
    const url = new URL(requestPath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("SourceNerve client request escaped loopback origin");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    try {
      const headers = new Headers({ accept: "application/json" });
      if (options.authenticated) {
        const bearer = await this.getBearer();
        if (!bearer || bearer.length > 4096 || !/^[\x21-\x7e]+$/.test(bearer)) {
          throw new Error("SourceNerve local bearer is unavailable");
        }
        headers.set("authorization", `Bearer ${bearer}`);
      }
      let body: string | undefined;
      if (options.body) {
        body = JSON.stringify(options.body);
        if (Buffer.byteLength(body, "utf8") > 16 * 1024) {
          throw new Error("SourceNerve Desktop request body exceeded 16 KiB limit");
        }
        headers.set("content-type", "application/json");
      }

      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SourceNerveHttpError(response.status, safeStatusText(response.status));
      }
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
        throw new Error("SourceNerve API response exceeded Desktop size limit");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error("SourceNerve API response exceeded Desktop size limit");
      }
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

function parseWorkspaceSummary(value: unknown): WorkspaceSummary {
  if (!isRecord(value)) throw new Error("SourceNerve workspace item is invalid");
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.writable !== "boolean") {
    throw new Error("SourceNerve workspace item has invalid required fields");
  }
  return {
    id: value.id,
    name: value.name,
    writable: value.writable,
  };
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeBackupName(value: unknown): value is string {
  return typeof value === "string" && /^backups\/sourcenerve-[A-Za-z0-9._-]{1,200}\.sqlite3$/.test(value);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStatusText(status: number): string {
  if (status === 401) return "SourceNerve local authentication failed";
  if (status === 403) return "SourceNerve operation is not permitted";
  if (status === 404) return "SourceNerve endpoint is unavailable";
  if (status >= 500) return "SourceNerve service failed";
  return "SourceNerve request failed";
}
