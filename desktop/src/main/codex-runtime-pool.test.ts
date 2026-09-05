import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexAppServerHostOptions, CodexThreadOptions, CodexTurnResult } from "./codex-app-server-host";
import type { CodexSkillInvocation, CodexSkillsListResponse } from "./codex-protocol";
import type { CodexRuntimeHost } from "./codex-runtime-pool";
import { CodexRuntimePool } from "./codex-runtime-pool";
import { CodexThreadStore } from "./codex-thread-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeRuntimeHost implements CodexRuntimeHost {
  readonly starts: CodexThreadOptions[] = [];
  readonly resumes: Array<{ threadId: string; options: CodexThreadOptions }> = [];
  readonly prompts: string[] = [];
  readonly skillConfigurations: Array<{ roots: readonly string[]; cwd: string }> = [];
  readonly skillInvocations: CodexSkillInvocation[][] = [];
  shutdownCount = 0;
  catalog: CodexSkillsListResponse = { data: [] };
  turnError: Error | null = null;
  private threadId: string | null = null;

  constructor(private readonly allocatedThreadId: string) {}

  attachedThreadId(): string | null { return this.threadId; }
  async account() { return { account: { type: "chatgpt" as const, email: null, planType: "plus" }, requiresOpenaiAuth: true }; }
  async startThread(options: CodexThreadOptions) {
    this.starts.push(options);
    this.threadId = this.allocatedThreadId;
    return { thread: { id: this.threadId } };
  }
  async resumeThread(threadId: string, options: CodexThreadOptions) {
    this.resumes.push({ threadId, options });
    this.threadId = threadId;
    return { thread: { id: threadId } };
  }
  async configureSkills(roots: readonly string[], cwd: string): Promise<CodexSkillsListResponse> {
    this.skillConfigurations.push({ roots: [...roots], cwd });
    return this.catalog.data.length > 0 ? this.catalog : { data: [{ cwd, skills: [], errors: [] }] };
  }
  async runTurn(prompt: string, skills: readonly CodexSkillInvocation[] = []): Promise<CodexTurnResult> {
    if (!this.threadId) throw new Error("thread not attached");
    this.prompts.push(prompt);
    this.skillInvocations.push([...skills]);
    if (this.turnError) {
      const error = this.turnError;
      this.turnError = null;
      throw error;
    }
    return {
      threadId: this.threadId,
      turnId: `turn-${this.prompts.length}`,
      status: "completed",
      response: `reply:${prompt}`,
      recoveredBeforeTurn: false,
    };
  }
  async recover(): Promise<boolean> { return true; }
  async shutdown(): Promise<void> { this.shutdownCount += 1; }
}

describe("CodexRuntimePool", () => {
  it("persists a completed native thread and resumes that exact thread after Desktop restart", async () => {
    const directory = await tempDirectory();
    const registry = path.join(directory, "managed", "codex-threads.json");
    const cwd = path.join(directory, "repo");
    const firstHost = new FakeRuntimeHost("thread-persisted");
    const firstPool = new CodexRuntimePool({
      store: new CodexThreadStore(registry),
      hostFactory: () => firstHost,
    });
    await firstPool.initialize();

    const first = await firstPool.runTurn({ runId: "run-1", workspaceId: "repo-1", cwd, prompt: "first" });
    expect(first.resumed).toBe(false);
    expect(first.binding.threadId).toBe("thread-persisted");
    expect(firstHost.starts).toHaveLength(1);
    await firstPool.shutdown();

    const secondHost = new FakeRuntimeHost("unused-new-thread");
    const secondPool = new CodexRuntimePool({
      store: new CodexThreadStore(registry),
      hostFactory: () => secondHost,
    });
    await secondPool.initialize();
    const second = await secondPool.runTurn({ runId: "run-1", workspaceId: "repo-1", cwd, prompt: "continue" });

    expect(second.resumed).toBe(true);
    expect(second.binding.threadId).toBe("thread-persisted");
    expect(secondHost.starts).toHaveLength(0);
    expect(secondHost.resumes).toEqual([{ threadId: "thread-persisted", options: { cwd: path.resolve(cwd) } }]);
    expect(secondHost.prompts).toEqual(["continue"]);
    await secondPool.shutdown();
  });

  it("persists the native thread before the first turn completes so restart recovery keeps continuity", async () => {
    const directory = await tempDirectory();
    const registry = path.join(directory, "managed", "codex-threads.json");
    const cwd = path.join(directory, "repo");
    const firstHost = new FakeRuntimeHost("thread-before-failure");
    firstHost.turnError = new Error("turn interrupted");
    const firstPool = new CodexRuntimePool({
      store: new CodexThreadStore(registry),
      hostFactory: () => firstHost,
    });
    await firstPool.initialize();

    await expect(firstPool.runTurn({ runId: "run-early", workspaceId: "repo-1", cwd, prompt: "first" })).rejects.toThrow("turn interrupted");
    expect(firstPool.binding("run-early")?.threadId).toBe("thread-before-failure");
    await firstPool.shutdown();

    const secondHost = new FakeRuntimeHost("unused-new-thread");
    const secondPool = new CodexRuntimePool({
      store: new CodexThreadStore(registry),
      hostFactory: () => secondHost,
    });
    await secondPool.initialize();
    const resumed = await secondPool.runTurn({ runId: "run-early", workspaceId: "repo-1", cwd, prompt: "continue" });

    expect(resumed.resumed).toBe(true);
    expect(resumed.binding.threadId).toBe("thread-before-failure");
    expect(secondHost.resumes).toEqual([{ threadId: "thread-before-failure", options: { cwd: path.resolve(cwd) } }]);
    await secondPool.shutdown();
  });

  it("bounds warm app-server processes and evicts the least-recently-used idle runtime", async () => {
    const directory = await tempDirectory();
    const hosts: FakeRuntimeHost[] = [];
    const pool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
      maxRuntimes: 1,
      hostFactory: () => {
        const host = new FakeRuntimeHost(`thread-${hosts.length + 1}`);
        hosts.push(host);
        return host;
      },
    });
    await pool.initialize();

    await pool.runTurn({ runId: "run-1", workspaceId: "repo-1", cwd: path.join(directory, "one"), prompt: "one" });
    await pool.runTurn({ runId: "run-2", workspaceId: "repo-2", cwd: path.join(directory, "two"), prompt: "two" });

    expect(hosts).toHaveLength(2);
    expect(hosts[0].shutdownCount).toBe(1);
    expect(hosts[1].shutdownCount).toBe(0);
    await pool.shutdown();
    expect(hosts[1].shutdownCount).toBe(1);
  });

  it("preflights projected skills and passes only exact native invocations to Codex", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const skillRoot = path.join(directory, "runtime", "skills");
    const skillPath = path.join(skillRoot, "plugin--review", "SKILL.md");
    const host = new FakeRuntimeHost("thread-skills");
    host.catalog = {
      data: [{
        cwd,
        errors: [],
        skills: [{ name: "review", description: "review code", path: skillPath, scope: "user", enabled: true, pluginId: null }],
      }],
    };
    const pool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
      hostFactory: () => host,
    });
    await pool.initialize();

    await pool.runTurn({
      runId: "run-skills",
      workspaceId: "repo-1",
      cwd,
      prompt: "review this diff",
      skillRoots: [skillRoot],
      skills: [{ name: "review", path: skillPath }],
    });

    expect(host.skillConfigurations).toEqual([{ roots: [skillRoot], cwd }]);
    expect(host.skillInvocations).toEqual([[{ name: "review", path: skillPath }]]);
    await pool.shutdown();
  });

  it("binds app-server request handling to the exact Harness run, workspace and cwd", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const host = new FakeRuntimeHost("thread-governed");
    let hostOptions: CodexAppServerHostOptions | undefined;
    const handlerCalls: unknown[] = [];
    const pool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
      serverRequestHandler: async (context, request) => {
        handlerCalls.push({ context, request });
        return { decision: "decline" };
      },
      hostFactory: (options) => {
        hostOptions = options;
        return host;
      },
    });
    await pool.initialize();
    await pool.runTurn({ runId: "run-governed", workspaceId: "repo-governed", cwd, prompt: "inspect" });

    await expect(hostOptions?.onServerRequest?.({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: { command: "git commit -m guarded" },
    })).resolves.toEqual({ decision: "decline" });
    expect(handlerCalls).toEqual([{
      context: { runId: "run-governed", workspaceId: "repo-governed", cwd: path.resolve(cwd) },
      request: { id: 7, method: "item/commandExecution/requestApproval", params: { command: "git commit -m guarded" } },
    }]);
    await pool.shutdown();
  });

  it("fails closed when the requested exact skill is missing from the forced catalog", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const skillRoot = path.join(directory, "runtime", "skills");
    const host = new FakeRuntimeHost("thread-missing-skill");
    const pool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
      hostFactory: () => host,
    });
    await pool.initialize();

    await expect(pool.runTurn({
      runId: "run-skills",
      workspaceId: "repo-1",
      cwd,
      prompt: "review this diff",
      skillRoots: [skillRoot],
      skills: [{ name: "review", path: path.join(skillRoot, "review", "SKILL.md") }],
    })).rejects.toThrow("did not discover requested skill review");

    expect(host.prompts).toEqual([]);
    await pool.shutdown();
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-pool-"));
  temporaryDirectories.push(directory);
  return directory;
}
