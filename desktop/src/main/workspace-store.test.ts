import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ManagedWorkspace } from "./runtime-profile";
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from "./workspace-store";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-workspaces-"));
  temporaryDirectories.push(directory);
  return directory;
}

function workspace(overrides: Partial<ManagedWorkspace> = {}): ManagedWorkspace {
  return {
    id: "api",
    name: "API",
    root: path.resolve(os.tmpdir(), "repo-api"),
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    provider: "github",
    repository: "fogewise/api",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed workspace registry", () => {
  it("returns null when no managed registry exists", async () => {
    const directory = await tempDirectory();
    expect(await loadWorkspaceRegistry(path.join(directory, "workspaces.json"))).toBeNull();
  });

  it("round-trips only validated non-secret workspace metadata", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "workspaces.json");
    const expected = [workspace()];
    await saveWorkspaceRegistry(filePath, expected);

    expect(await loadWorkspaceRegistry(filePath)).toEqual(expected);
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain('"schemaVersion": 1');
    expect(raw).not.toMatch(/token|bearer|secret/i);
  });

  it("rejects duplicate IDs before persisting", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "workspaces.json");
    await expect(
      saveWorkspaceRegistry(filePath, [workspace(), workspace({ root: path.resolve(os.tmpdir(), "repo-two") })]),
    ).rejects.toThrow(/duplicate workspace id/i);
  });

  it("requires provider and repository metadata as a pair", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "workspaces.json");
    const invalid = workspace();
    delete invalid.repository;
    await expect(saveWorkspaceRegistry(filePath, [invalid])).rejects.toThrow(/provider\/repository/i);
  });
});
