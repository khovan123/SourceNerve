import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexRuntimePool } from "../main/codex-runtime-pool";
import { CodexSkillActivator } from "../main/codex-skill-activator";
import { CodexSkillCache } from "../main/codex-skill-cache";
import { CodexThinRunner } from "../main/codex-thin-runner";
import { CodexThreadStore } from "../main/codex-thread-store";
import type { PluginRuntimeSkill } from "../main/plugin-manager";

const LIVE = process.env.SOURCENERVE_CODEX_E2E === "1";
const liveIt = LIVE ? it : it.skip;
const temporaryDirectories: string[] = [];
const MAX_E2E_RESPONSE_BYTES = 64 * 1024;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native Codex app-server live integration", () => {
  liveIt("uses the installed ChatGPT-authenticated Codex CLI, projects a skill, completes a turn, and resumes the exact thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-codex-live-"));
    temporaryDirectories.push(root);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = await prepareIsolatedCodexHome(root, previousCodexHome);
    const cwd = path.join(root, "workspace");
    const managed = path.join(root, "managed");
    const cacheRoot = path.join(root, "skills", "cache");
    const runtimeRoot = path.join(root, "skills", "runs");
    const threadStorePath = path.join(managed, "codex-threads.json");
    await mkdir(cwd, { recursive: true });
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(cwd, "README.md"), "# SourceNerve Codex live E2E\n", "utf8");

    const cache = new CodexSkillCache(cacheRoot);
    await cache.initialize();
    await cache.syncPluginSkills([liveSkill()]);

    const firstRunner = new CodexThinRunner(
      new CodexRuntimePool({
        store: new CodexThreadStore(threadStorePath),
        clientVersion: "p3-e2e",
      }),
      new CodexSkillActivator(cache, runtimeRoot),
    );
    await firstRunner.initialize();

    try {
      const account = await firstRunner.account(cwd);
      if (account.account?.type !== "chatgpt") {
        throw new Error("P3 Codex live E2E requires an installed Codex CLI signed in with ChatGPT");
      }

      const first = await firstRunner.run({
        runId: "p3-live-run",
        workspaceId: "p3-live-workspace",
        cwd,
        prompt: "Use the explicitly activated SourceNerve E2E skill and return one short confirmation sentence. Do not modify files or run commands.",
        skillKeys: ["sourcenerve-e2e/native-smoke"],
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      expect(first.status).toBe("completed");
      expect(first.resumed).toBe(false);
      expect(first.skillActivation?.skills.map((skill) => skill.key)).toEqual(["sourcenerve-e2e/native-smoke"]);
      expectBoundedResponse(first.response);
      const persistedThreadId = first.threadId;
    
      await firstRunner.shutdown();

      const secondRunner = new CodexThinRunner(
        new CodexRuntimePool({
          store: new CodexThreadStore(threadStorePath),
          clientVersion: "p3-e2e",
        }),
        new CodexSkillActivator(new CodexSkillCache(cacheRoot), runtimeRoot),
      );
      await secondRunner.initialize();
      try {
        const resumed = await secondRunner.run({
          runId: "p3-live-run",
          workspaceId: "p3-live-workspace",
          cwd,
          prompt: "Return one short confirmation that this is the resumed SourceNerve E2E thread. Do not modify files or run commands.",
          sandbox: "read-only",
          approvalPolicy: "never",
        });
        expect(resumed.status).toBe("completed");
        expect(resumed.resumed).toBe(true);
        expect(resumed.threadId).toBe(persistedThreadId);
        expect(resumed.skillActivation?.skills.map((skill) => skill.key)).toEqual(["sourcenerve-e2e/native-smoke"]);
        expectBoundedResponse(resumed.response);
      } finally {
        await secondRunner.shutdown();
      }
    } finally {
      await firstRunner.shutdown().catch(() => undefined);
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 120_000);
});

async function prepareIsolatedCodexHome(root: string, configuredHome: string | undefined): Promise<string> {
  const source = configuredHome ?? path.join(os.homedir(), ".codex");
  const target = path.join(root, "codex-home");
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "config.toml", "installation_id"]) {
    const from = path.join(source, name);
    try {
      await access(from);
      await copyFile(from, path.join(target, name));
    } catch {
      if (name === "auth.json") throw new Error("P3 Codex live E2E could not read the existing ChatGPT Codex auth file");
    }
  }
  return target;
}

function liveSkill(): PluginRuntimeSkill {
  const content = [
    "---",
    "name: native-smoke",
    "description: SourceNerve P3 live Codex app-server smoke skill",
    "---",
    "",
    "When explicitly invoked for the live E2E, answer briefly and do not invoke tools or modify files.",
    "",
  ].join("\n");
  return {
    pluginId: "sourcenerve-e2e",
    pluginName: "SourceNerve E2E",
    pluginVersion: "1.0.0",
    skillId: "native-smoke",
    skillName: "native-smoke",
    contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
    content,
  };
}

function expectBoundedResponse(response: string | undefined): void {
  if (!response || response.trim().length === 0) throw new Error("Codex live E2E returned an empty response");
  if (Buffer.byteLength(response, "utf8") > MAX_E2E_RESPONSE_BYTES) {
    throw new Error("Codex live E2E response exceeded 64 KiB");
  }
  expect(response.includes("\0")).toBe(false);
}
