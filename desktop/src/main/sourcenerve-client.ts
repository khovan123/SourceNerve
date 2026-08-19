import type {
  DaemonHealth,
  ReadinessPayload,
  ServiceStatusPayload,
  WorkspaceSummary,
} from "../shared/desktop-api";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SourceNerveClientOptions {
  baseUrl: string;
  getBearer(): Promise<string>;
  timeoutMs?: number;
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
    this.baseUrl = baseUrl;
    this.getBearer = options.getBearer;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<DaemonHealth> {
    const response = await this.request("/healthz", false);
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

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const response = await this.request("/api/v1/workspaces", true);
    if (!Array.isArray(response)) {
      throw new Error("SourceNerve workspace response is invalid");
    }
    return response.map(parseWorkspaceSummary);
  }

  private async requestObject(path: string): Promise<Record<string, unknown>> {
    const response = await this.request(path, true);
    if (!isRecord(response)) throw new Error("SourceNerve API response is not an object");
    return response;
  }

  private async request(path: string, authenticated: boolean): Promise<unknown> {
    if (!path.startsWith("/")) throw new Error("SourceNerve client paths must be absolute");
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("SourceNerve client request escaped loopback origin");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (authenticated) {
        const bearer = await this.getBearer();
        if (!bearer || bearer.length > 4096 || !/^[\x21-\x7e]+$/.test(bearer)) {
          throw new Error("SourceNerve local bearer is unavailable");
        }
        headers.set("authorization", `Bearer ${bearer}`);
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeStatusText(status: number): string {
  if (status === 401) return "SourceNerve local authentication failed";
  if (status === 403) return "SourceNerve operation is not permitted";
  if (status === 404) return "SourceNerve endpoint is unavailable";
  if (status >= 500) return "SourceNerve service failed";
  return "SourceNerve request failed";
}
