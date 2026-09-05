import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PluginRuntimeSkill } from "./plugin-manager";
import { CodexSkillCache, codexSkillKey } from "./codex-skill-cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexSkillCache", () => {
  it("stores verified plugin skill bytes under their exact content hash", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "skills", "cache"));
    const skill = runtimeSkill("review", "1.2.3", skillContent("review", "Review exact code changes."), ["repo-1"]);
    await cache.initialize();
    await cache.syncPluginSkills([skill]);

    const cached = cache.resolve(codexSkillKey("plugin-one", "review"), "repo-1");
    expect(cached).toMatchObject({
      key: "plugin-one/review",
      pluginId: "plugin-one",
      skillId: "review",
      revision: "1.2.3",
      contentHash: skill.contentHash,
      security: "verified-plugin",
      uses: 0,
    });
    const content = await readFile(cache.contentPath(cache.pin(cached)), "utf8");
    expect(content).toBe(skill.content);
  });

  it("rejects plugin runtime materialization when declared and actual skill hashes differ", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    const skill = runtimeSkill("review", "1.0.0", skillContent("review", "Review code."));
    await cache.initialize();

    await expect(cache.syncPluginSkills([{ ...skill, contentHash: "0".repeat(64) }])).rejects.toThrow("content integrity validation");
    expect(cache.list()).toEqual([]);
  });

  it("enforces Plugin Hub workspace scoping before a skill can be pinned", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    const skill = runtimeSkill("review", "1.0.0", skillContent("review", "Review code."), ["repo-allowed"]);
    await cache.initialize();
    await cache.syncPluginSkills([skill]);

    expect(() => cache.resolve("plugin-one/review", "repo-denied")).toThrow("is not enabled for workspace repo-denied");
    expect(cache.resolve("plugin-one/review", "repo-allowed").skillId).toBe("review");
  });
});

function runtimeSkill(skillId: string, version: string, content: string, workspaceIds?: string[]): PluginRuntimeSkill {
  return {
    pluginId: "plugin-one",
    pluginName: "Plugin One",
    pluginVersion: version,
    skillId,
    skillName: skillId,
    contentHash: sha256(content),
    content,
    ...(workspaceIds ? { workspaceIds } : {}),
  };
}

function skillContent(name: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: test skill\n---\n\n${instructions}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}
