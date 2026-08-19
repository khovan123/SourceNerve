import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DaemonSnapshot } from "../shared/desktop-api";
import { sanitizeRuntimeText } from "./runtime-log-store";

const SCHEMA_VERSION = 1 as const;

interface StoredExitMarker {
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  startedAt: string;
  status: "running" | "clean";
  endedAt?: string;
  lastDaemonExit?: DaemonExitSummary;
}

export interface MainExitSummary {
  clean: boolean;
  startedAt: string;
  endedAt?: string;
}

export interface DaemonExitSummary {
  timestamp: string;
  state: "crashed" | "stopped";
  exitCode?: number | null;
  signal?: string;
  message?: string;
}

export interface CrashMarkerSnapshot {
  previousMainExit?: MainExitSummary;
  lastDaemonExit?: DaemonExitSummary;
}

export class CrashMarkerStore {
  private readonly sessionId = randomUUID();
  private readonly startedAt: string;
  private readonly now: () => Date;
  private previousMainExit?: MainExitSummary;
  private lastDaemonExit?: DaemonExitSummary;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly homeDirectory?: string,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
    this.startedAt = this.now().toISOString();
  }

  async initialize(): Promise<CrashMarkerSnapshot> {
    const previous = await readMarker(this.filePath);
    if (previous) {
      this.previousMainExit = {
        clean: previous.status === "clean",
        startedAt: previous.startedAt,
        ...(previous.endedAt ? { endedAt: previous.endedAt } : {}),
      };
      this.lastDaemonExit = previous.lastDaemonExit;
    }
    await this.enqueueWrite("running");
    return this.snapshot();
  }

  snapshot(): CrashMarkerSnapshot {
    return {
      ...(this.previousMainExit ? { previousMainExit: { ...this.previousMainExit } } : {}),
      ...(this.lastDaemonExit ? { lastDaemonExit: { ...this.lastDaemonExit } } : {}),
    };
  }

  async recordDaemonSnapshot(snapshot: DaemonSnapshot): Promise<void> {
    if (snapshot.state !== "crashed" && snapshot.state !== "stopped") return;
    this.lastDaemonExit = {
      timestamp: this.now().toISOString(),
      state: snapshot.state,
      ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
      ...(snapshot.signal ? { signal: sanitizeRuntimeText(snapshot.signal, this.homeDirectory) } : {}),
      ...(snapshot.message ? { message: sanitizeRuntimeText(snapshot.message, this.homeDirectory) } : {}),
    };
    await this.enqueueWrite("running");
  }

  async markClean(): Promise<void> {
    await this.enqueueWrite("clean", this.now().toISOString());
  }

  private enqueueWrite(status: StoredExitMarker["status"], endedAt?: string): Promise<void> {
    const payload: StoredExitMarker = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      status,
      ...(endedAt ? { endedAt } : {}),
      ...(this.lastDaemonExit ? { lastDaemonExit: { ...this.lastDaemonExit } } : {}),
    };
    const write = this.writeQueue.then(() => writeMarker(this.filePath, payload));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }
}

async function writeMarker(filePath: string, payload: StoredExitMarker): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

async function readMarker(filePath: string): Promise<StoredExitMarker | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Desktop exit marker exceeds 64 KiB");
    const value = JSON.parse(raw) as Partial<StoredExitMarker>;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.sessionId !== "string" ||
      value.sessionId.length > 128 ||
      typeof value.startedAt !== "string" ||
      (value.status !== "running" && value.status !== "clean") ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      (value.endedAt !== undefined && !Number.isFinite(Date.parse(value.endedAt))) ||
      (value.lastDaemonExit !== undefined && !isDaemonExitSummary(value.lastDaemonExit))
    ) {
      throw new Error("unsupported Desktop exit marker schema");
    }
    return value as StoredExitMarker;
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

function isDaemonExitSummary(value: unknown): value is DaemonExitSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<DaemonExitSummary>;
  return (
    typeof summary.timestamp === "string" &&
    Number.isFinite(Date.parse(summary.timestamp)) &&
    (summary.state === "crashed" || summary.state === "stopped") &&
    (summary.exitCode === undefined || summary.exitCode === null || Number.isSafeInteger(summary.exitCode)) &&
    (summary.signal === undefined || (typeof summary.signal === "string" && summary.signal.length <= 512)) &&
    (summary.message === undefined || (typeof summary.message === "string" && summary.message.length <= 4096))
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
