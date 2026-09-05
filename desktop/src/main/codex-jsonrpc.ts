import type { Readable, Writable } from "node:stream";

const MAX_JSON_LINE_BYTES = 4 * 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface CodexJsonRpcOptions {
  readable: Readable;
  writable: Writable;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => Promise<unknown> | unknown;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class CodexJsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexJsonRpcError";
  }
}

export class CodexJsonRpcConnection {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private readonly onNotification?: CodexJsonRpcOptions["onNotification"];
  private readonly onServerRequest?: CodexJsonRpcOptions["onServerRequest"];
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private failure: Error | null = null;

  constructor(options: CodexJsonRpcOptions) {
    this.readable = options.readable;
    this.writable = options.writable;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.readable.setEncoding("utf8");
    this.readable.on("data", this.handleData);
    this.readable.on("error", this.handleTransportError);
    this.writable.on("error", this.handleTransportError);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.assertOpen();
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    try {
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  notify(method: string, params?: unknown): void {
    this.assertOpen();
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  close(reason = "Codex app-server transport closed"): void {
    this.fail(new Error(reason));
  }

  private readonly handleData = (chunk: string | Buffer): void => {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_JSON_LINE_BYTES && !this.buffer.includes("\n")) {
      this.fail(new Error("Codex app-server JSON-RPC line exceeds 4 MiB"));
      return;
    }

    while (!this.closed) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
        this.fail(new Error("Codex app-server JSON-RPC line exceeds 4 MiB"));
        return;
      }
      this.handleLine(line);
    }
  };

  private readonly handleTransportError = (error: Error): void => {
    this.fail(error);
  };

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("Codex app-server emitted invalid JSON-RPC"));
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.fail(new Error("Codex app-server emitted invalid JSON-RPC envelope"));
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") {
      this.fail(new Error("Codex app-server emitted unsupported JSON-RPC version"));
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && ("result" in message || "error" in message) && message.method === undefined) {
      this.handleResponse(message.id, message);
      return;
    }

    if (typeof message.method === "string") {
      if (typeof message.id === "number" || typeof message.id === "string") {
        void this.handleServerRequest({ id: message.id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
        return;
      }
      this.onNotification?.(message.method, message.params);
      return;
    }

    this.fail(new Error("Codex app-server emitted unknown JSON-RPC envelope"));
  }

  private handleResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error !== undefined) {
      const error = asRpcError(message.error, pending.method);
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    if (this.closed) return;
    if (!this.onServerRequest) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `SourceNerve P1 does not implement app-server request ${request.method}` },
      });
      return;
    }
    try {
      const result = await this.onServerRequest(request);
      if (!this.closed) this.write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (this.closed) return;
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: error instanceof Error ? error.message : "SourceNerve app-server request handler failed" },
      });
    }
  }

  private write(message: object): void {
    this.assertOpen();
    const serialized = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_LINE_BYTES) throw new Error("Codex app-server JSON-RPC request exceeds 4 MiB");
    const accepted = this.writable.write(serialized, "utf8");
    if (!accepted && (this.writable as Writable).writableNeedDrain) {
      // Node will buffer until drain. Request ordering is preserved by the stream.
    }
  }

  private assertOpen(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Codex app-server JSON-RPC connection is closed");
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.readable.off("data", this.handleData);
    this.readable.off("error", this.handleTransportError);
    this.writable.off("error", this.handleTransportError);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function asRpcError(value: unknown, method: string): CodexJsonRpcError {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new CodexJsonRpcError(`Codex app-server ${method} failed`, -32603, value);
  }
  const record = value as Record<string, unknown>;
  const code = Number.isSafeInteger(record.code) ? Number(record.code) : -32603;
  const message = typeof record.message === "string" && record.message.length > 0
    ? record.message
    : `Codex app-server ${method} failed`;
  return new CodexJsonRpcError(message, code, record.data);
}
