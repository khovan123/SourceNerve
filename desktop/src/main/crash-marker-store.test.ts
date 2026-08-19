import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CrashMarkerStore } from "./crash-marker-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CrashMarkerStore", () => {
  it("reports a prior running marker as an unexpected Desktop exit", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "last-exit.json");
    const first = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:00:00Z"));
    await first.initialize();

    const second = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:01:00Z"));
    const snapshot = await second.initialize();
    expect(snapshot.previousMainExit).toEqual({
      clean: false,
      startedAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("persists clean quit and sanitized daemon exit summaries", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "last-exit.json");
    const first = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:00:00Z"));
    await first.initialize();
    await first.recordDaemonSnapshot({
      state: "crashed",
      managed: true,
      exitCode: 7,
      message: `Bearer secret-secret-secret-secret ${directory}/state`,
    });
    await first.markClean();

    const second = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:02:00Z"));
    const snapshot = await second.initialize();
    expect(snapshot.previousMainExit?.clean).toBe(true);
    expect(snapshot.lastDaemonExit?.exitCode).toBe(7);
    expect(snapshot.lastDaemonExit?.message).toContain("Bearer [REDACTED]");
    expect(snapshot.lastDaemonExit?.message).toContain("[HOME]");
    expect(snapshot.lastDaemonExit?.message).not.toContain("secret-secret-secret-secret");
    expect(snapshot.lastDaemonExit?.message).not.toContain(directory);
  });

  it("keeps a graceful quit clean when the daemon stopped marker is still flushing", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "last-exit.json");
    const first = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:00:00Z"));
    await first.initialize();

    const daemonWrite = first.recordDaemonSnapshot({
      state: "stopped",
      managed: true,
      exitCode: 0,
      message: "managed daemon stopped",
    });
    await first.markClean();
    await daemonWrite;

    const second = new CrashMarkerStore(filePath, directory, () => new Date("2026-08-20T00:03:00Z"));
    const snapshot = await second.initialize();
    expect(snapshot.previousMainExit?.clean).toBe(true);
    expect(snapshot.lastDaemonExit?.state).toBe("stopped");
    expect(snapshot.lastDaemonExit?.exitCode).toBe(0);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-crash-marker-"));
  temporaryDirectories.push(directory);
  return directory;
}
