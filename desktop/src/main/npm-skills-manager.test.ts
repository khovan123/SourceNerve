import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import { CodexSkillCache } from "./codex-skill-cache";
import {
  NpmSkillsManager,
  buildNpmSkillSearchQueries,
  parseNpmSkillsFindOutput,
} from "./npm-skills-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("NpmSkillsManager", () => {
  it("searches with the npm skills CLI before installing and importing a relevant Codex skill", async () => {
    const root = await tempDirectory();
    const workspaceRoot = path.join(root, "workspace");
    const managedRoot = path.join(root, "managed", "npm-skills");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }), "utf8");
    const cache = new CodexSkillCache(path.join(root, "managed", "cache"));
    const calls: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push([...args]);
      if (args.includes("find")) {
        return {
          exitCode: 0,
          stdout: "\u001b[38;5;145mvercel-labs/agent-skills@vercel-react-best-practices\u001b[0m \u001b[36m692.1K installs\u001b[0m\n",
          stderr: "",
        };
      }
      if (args.includes("add")) {
        const home = options.env.HOME!;
        const skillRoot = path.join(home, ".agents", "skills", "vercel-react-best-practices");
        await mkdir(skillRoot, { recursive: true });
        const content = "---\nname: vercel-react-best-practices\ndescription: React guidance\n---\n\nUse React best practices.\n";
        await writeFile(path.join(skillRoot, "SKILL.md"), content, "utf8");
        await mkdir(path.join(home, ".agents"), { recursive: true });
        await writeFile(path.join(home, ".agents", ".skill-lock.json"), JSON.stringify({
          version: 3,
          skills: {
            "vercel-react-best-practices": {
              source: "vercel-labs/agent-skills",
              skillFolderHash: "a".repeat(40),
              updatedAt: "2026-09-06T00:00:00.000Z",
            },
          },
        }), "utf8");
        return { exitCode: 0, stdout: "installed", stderr: "" };
      }
      throw new Error(`unexpected npm skills command ${args.join(" ")}`);
    });
    const manager = new NpmSkillsManager({
      root: managedRoot,
      cache,
      workspaces: { listManagedWorkspaces: async () => [workspace("repo", workspaceRoot)] },
      resolveNpx: () => "/usr/bin/npx",
      runCommand,
    });

    const first = await manager.prepareWorkspaceSkills("repo", "Redesign this React component");
    expect(first.searches).toEqual(["react"]);
    expect(first.installed).toEqual(["vercel-labs/agent-skills@vercel-react-best-practices"]);
    expect(first.activeSkillKeys).toHaveLength(1);
    expect(calls[0]).toEqual(["--yes", "skills@latest", "find", "react"]);
    expect(calls[1]).toEqual(expect.arrayContaining(["skills@latest", "add", "vercel-labs/agent-skills", "--skill", "vercel-react-best-practices", "--agent", "codex", "--global", "--copy"]));
    expect(cache.resolve(first.activeSkillKeys[0], "repo")).toMatchObject({
      security: "npm-skills-cli",
      source: "npm-skills:vercel-labs/agent-skills@vercel-react-best-practices",
      workspaceIds: ["repo"],
    });

    const second = await manager.prepareWorkspaceSkills("repo", "Update the React view again");
    expect(second.activeSkillKeys).toEqual(first.activeSkillKeys);
    expect(runCommand.mock.calls.filter(([, args]) => (args as readonly string[]).includes("find"))).toHaveLength(2);
    expect(runCommand.mock.calls.filter(([, args]) => (args as readonly string[]).includes("add"))).toHaveLength(1);
  });

  it("keeps mandatory discovery but does not activate workspace-only infrastructure skills for a greeting", async () => {
    const root = await tempDirectory();
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ dependencies: { "@azure/identity": "4.0.0", react: "19.0.0" } }), "utf8");
    await writeFile(path.join(workspaceRoot, "Dockerfile"), "FROM node:22\n", "utf8");
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("find")) {
        return {
          exitCode: 0,
          stdout: "vendor/skills@azure-diagnostics 80K installs\nvendor/skills@multi-stage-dockerfile 70K installs\n",
          stderr: "",
        };
      }
      throw new Error(`greeting must not install a skill: ${args.join(" ")}`);
    });
    const manager = new NpmSkillsManager({
      root: path.join(root, "managed"),
      cache: new CodexSkillCache(path.join(root, "cache")),
      workspaces: { listManagedWorkspaces: async () => [workspace("lcsp", workspaceRoot)] },
      resolveNpx: () => "/usr/bin/npx",
      runCommand,
    });

    const result = await manager.prepareWorkspaceSkills("lcsp", "hi");
    expect(result.searches).toEqual(["coding"]);
    expect(result.candidates).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.activeSkillKeys).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/npx",
      ["--yes", "skills@latest", "find", "coding"],
      expect.any(Object),
    );
  });

  it("blocks the turn when the mandatory npm skills search cannot run", async () => {
    const root = await tempDirectory();
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const manager = new NpmSkillsManager({
      root: path.join(root, "managed"),
      cache: new CodexSkillCache(path.join(root, "cache")),
      workspaces: { listManagedWorkspaces: async () => [workspace("repo", workspaceRoot)] },
      resolveNpx: () => "/usr/bin/npx",
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "network unavailable" }),
    });

    await expect(manager.prepareWorkspaceSkills("repo", "fix the UI"))
      .rejects.toThrow("npm Skills CLI search failed");
  });

  it("waits for mandatory npm skills discovery instead of timing out or falling back", async () => {
    const root = await tempDirectory();
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    let resolveSearch!: (result: { exitCode: number; stdout: string; stderr: string }) => void;
    const pendingSearch = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      resolveSearch = resolve;
    });
    const runCommand = vi.fn(async () => pendingSearch);
    const manager = new NpmSkillsManager({
      root: path.join(root, "managed"),
      cache: new CodexSkillCache(path.join(root, "cache")),
      workspaces: { listManagedWorkspaces: async () => [workspace("repo", workspaceRoot)] },
      resolveNpx: () => "/usr/bin/npx",
      runCommand,
    });

    let settled = false;
    const preflight = manager.prepareWorkspaceSkills("repo", "hi").finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/npx",
      ["--yes", "skills@latest", "find", "coding"],
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );

    resolveSearch({ exitCode: 0, stdout: "", stderr: "" });
    await expect(preflight).resolves.toMatchObject({
      activeSkillKeys: [],
      installed: [],
      searches: ["coding"],
    });
  });


  it("routes code-review prompts away from loose reasoning/statusline npm skills", async () => {
    const root = await tempDirectory();
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }), "utf8");
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("find")) {
        return {
          exitCode: 0,
          stdout: "webup/skills-cc@webup-statusline 12K installs\nsammcj/agentic-coding@critical-thinking-logical-reasoning 10K installs\n",
          stderr: "",
        };
      }
      throw new Error(`code review prompt must not install unrelated skill: ${args.join(" ")}`);
    });
    const manager = new NpmSkillsManager({
      root: path.join(root, "managed"),
      cache: new CodexSkillCache(path.join(root, "cache")),
      workspaces: { listManagedWorkspaces: async () => [workspace("lcsp", workspaceRoot)] },
      resolveNpx: () => "/usr/bin/npx",
      runCommand,
    });

    const result = await manager.prepareWorkspaceSkills("lcsp", "review lại effort reasoning sau khi update trên branch này");

    expect(result.searches).toEqual(["code-review", "repository"]);
    expect(result.candidates).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.activeSkillKeys).toEqual([]);
    expect(runCommand.mock.calls.map(([, args]) => (args as readonly string[]).at(-1))).toEqual(["code-review", "repository"]);
  });

  it("parses ranked npx skills find output and builds bounded search queries", () => {
    const parsed = parseNpmSkillsFindOutput(
      "\u001b[38;5;145mvercel-labs/agent-skills@vercel-react-best-practices\u001b[0m \u001b[36m692.1K installs\u001b[0m\n"
        + "google-labs-code/stitch-skills@react:components 50.7K installs\n",
      "react",
    );
    expect(parsed).toEqual([{
      source: "vercel-labs/agent-skills",
      skill: "vercel-react-best-practices",
      installs: 692_100,
      query: "react",
    }]);
    expect(buildNpmSkillSearchQueries("Fix React with Playwright", ["playwright", "react", "typescript"], ["electron"])).toEqual(["playwright", "react"]);
    expect(buildNpmSkillSearchQueries("Fix slash keyboard navigation", [], ["electron", "typescript"])).toEqual(["slash", "keyboard"]);
    expect(buildNpmSkillSearchQueries("review lại effort reasoning sau khi update trên branch này", [], ["electron", "typescript"])).toEqual(["code-review", "repository"]);
    expect(buildNpmSkillSearchQueries("hi", [], ["azure", "docker", "react"])).toEqual(["coding"]);
    expect(buildNpmSkillSearchQueries("Fix UI", [], ["azure", "docker", "react", "prisma"])).toEqual(["react", "prisma"]);
  });
});

function workspace(id: string, root: string): ManagedWorkspaceView {
  return {
    id,
    name: id,
    root,
    access: "read-write",
    remote: "origin",
    defaultBranch: "main",
    validation: { state: "ready" },
    head: "0".repeat(40),
    branch: "main",
    dirty: false,
    localWritable: true,
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-npm-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
