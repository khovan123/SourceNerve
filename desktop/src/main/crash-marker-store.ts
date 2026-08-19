import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  private previousMainExit?: MainExitSummary;
  private lastDaemonExit?: DaemonExitSummary;

  constructor(
    private readonly filePath: string,
    private readonly homeDirectory?: string,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
    this.startedAt = this.now().toISOString();
  }

  private readonly now: () => Date;

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
    await this.write("running");
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
    await this.write("running");
  }

  async markClean(): Promise<void> {
    await this.write("clean", this.now().toISOString());
  }

  private async write(status: StoredExitMarker["status"], endedAt?: string): Promise<void> {
    const payload: StoredExitMarker = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      status,
      ...(endedAt ? { endedAt } : {}),
      ...(this.lastDaemonExit ? { lastDaemonExit: this.lastDaemonExit } : {}),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

async function readMarker(filePath: string): Promise<StoredExitMarker | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Desktop exit marker exceeds 64 KiB");
    const value = JSON.parse(raw) as Partial<StoredExitMarker>;
    if (
      value.schemaVersion !== SCHEMA_VERSION ||
      typeof value.sessionId !== "string" ||
      typeof value.startedAt !== "string" ||
      (value.status !== "running" && value.status !== "clean") ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      (value.endedAt !== undefined && !Number.isFinite(Date.parse(value.endedAt)))
    ) {
      throw new Error("unsupported Desktop exit marker schema");
    }
    return value as StoredExitMarker;
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
