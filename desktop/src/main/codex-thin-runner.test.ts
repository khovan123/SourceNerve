import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexNativeConversationMessage, CodexNativeThreadSummary, CodexThreadOptions, CodexTurnResult } from "./codex-app-server-host";
import type { CodexSkillInvocation, CodexSkillsListResponse } from "./codex-protocol";
import type { PluginRuntimeSkill } from "./plugin-manager";
import { CodexRuntimePool, type CodexRuntimeHost } from "./codex-runtime-pool";
import { CodexSkillActivator } from "./codex-skill-activator";
import { CodexSkillCache } from "./codex-skill-cache";
import { CodexThinRunner } from "./codex-thin-runner";
import { CodexThreadStore } from "./codex-thread-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeNativeHost implements CodexRuntimeHost {
  readonly configurations: Array<{ roots: string[]; cwd: string }> = [];
  readonly invocations: CodexSkillInvocation[][] = [];
  readonly prompts: string[] = [];
  private threadId: string | null = null;

  attachedThreadId(): string | null { return this.threadId; }
  async account() { return { account: { type: "chatgpt" as const, email: null, planType: "plus" }, requiresOpenaiAuth: true }; }
  async startThread(_options: CodexThreadOptions) { this.threadId = "thread-thin"; return { thread: { id: this.threadId } }; }
  async resumeThread(threadId: string, _options: CodexThreadOptions) { this.threadId = threadId; return { thread: { id: threadId } }; }
  async configureSkills(roots: readonly string[], cwd: string): Promise<CodexSkillsListResponse> {
    this.configurations.push({ roots: [...roots], cwd });
    const skills = [];
    for (const root of roots) {
      for (const directory of await readdir(root)) {
        const skillPath = path.join(root, directory, "SKILL.md");
        const content = await readFile(skillPath, "utf8");
        const name = frontmatterSkillName(content) ?? directory;
        skills.push({
          name,
          description: `${name} skill`,
          path: skillPath,
          scope: "user" as const,
          enabled: true,
          pluginId: null,
        });
      }
    }
    return { data: [{ cwd, skills, errors: [] }] };
  }
  async listThreads(_cwd: string, _limit = 100): Promise<CodexNativeThreadSummary[]> { return []; }
  async readConversationHistory(_threadId: string): Promise<CodexNativeConversationMessage[]> { return []; }
  async deleteThread(_threadId: string): Promise<void> {}
  async runTurn(prompt: string, skills: readonly CodexSkillInvocation[] = []): Promise<CodexTurnResult> {
    if (!this.threadId) throw new Error("thread not attached");
    this.prompts.push(prompt);
    this.invocations.push([...skills]);
    return {
      threadId: this.threadId,
      turnId: `turn-${this.prompts.length}`,
      status: "completed",
      response: "done",
      recoveredBeforeTurn: false,
    };
  }
  async recover() { return true; }
  async shutdown() {}
}

describe("CodexThinRunner", () => {
  it("activates explicit plugin skills, invokes native Codex, and restores the same activation on the next turn", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const cache = new CodexSkillCache(path.join(directory, "skills", "cache"));
    await cache.initialize();
    await cache.syncPluginSkills([runtimeSkill("review", skillContent("review", "Review the exact diff."))]);
    const activator = new CodexSkillActivator(cache, path.join(directory, "runtime"));
    const host = new FakeNativeHost();
    const pool = new CodexRuntimePool({
      store: new CodexThreadStore(path.join(directory, "managed", "codex-threads.json")),
      hostFactory: () => host,
    });
    const runner = new CodexThinRunner(pool, activator);

    const first = await runner.run({
      runId: "run-1",
      workspaceId: "repo-1",
      cwd,
      prompt: "review first",
      skillKeys: ["plugin-one/review"],
    });
    const second = await runner.run({
      runId: "run-1",
      workspaceId: "repo-1",
      cwd,
      prompt: "review again",
    });

    expect(first.skillActivation?.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(second.skillActivation?.skills[0]?.contentHash).toBe(first.skillActivation?.skills[0]?.contentHash);
    expect(host.configurations).toHaveLength(2);
    expect(host.configurations[0]?.roots).toEqual([first.skillActivation!.root]);
    expect(host.invocations[0]?.[0]).toEqual({
      name: "review",
      path: first.skillActivation!.skills[0]!.path,
    });
    expect(host.prompts).toEqual(["review first", "review again"]);
    await runner.shutdown();
  });

  it("invokes npm-installed skills by the canonical SKILL.md name instead of the hashed SourceNerve id", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    const content = skillContent("azure-diagnostics", "Diagnose Azure services.");
    await cache.initialize();
    await cache.upsertNpmSkills([{
      key: "npm-deadbeef1234/azure-diagnostics-80c1eec95e",
      pluginId: "npm-deadbeef1234",
      skillId: "azure-diagnostics-80c1eec95e",
      name: "azure-diagnostics",
      source: "npm-skills:owner/repo@azure-diagnostics",
      revision: "abcdef1",
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      content,
      workspaceIds: ["repo-1"],
    }]);
    const host = new FakeNativeHost();
    const runner = new CodexThinRunner(
      new CodexRuntimePool({
        store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
        hostFactory: () => host,
      }),
      new CodexSkillActivator(cache, path.join(directory, "runtime")),
    );

    const result = await runner.run({
      runId: "run-npm",
      workspaceId: "repo-1",
      cwd,
      prompt: "hi",
      skillKeys: ["npm-deadbeef1234/azure-diagnostics-80c1eec95e"],
    });

    expect(result.response).toBe("done");
    expect(result.skillActivation?.skills[0]?.name).toBe("azure-diagnostics");
    expect(host.invocations[0]?.[0]?.name).toBe("azure-diagnostics");
    await runner.shutdown();
  });

  it("treats an explicit empty skill set as clearing the run activation", async () => {
    const directory = await tempDirectory();
    const cwd = path.join(directory, "repo");
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    await cache.initialize();
    await cache.syncPluginSkills([runtimeSkill("review", skillContent("review", "Review."))]);
    const host = new FakeNativeHost();
    const runner = new CodexThinRunner(
      new CodexRuntimePool({
        store: new CodexThreadStore(path.join(directory, "codex-threads.json")),
        hostFactory: () => host,
      }),
      new CodexSkillActivator(cache, path.join(directory, "runtime")),
    );

    await runner.run({ runId: "run-clear", workspaceId: "repo-1", cwd, prompt: "with skill", skillKeys: ["plugin-one/review"] });
    const cleared = await runner.run({ runId: "run-clear", workspaceId: "repo-1", cwd, prompt: "without skill", skillKeys: [] });

    expect(cleared.skillActivation?.skills).toEqual([]);
    expect(host.configurations.at(-1)?.roots).toEqual([]);
    expect(host.invocations.at(-1)).toEqual([]);
    await runner.shutdown();
  });
});

function runtimeSkill(skillId: string, content: string): PluginRuntimeSkill {
  return {
    pluginId: "plugin-one",
    pluginName: "Plugin One",
    pluginVersion: "1.0.0",
    skillId,
    skillName: skillId,
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
  };
}


function frontmatterSkillName(content: string): string | null {
  const match = /^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+?)["']?\s*$[\s\S]*?^---\s*$/m.exec(content);
  return match?.[1]?.trim() || null;
}

function skillContent(name: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: test skill\n---\n\n${instructions}\n`;
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-thin-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}
