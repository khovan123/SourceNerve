import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CodexSkillCache,
  type CodexPinnedSkill,
} from "./codex-skill-cache";

const SCHEMA_VERSION = 1 as const;
const MAX_ACTIVE_SKILLS = 2;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface CodexActivatedSkill {
  key: string;
  name: string;
  path: string;
  contentHash: string;
}

export interface CodexSkillActivation {
  runId: string;
  workspaceId: string;
  root: string;
  skills: CodexActivatedSkill[];
}

interface CodexSkillActivationManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  workspaceId: string;
  skills: CodexPinnedSkill[];
  updatedAt: string;
}

/**
 * Projects a bounded set of pinned skills into a task-scoped runtime root.
 * The runtime root is disposable; exact skill bytes remain recoverable from the
 * content-addressed cache and the small activation manifest.
 */
export class CodexSkillActivator {
  constructor(
    private readonly cache: CodexSkillCache,
    private readonly runtimeRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await this.cache.initialize();
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
  }

  async activate(input: { runId: string; workspaceId: string; skillKeys: readonly string[] }): Promise<CodexSkillActivation> {
    await this.initialize();
    const runId = boundedIdentifier(input.runId, "Codex skill run id");
    const workspaceId = workspaceIdentifier(input.workspaceId);
    const skillKeys = [...new Set(input.skillKeys)];
    if (skillKeys.length > MAX_ACTIVE_SKILLS) throw new Error(`Codex P2 supports at most ${MAX_ACTIVE_SKILLS} active skills`);
    const pinned = skillKeys.map((key) => this.cache.pin(this.cache.resolve(key, workspaceId)));
    const activation = await this.materialize({ runId, workspaceId, skills: pinned });
    await this.cache.markUsed(skillKeys);
    return activation;
  }

  async restore(runIdInput: string): Promise<CodexSkillActivation | null> {
    await this.initialize();
    const runId = boundedIdentifier(runIdInput, "Codex skill run id");
    const manifest = await this.readManifest(runId);
    if (!manifest) return null;
    return this.materialize({
      runId: manifest.runId,
      workspaceId: manifest.workspaceId,
      skills: manifest.skills,
    });
  }

  async release(runIdInput: string): Promise<boolean> {
    await this.initialize();
    const runId = boundedIdentifier(runIdInput, "Codex skill run id");
    const directory = this.runDirectory(runId);
    try {
      await rm(directory, { recursive: true, force: false });
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async materialize(input: { runId: string; workspaceId: string; skills: readonly CodexPinnedSkill[] }): Promise<CodexSkillActivation> {
    if (input.skills.length > MAX_ACTIVE_SKILLS) throw new Error(`Codex P2 supports at most ${MAX_ACTIVE_SKILLS} active skills`);
    const runDirectory = this.runDirectory(input.runId);
    const finalSkillsRoot = path.join(runDirectory, "skills");
    const temporaryRoot = path.join(runDirectory, `skills.tmp-${process.pid}-${randomUUID()}`);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });

    const activated: CodexActivatedSkill[] = [];
    try {
      for (const skill of input.skills) {
        const content = await this.cache.readPinned(skill);
        const skillDirectory = path.join(temporaryRoot, `${skill.pluginId}--${skill.skillId}`);
        await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
        const skillPath = path.join(skillDirectory, "SKILL.md");
        await writeFile(skillPath, content, { encoding: "utf8", mode: 0o600 });
        activated.push({
          key: skill.key,
          name: skill.skillId,
          path: path.join(finalSkillsRoot, `${skill.pluginId}--${skill.skillId}`, "SKILL.md"),
          contentHash: skill.contentHash,
        });
      }
      await rm(finalSkillsRoot, { recursive: true, force: true });
      await rename(temporaryRoot, finalSkillsRoot);
      await writeManifest(path.join(runDirectory, "activation.json"), {
        schemaVersion: SCHEMA_VERSION,
        runId: input.runId,
        workspaceId: input.workspaceId,
        skills: input.skills.map((skill) => ({ ...skill })),
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return {
      runId: input.runId,
      workspaceId: input.workspaceId,
      root: finalSkillsRoot,
      skills: activated,
    };
  }

  private async readManifest(runId: string): Promise<CodexSkillActivationManifest | null> {
    const filePath = path.join(this.runDirectory(runId), "activation.json");
    try {
      const raw = await readFile(filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Codex skill activation manifest exceeds 64 KiB");
      const parsed = JSON.parse(raw) as Partial<CodexSkillActivationManifest>;
      if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.runId !== runId || !Array.isArray(parsed.skills)) {
        throw new Error("unsupported Codex skill activation manifest schema");
      }
      if (parsed.skills.length > MAX_ACTIVE_SKILLS) throw new Error("Codex skill activation manifest exceeds P2 skill limit");
      const workspaceId = workspaceIdentifier(parsed.workspaceId);
      const updatedAt = timestamp(parsed.updatedAt, "Codex skill activation updatedAt");
      const skills = parsed.skills.map(validatePinnedSkill);
      if (new Set(skills.map((skill) => skill.key)).size !== skills.length) throw new Error("Codex skill activation contains duplicate skills");
      return {
        schemaVersion: SCHEMA_VERSION,
        runId,
        workspaceId,
        skills,
        updatedAt,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private runDirectory(runId: string): string {
    const digest = createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 32);
    return path.join(this.runtimeRoot, `run-${digest}`);
  }
}

async function writeManifest(filePath: string, manifest: CodexSkillActivationManifest): Promise<void> {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Codex skill activation manifest exceeds 64 KiB");
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validatePinnedSkill(value: unknown): CodexPinnedSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid pinned Codex skill in activation manifest");
  const record = value as Partial<CodexPinnedSkill>;
  const pluginId = identifier(record.pluginId, "Codex pinned skill plugin id");
  const skillId = identifier(record.skillId, "Codex pinned skill id");
  const key = `${pluginId}/${skillId}`;
  if (record.key !== key) throw new Error("Codex pinned skill key is inconsistent");
  if (record.security !== "verified-plugin") throw new Error("Codex pinned skill security classification is invalid");
  return {
    key,
    pluginId,
    skillId,
    name: boundedText(record.name, 1, 128, "Codex pinned skill name"),
    source: boundedText(record.source, 1, 256, "Codex pinned skill source"),
    revision: boundedText(record.revision, 1, 128, "Codex pinned skill revision"),
    contentHash: digest(record.contentHash, "Codex pinned skill content hash"),
    security: "verified-plugin",
  };
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function workspaceIdentifier(value: unknown): string {
  return identifier(value, "Codex skill workspace id");
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\0\r\n]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
