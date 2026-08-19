import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import type {
  DesktopRuntimeEvent,
  RuntimeLogEntry,
  RuntimeLogSnapshot,
} from "../shared/desktop-api";

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_MEMORY_BYTES = 512 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_ROTATIONS = 3;
const MAX_MESSAGE_BYTES = 4_096;

export interface RuntimeLogStoreOptions {
  maxEntries?: number;
  maxMemoryBytes?: number;
  maxFileBytes?: number;
  rotations?: number;
  homeDirectory?: string;
}

export class RuntimeLogStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly maxMemoryBytes: number;
  private readonly maxFileBytes: number;
  private readonly rotations: number;
  private readonly homeDirectory?: string;
  private entries: RuntimeLogEntry[] = [];
  private memoryBytes = 0;
  private sequence = 0;
  private droppedEntries = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory: string, options: RuntimeLogStoreOptions = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, "desktop-runtime.log");
    this.maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 16, 20_000);
    this.maxMemoryBytes = boundedInteger(
      options.maxMemoryBytes,
      DEFAULT_MAX_MEMORY_BYTES,
      16 * 1024,
      16 * 1024 * 1024,
    );
    this.maxFileBytes = boundedInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      512,
      64 * 1024 * 1024,
    );
    this.rotations = boundedInteger(options.rotations, DEFAULT_ROTATIONS, 1, 10);
    this.homeDirectory = options.homeDirectory;
  }

  record(event: DesktopRuntimeEvent): RuntimeLogEntry | null {
    const entry = eventToLogEntry(event, ++this.sequence, this.homeDirectory);
    if (!entry) return null;

    const bytes = entryBytes(entry);
    this.entries.push(entry);
    this.memoryBytes += bytes;
    while (
      this.entries.length > this.maxEntries ||
      (this.entries.length > 1 && this.memoryBytes > this.maxMemoryBytes)
    ) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.memoryBytes = Math.max(0, this.memoryBytes - entryBytes(removed));
      this.droppedEntries += 1;
    }

    const serialized = `${JSON.stringify(entry)}\n`;
    this.writeQueue = this.writeQueue
      .then(() => this.appendSerialized(serialized))
      .catch(() => undefined);
    return { ...entry };
  }

  snapshot(): RuntimeLogSnapshot {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      droppedEntries: this.droppedEntries,
      maxEntries: this.maxEntries,
      maxBytes: this.maxMemoryBytes,
    };
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async currentFileTail(maxBytes = 128 * 1024): Promise<string> {
    const bounded = boundedInteger(maxBytes, 128 * 1024, 4 * 1024, 512 * 1024);
    try {
      const content = await readFile(this.filePath);
      return content.subarray(Math.max(0, content.length - bounded)).toString("utf8");
    } catch (error) {
      if (isMissing(error)) return "";
      throw error;
    }
  }

  private async appendSerialized(serialized: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.byteLength(serialized, "utf8");
    let currentSize = 0;
    try {
      currentSize = (await stat(this.filePath)).size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (currentSize > 0 && currentSize + bytes > this.maxFileBytes) {
      await this.rotate();
    }
    await appendFile(this.filePath, serialized, { encoding: "utf8", mode: 0o600 });
  }

  private async rotate(): Promise<void> {
    await rm(`${this.filePath}.${this.rotations}`, { force: true });
    for (let index = this.rotations - 1; index >= 1; index -= 1) {
      try {
        await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    try {
      await rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function sanitizeRuntimeEvent(
  event: DesktopRuntimeEvent,
  homeDirectory?: string,
): DesktopRuntimeEvent {
  if (event.type === "log") {
    return {
      ...event,
      message: sanitizeRuntimeText(event.message, homeDirectory),
      timestamp: validTimestamp(event.timestamp) ? event.timestamp : new Date().toISOString(),
    };
  }
  if (event.type === "state") {
    return {
      ...event,
      ...(event.message
        ? { message: sanitizeRuntimeText(event.message, homeDirectory) }
        : {}),
    };
  }
  return {
    ...event,
    operationId: sanitizeIdentifier(event.operationId),
    stage: sanitizeIdentifier(event.stage),
  };
}

export function sanitizeRuntimeText(value: string, homeDirectory?: string): string {
  let result = value.replace(/[\r\0]/g, " ");
  result = result
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\b(token|secret|credential|password|client_secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/https:\/\/[^\s/@:]+:[^\s/@]+@/gi, "https://[REDACTED]@")
    .replace(/eyJ[A-Za-z0-9._~-]{20,}/g, "[REDACTED]");
  if (homeDirectory && homeDirectory.length > 1) {
    result = result.split(homeDirectory).join("[HOME]");
  }
  const bytes = Buffer.from(result, "utf8");
  if (bytes.length > MAX_MESSAGE_BYTES) {
    result = bytes.subarray(0, MAX_MESSAGE_BYTES).toString("utf8");
  }
  return result.trim() || "Desktop runtime event";
}

function eventToLogEntry(
  event: DesktopRuntimeEvent,
  sequence: number,
  homeDirectory?: string,
): RuntimeLogEntry | null {
  const safe = sanitizeRuntimeEvent(event, homeDirectory);
  if (safe.type === "log") {
    return {
      sequence,
      timestamp: safe.timestamp,
      component: safe.component,
      level: safe.level,
      message: safe.message,
    };
  }
  if (safe.type === "state") {
    return {
      sequence,
      timestamp: new Date().toISOString(),
      component: safe.component,
      level: stateLevel(safe.state),
      message: safe.message ? `${safe.state}: ${safe.message}` : safe.state,
    };
  }
  return {
    sequence,
    timestamp: new Date().toISOString(),
    component: "desktop",
    level: "debug",
    message: `${safe.operationId}: ${safe.stage}${
      safe.current !== undefined
        ? ` (${safe.current}${safe.total !== undefined ? `/${safe.total}` : ""})`
        : ""
    }`,
  };
}

function stateLevel(state: string): RuntimeLogEntry["level"] {
  const normalized = state.toLowerCase();
  if (["error", "crashed", "incompatible"].some((value) => normalized.includes(value))) {
    return "error";
  }
  if (["degraded", "offline", "expired", "needs-attention", "revoked"].some((value) => normalized.includes(value))) {
    return "warn";
  }
  return "info";
}

function entryBytes(entry: RuntimeLogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128) || "unknown";
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value === undefined) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
