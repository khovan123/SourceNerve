import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PluginRuntimeSkill } from "./plugin-manager";
import { CodexSkillActivator } from "./codex-skill-activator";
import { CodexSkillCache } from "./codex-skill-cache";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CodexSkillActivator", () => {
  it("materializes at most two exact skills into a run-scoped ephemeral root", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    await cache.initialize();
    await cache.syncPluginSkills([
      runtimeSkill("review", "1.0.0", skillContent("review", "Review code.")),
      runtimeSkill("verify", "1.0.0", skillContent("verify", "Verify tests.")),
    ]);
    const activator = new CodexSkillActivator(cache, path.join(directory, "runtime"));

    const activation = await activator.activate({
      runId: "run-1",
      workspaceId: "repo-1",
      skillKeys: ["plugin-one/review", "plugin-one/verify"],
    });

    expect(activation.skills.map((skill) => skill.name)).toEqual(["review", "verify"]);
    expect(activation.skills).toHaveLength(2);
    for (const skill of activation.skills) {
      expect(skill.path.startsWith(activation.root)).toBe(true);
      expect(await readFile(skill.path, "utf8")).toContain(`name: ${skill.name}`);
    }
  });

  it("restores the pinned skill hash after the plugin updates to newer bytes", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    const v1 = runtimeSkill("review", "1.0.0", skillContent("review", "Review with v1 rules."));
    const v2 = runtimeSkill("review", "2.0.0", skillContent("review", "Review with v2 rules."));
    await cache.initialize();
    await cache.syncPluginSkills([v1]);
    const activator = new CodexSkillActivator(cache, path.join(directory, "runtime"));
    const first = await activator.activate({ runId: "run-pinned", workspaceId: "repo-1", skillKeys: ["plugin-one/review"] });
    expect(first.skills[0]?.contentHash).toBe(v1.contentHash);

    await cache.syncPluginSkills([v2]);
    await rm(first.root, { recursive: true, force: true });
    const restored = await activator.restore("run-pinned");

    expect(restored?.skills[0]?.contentHash).toBe(v1.contentHash);
    expect(await readFile(restored!.skills[0]!.path, "utf8")).toContain("v1 rules");
    expect(await readFile(restored!.skills[0]!.path, "utf8")).not.toContain("v2 rules");
  });

  it("rejects more than two active skills in P2", async () => {
    const directory = await tempDirectory();
    const cache = new CodexSkillCache(path.join(directory, "cache"));
    await cache.initialize();
    await cache.syncPluginSkills([
      runtimeSkill("one", "1.0.0", skillContent("one", "One.")),
      runtimeSkill("two", "1.0.0", skillContent("two", "Two.")),
      runtimeSkill("three", "1.0.0", skillContent("three", "Three.")),
    ]);
    const activator = new CodexSkillActivator(cache, path.join(directory, "runtime"));

    await expect(activator.activate({
      runId: "run-too-many",
      workspaceId: "repo-1",
      skillKeys: ["plugin-one/one", "plugin-one/two", "plugin-one/three"],
    })).rejects.toThrow("at most 2 active skills");
  });
});

function runtimeSkill(skillId: string, version: string, content: string): PluginRuntimeSkill {
  return {
    pluginId: "plugin-one",
    pluginName: "Plugin One",
    pluginVersion: version,
    skillId,
    skillName: skillId,
    contentHash: sha256(content),
    content,
  };
}

function skillContent(name: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: test skill\n---\n\n${instructions}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-activation-"));
  temporaryDirectories.push(directory);
  return directory;
}
