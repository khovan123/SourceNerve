import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PluginSkillView } from "../shared/plugin-hub-api";
import {
  WorkspaceSkillPolicyStore,
  catalogIdMatchesSignals,
  defaultWorkspaceSkillPolicy,
  discoverWorkspaceSkillSignals,
  isGenericWorkspaceSkill,
  skillSignalMatches,
  workspaceSkillIsActive,
} from "./workspace-skill-policy";

function skill(id: string, name: string, description?: string): PluginSkillView {
  return {
    id,
    name,
    ...(description ? { description } : {}),
    relativePath: `skills/${id}/SKILL.md`,
    contentHash: "a".repeat(64),
    bytes: 42,
  };
}

describe("workspace skill discovery", () => {
  it("detects bounded repository signals while ignoring dependency/build directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-skill-signals-"));
    try {
      await writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify({
          dependencies: { react: "19.0.0" },
          devDependencies: { typescript: "5.9.0", vitest: "3.2.0" },
        })}\n`,
        "utf8",
      );
      await mkdir(path.join(root, "crates", "core"), { recursive: true });
      await writeFile(
        path.join(root, "crates", "core", "Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
        "utf8",
      );
      await mkdir(path.join(root, "node_modules", "terraform-fixture"), { recursive: true });
      await writeFile(path.join(root, "node_modules", "terraform-fixture", "main.tf"), "resource {}\n", "utf8");
      await mkdir(path.join(root, "target", "python-fixture"), { recursive: true });
      await writeFile(path.join(root, "target", "python-fixture", "pyproject.toml"), "[project]\nname='ignored'\n", "utf8");

      const signals = await discoverWorkspaceSkillSignals(root);
      expect(signals).toEqual(expect.arrayContaining(["node", "react", "typescript", "vitest", "cargo", "rust"]));
      expect(signals).not.toContain("terraform");
      expect(signals).not.toContain("python");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("distinguishes general repository skills from technology-specific skills", () => {
    const general = skill("repository-review", "Repository review", "Review repository changes before commit");
    const react = skill("react-components", "React components", "Implement React and TypeScript UI components");

    expect(isGenericWorkspaceSkill(general)).toBe(true);
    expect(isGenericWorkspaceSkill(react)).toBe(false);
    expect(skillSignalMatches(react, ["react", "python"])).toEqual(["react"]);
    expect(catalogIdMatchesSignals("react-testing-tools", ["react"])).toBe(true);
    expect(catalogIdMatchesSignals("django-tools", ["react"])).toBe(false);
  });
});

describe("workspace skill policy resolution", () => {
  it("uses matching/general skills automatically and lets explicit excludes/includes win", () => {
    const policy = defaultWorkspaceSkillPolicy("workspace-a");
    const general = skill("repository-review", "Repository review", "Review repository changes");
    const react = skill("react-components", "React components", "Implement React UI components");
    const django = skill("django-migrations", "Django migrations", "Maintain Django database migrations");

    expect(workspaceSkillIsActive(policy, "dev", general, ["react"]).active).toBe(true);
    expect(workspaceSkillIsActive(policy, "dev", react, ["react"]).active).toBe(true);
    expect(workspaceSkillIsActive(policy, "dev", django, ["react"]).active).toBe(false);

    const excluded = { ...policy, exclude: ["dev/react-components"] };
    expect(workspaceSkillIsActive(excluded, "dev", react, ["react"]).active).toBe(false);

    const included = { ...policy, include: ["dev/django-migrations"] };
    expect(workspaceSkillIsActive(included, "dev", django, ["react"]).active).toBe(true);

    const manualUse = { ...policy, use: "manual" as const };
    expect(workspaceSkillIsActive(manualUse, "dev", general, ["react"]).active).toBe(false);
    expect(workspaceSkillIsActive({ ...manualUse, include: ["dev/repository-review"] }, "dev", general, ["react"]).active).toBe(true);
  });

  it("persists workspace-specific policy without leaking overrides to another workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-skill-policy-store-"));
    const filePath = path.join(root, "managed", "workspace-skill-policy.json");
    try {
      const store = new WorkspaceSkillPolicyStore(filePath, () => 1234);
      await store.set({
        workspaceId: "workspace-a",
        discovery: "automatic",
        use: "manual",
        install: "skills-only",
        include: ["dev/react-components"],
        exclude: ["dev/django-migrations"],
      });

      const reloaded = new WorkspaceSkillPolicyStore(filePath, () => 9999);
      expect(await reloaded.get("workspace-a")).toEqual({
        workspaceId: "workspace-a",
        discovery: "automatic",
        use: "manual",
        install: "skills-only",
        include: ["dev/react-components"],
        exclude: ["dev/django-migrations"],
        updatedAt: 1234,
      });
      expect(await reloaded.get("workspace-b")).toEqual(defaultWorkspaceSkillPolicy("workspace-b"));

      const persisted = JSON.parse(await readFile(filePath, "utf8")) as { policies: unknown[] };
      expect(persisted.policies).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
