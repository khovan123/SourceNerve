const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

export interface ProviderWorkflowClientOptions {
  baseUrl: string;
  getBearer(): Promise<string>;
  timeoutMs?: number;
}

export class ProviderWorkflowClient {
  private readonly baseUrl: URL;
  private readonly getBearer: () => Promise<string>;
  private readonly timeoutMs: number;

  constructor(options: ProviderWorkflowClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" || !isLoopback(baseUrl.hostname)) {
      throw new Error("Desktop provider workflow requires a loopback SourceNerve URL");
    }
    if (baseUrl.hostname === "localhost") baseUrl.hostname = "127.0.0.1";
    this.baseUrl = baseUrl;
    this.getBearer = options.getBearer;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  createIssue(input: { taskId: string; title: string; body: string }): Promise<unknown> {
    return this.post("/api/v1/tasks/provider/issues/create", {
      task_id: input.taskId,
      title: input.title,
      body: input.body,
    });
  }

  createPull(input: { taskId: string; title: string; body: string; draft: boolean }): Promise<unknown> {
    return this.post("/api/v1/tasks/provider/pulls/create", {
      task_id: input.taskId,
      title: input.title,
      body: input.body,
      draft: input.draft,
    });
  }

  getPull(taskId: string): Promise<unknown> {
    return this.post("/api/v1/tasks/provider/pulls/get", { task_id: taskId });
  }

  mergePull(input: { taskId: string; expectedHeadSha: string; method: string }): Promise<unknown> {
    return this.post("/api/v1/tasks/provider/pulls/merge", {
      task_id: input.taskId,
      expected_head_sha: input.expectedHeadSha,
      merge_method: input.method,
    });
  }

  syncDefault(taskId: string): Promise<unknown> {
    return this.post("/api/v1/tasks/provider/default-sync", { task_id: taskId });
  }

  private async post(requestPath: string, bodyValue: object): Promise<unknown> {
    const url = new URL(requestPath, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || url.protocol !== "http:" || !isLoopback(url.hostname)) {
      throw new Error("Provider workflow request escaped SourceNerve loopback origin");
    }
    const body = JSON.stringify(bodyValue);
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
      throw new Error("Provider workflow request exceeded Desktop size limit");
    }
    const bearer = await this.getBearer();
    if (!bearer || bearer.length > 4096 || !/^[\x21-\x7e]+$/.test(bearer)) {
      throw new Error("SourceNerve local bearer is unavailable");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${bearer}`,
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = [400, 403, 404, 409, 422].includes(response.status)
          ? await safeProviderError(response)
          : null;
        throw new ProviderWorkflowHttpError(
          response.status,
          detail ?? safeStatusText(response.status),
        );
      }
      const text = await readTextBounded(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("SourceNerve provider workflow returned invalid JSON");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ProviderWorkflowHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderWorkflowHttpError";
  }
}

async function safeProviderError(response: Response): Promise<string | null> {
  try {
    const raw = await readTextBounded(response, MAX_ERROR_BYTES);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.error !== "string") return null;
    const clean = parsed.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return clean ? clean.slice(0, 2048) : null;
  } catch {
    return null;
  }
}

async function readTextBounded(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) throw new Error("SourceNerve provider workflow response exceeded Desktop size limit");
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error("SourceNerve provider workflow response exceeded Desktop size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function safeStatusText(status: number): string {
  if (status === 401) return "SourceNerve local authentication failed";
  if (status === 403) return "Provider operation is blocked by provider policy or authorization";
  if (status === 404) return "Provider task resource was not found";
  if (status === 409) return "Provider task state changed; refresh before retrying";
  if (status === 422) return "Provider rejected the requested operation";
  if (status >= 500) return "Provider workflow service failed";
  return "Provider workflow request failed";
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
