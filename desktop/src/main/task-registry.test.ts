import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopTaskRegistry } from "./task-registry";

const temporaryDirectories: string[] = [];
const TASK_ID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DesktopTaskRegistry", () => {
  it("persists only bounded task references and restores them after restart", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "desktop-tasks.json");
    const first = new DesktopTaskRegistry(filePath);
    await first.initialize();
    await first.remember({ taskId: TASK_ID, workspace: "api", createdAt: "2026-08-20T00:00:00.000Z" });

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain(TASK_ID);
    expect(raw).not.toContain("patch");
    expect(raw).not.toContain("diff");
    expect(raw).not.toContain("token");

    const second = new DesktopTaskRegistry(filePath);
    await expect(second.initialize()).resolves.toEqual([
      { taskId: TASK_ID, workspace: "api", createdAt: "2026-08-20T00:00:00.000Z" },
    ]);
  });

  it("deduplicates a remembered task and keeps the latest reference", async () => {
    const directory = await tempDirectory();
    const registry = new DesktopTaskRegistry(path.join(directory, "managed", "desktop-tasks.json"));
    await registry.initialize();
    await registry.remember({ taskId: TASK_ID, workspace: "api", createdAt: "2026-08-20T00:00:00.000Z" });
    const result = await registry.remember({ taskId: TASK_ID, workspace: "api", createdAt: "2026-08-20T01:00:00.000Z" });
    expect(result).toHaveLength(1);
    expect(result[0]?.createdAt).toBe("2026-08-20T01:00:00.000Z");
  });

  it("falls back to an empty non-authoritative registry when the file is corrupt", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "desktop-tasks.json");
    await writeFile(filePath, "{not-json", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "{not-json", "utf8");
    });
    const registry = new DesktopTaskRegistry(filePath);
    await expect(registry.initialize()).resolves.toEqual([]);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-task-registry-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
