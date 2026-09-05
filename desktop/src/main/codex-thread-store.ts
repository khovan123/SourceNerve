import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1 as const;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_BINDINGS = 2_000;

export interface CodexThreadBinding {
  runId: string;
  workspaceId: string;
  cwd: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
}

interface CodexThreadRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  bindings: CodexThreadBinding[];
}

/**
 * Persists only SourceNerve Harness run -> Codex thread identity.
 * Message history, checkpoints, compaction and model state stay owned by Codex.
 */
export class CodexThreadStore {
  private bindings = new Map<string, CodexThreadBinding>();
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const registry = await readRegistry(this.filePath);
    this.bindings = new Map(registry.bindings.map((binding) => [binding.runId, binding]));
    this.initialized = true;
  }

  get(runId: string): CodexThreadBinding | null {
    this.assertInitialized();
    const binding = this.bindings.get(runId);
    return binding ? { ...binding } : null;
  }

  list(): CodexThreadBinding[] {
    this.assertInitialized();
    return [...this.bindings.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((binding) => ({ ...binding }));
  }

  async bind(input: { runId: string; workspaceId: string; cwd: string; threadId: string }): Promise<CodexThreadBinding> {
    this.assertInitialized();
    const existing = this.bindings.get(input.runId);
    if (existing && (existing.workspaceId !== input.workspaceId || existing.cwd !== path.resolve(input.cwd))) {
      throw new Error("Codex Harness run is already bound to a different workspace");
    }
    if (existing && existing.threadId !== input.threadId) {
      throw new Error("Codex Harness run is already bound to a different Codex thread");
    }
    validateIdentifier(input.runId, "Codex run id");
    validateIdentifier(input.workspaceId, "Codex workspace id");
    validateIdentifier(input.threadId, "Codex thread id");
    if (!path.isAbsolute(input.cwd)) throw new Error("Codex binding cwd must be absolute");
    const timestamp = this.now().toISOString();
    const binding: CodexThreadBinding = existing
      ? { ...existing, updatedAt: timestamp }
      : {
          runId: input.runId,
          workspaceId: input.workspaceId,
          cwd: path.resolve(input.cwd),
          threadId: input.threadId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    this.bindings.set(binding.runId, binding);
    await this.enqueueWrite();
    return { ...binding };
  }

  async remove(runId: string): Promise<boolean> {
    this.assertInitialized();
    const removed = this.bindings.delete(runId);
    if (removed) await this.enqueueWrite();
    return removed;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueueWrite(): Promise<void> {
    const snapshot: CodexThreadRegistry = {
      schemaVersion: SCHEMA_VERSION,
      bindings: [...this.bindings.values()].map((binding) => ({ ...binding })),
    };
    const write = this.writeQueue.then(() => writeRegistry(this.filePath, snapshot));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Codex thread store is not initialized");
  }
}

async function readRegistry(filePath: string): Promise<CodexThreadRegistry> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) throw new Error("Codex thread registry exceeds 512 KiB");
    const parsed = JSON.parse(raw) as Partial<CodexThreadRegistry>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.bindings) || parsed.bindings.length > MAX_BINDINGS) {
      throw new Error("unsupported Codex thread registry schema");
    }
    const seen = new Set<string>();
    const bindings = parsed.bindings.map((value) => validateBinding(value));
    for (const binding of bindings) {
      if (seen.has(binding.runId)) throw new Error("duplicate Codex run binding");
      seen.add(binding.runId);
    }
    return { schemaVersion: SCHEMA_VERSION, bindings };
  } catch (error) {
    if (isMissing(error)) return { schemaVersion: SCHEMA_VERSION, bindings: [] };
    throw error;
  }
}

async function writeRegistry(filePath: string, registry: CodexThreadRegistry): Promise<void> {
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new Error("Codex thread registry exceeds 512 KiB");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function validateBinding(value: unknown): CodexThreadBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Codex thread binding");
  const record = value as Partial<CodexThreadBinding>;
  validateIdentifier(record.runId, "Codex run id");
  validateIdentifier(record.workspaceId, "Codex workspace id");
  validateIdentifier(record.threadId, "Codex thread id");
  if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd)) throw new Error("invalid Codex binding cwd");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("invalid Codex binding createdAt");
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("invalid Codex binding updatedAt");
  return {
    runId: record.runId,
    workspaceId: record.workspaceId,
    cwd: path.resolve(record.cwd),
    threadId: record.threadId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
