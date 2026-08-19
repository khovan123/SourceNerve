import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveStateDirectoryFromManagedDirectory,
  stateLocationPathFromManagedDirectory,
  writeStateLocationFile,
} from "./state-location";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Desktop managed state location", () => {
  it("uses the Desktop default when no imported state location exists", async () => {
    const root = await tempDirectory();
    const managed = path.join(root, "managed");
    const fallback = path.join(root, "state");
    expect(await resolveStateDirectoryFromManagedDirectory(managed, fallback)).toBe(fallback);
  });

  it("persists and restores an absolute referenced state directory", async () => {
    const root = await tempDirectory();
    const managed = path.join(root, "managed");
    const statePath = path.join(root, "legacy-state");
    const filePath = stateLocationPathFromManagedDirectory(managed);
    await writeStateLocationFile(filePath, {
      strategy: "reference",
      path: statePath,
      sourcePath: statePath,
    });
    expect(await resolveStateDirectoryFromManagedDirectory(managed, path.join(root, "state"))).toBe(statePath);
    const stored = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({
      schemaVersion: 1,
      strategy: "reference",
      path: statePath,
      sourcePath: statePath,
    });
  });

  it("fails closed on unsupported or relative state-location records", async () => {
    const root = await tempDirectory();
    const managed = path.join(root, "managed");
    const filePath = stateLocationPathFromManagedDirectory(managed);
    await mkdir(managed, { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, strategy: "reference", path: "../state" }),
      "utf8",
    );
    await expect(
      resolveStateDirectoryFromManagedDirectory(managed, path.join(root, "state")),
    ).rejects.toThrow(/unsupported Desktop state-location registry schema/);
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-state-location-"));
  temporaryDirectories.push(directory);
  return directory;
}
