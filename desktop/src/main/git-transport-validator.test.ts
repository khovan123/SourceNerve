import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import { validateWorkspaceGitTransport } from "./git-transport-validator";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Git transport validator", () => {
  it("uses a write-capable dry-run without creating a remote ref", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-git-transport-"));
    temporaryDirectories.push(directory);
    const repository = path.join(directory, "repo");
    const remote = path.join(directory, "remote.git");

    await git(directory, ["init", "--bare", remote]);
    await git(directory, ["init", "-b", "main", repository]);
    await git(repository, ["config", "user.email", "desktop-test@example.invalid"]);
    await git(repository, ["config", "user.name", "SourceNerve Desktop Test"]);
    await writeFile(path.join(repository, "README.md"), "# transport test\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "initial"]);
    await git(repository, ["remote", "add", "origin", remote]);

    const workspace = managedWorkspace(repository);
    const result = await validateWorkspaceGitTransport(
      { listManagedWorkspaces: async () => [workspace] } as never,
      workspace.id,
    );

    expect(result).toMatchObject({
      workspace: "demo",
      ready: true,
      transport: "other",
    });
    expect(result.message).toMatch(/dry-run only/i);

    const refs = await gitBare(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
    expect(refs.trim()).toBe("");
  });
});

function managedWorkspace(root: string): ManagedWorkspaceView {
  return {
    id: "demo",
    name: "Demo",
    root,
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    validation: { state: "ready" },
    head: "0".repeat(40),
    dirty: false,
    localWritable: true,
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function gitBare(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
