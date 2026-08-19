import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkspaceManagerError,
  inspectRepository,
  providerFromRemoteUrl,
  suggestWorkspaceId,
} from "./workspace-manager";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-repo-"));
  temporaryDirectories.push(root);
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "SourceNerve Test"]);
  await execFileAsync(process.execPath, ["-e", "require('fs').writeFileSync('README.md', '# demo\\n')"], {
    cwd: root,
  });
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", "git@github.com:Fogewise-Tech/demo.git"]);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Desktop workspace repository inspection", () => {
  it("derives provider metadata without exposing remote credentials", () => {
    expect(providerFromRemoteUrl("git@github.com:Fogewise-Tech/demo.git")).toEqual({
      provider: "github",
      repository: "Fogewise-Tech/demo",
    });
    expect(providerFromRemoteUrl("https://oauth2:secret@gitlab.com/group/sub/repo.git")).toEqual({
      provider: "gitlab",
      repository: "group/sub/repo",
    });
    expect(providerFromRemoteUrl("ssh://git@internal.example/team/repo.git")).toEqual({});
  });

  it("validates the exact repository root, HEAD, remote, branch and writable state", async () => {
    const root = await createRepository();
    const inspection = await inspectRepository(root);
    expect(inspection).toMatchObject({
      root,
      defaultRemote: "origin",
      defaultBranch: "main",
      provider: "github",
      repository: "Fogewise-Tech/demo",
      branch: "main",
      dirty: false,
      localWritable: true,
    });
    expect(inspection.head).toMatch(/^[0-9a-f]{40}$/i);
    expect(inspection.remotes).toEqual(["origin"]);
  });

  it("rejects a subdirectory even when Git can resolve its parent repository", async () => {
    const root = await createRepository();
    const nested = path.join(root, "src");
    await mkdir(nested);
    await expect(inspectRepository(nested)).rejects.toMatchObject({
      name: "WorkspaceManagerError",
    } satisfies Partial<WorkspaceManagerError>);
    await expect(inspectRepository(nested)).rejects.toThrow(/repository root/i);
  });

  it("rejects a configured branch that does not exist", async () => {
    const root = await createRepository();
    await expect(inspectRepository(root, "origin", "missing-branch")).rejects.toThrow(/does not exist/i);
  });

  it("creates bounded stable workspace ID suggestions", () => {
    expect(suggestWorkspaceId(" My Service API ")).toBe("my-service-api");
    expect(suggestWorkspaceId("***")).toBe("workspace");
    expect(suggestWorkspaceId("x".repeat(200))).toHaveLength(128);
  });
});
