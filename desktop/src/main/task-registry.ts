import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopTaskReference } from "../shared/task-api";

const SCHEMA_VERSION = 1 as const;
const MAX_REFERENCES = 200;

interface StoredTaskRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  tasks: DesktopTaskReference[];
}

export class DesktopTaskRegistry {
  private tasks: DesktopTaskReference[] = [];

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<DesktopTaskReference[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Desktop task registry exceeds 256 KiB");
      this.tasks = parseRegistry(JSON.parse(raw) as unknown).tasks;
    } catch (error) {
      if (!isMissing(error)) this.tasks = [];
    }
    return this.snapshot();
  }

  snapshot(): DesktopTaskReference[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  async remember(reference: DesktopTaskReference): Promise<DesktopTaskReference[]> {
    validateReference(reference);
    const next = [
      ...this.tasks.filter((item) => item.taskId !== reference.taskId),
      { ...reference },
    ]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_REFERENCES);
    await this.write(next);
    this.tasks = next;
    return this.snapshot();
  }

  private async write(tasks: DesktopTaskReference[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    const payload: StoredTaskRegistry = { schemaVersion: SCHEMA_VERSION, tasks };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

function parseRegistry(value: unknown): StoredTaskRegistry {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.tasks) || value.tasks.length > MAX_REFERENCES) {
    throw new Error("unsupported Desktop task registry schema");
  }
  const tasks = value.tasks.map((item) => {
    validateReference(item);
    return { ...item };
  });
  return { schemaVersion: SCHEMA_VERSION, tasks };
}

function validateReference(value: unknown): asserts value is DesktopTaskReference {
  if (!isRecord(value)) throw new Error("Desktop task reference is invalid");
  const keys = Object.keys(value);
  if (keys.some((key) => !["taskId", "workspace", "createdAt"].includes(key))) throw new Error("Desktop task reference contains unknown fields");
  if (!isUuid(value.taskId)) throw new Error("Desktop task ID is invalid");
  if (!isWorkspaceId(value.workspace)) throw new Error("Desktop task workspace is invalid");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error("Desktop task timestamp is invalid");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
