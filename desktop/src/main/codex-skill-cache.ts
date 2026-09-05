import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PluginRuntimeSkill } from "./plugin-manager";

const SCHEMA_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_SKILLS = 512;
const MAX_SKILL_BYTES = 128 * 1024;

export type CodexSkillSecurity = "verified-plugin";

export interface CodexCachedSkill {
  key: string;
  pluginId: string;
  skillId: string;
  name: string;
  source: string;
  revision: string;
  contentHash: string;
  security: CodexSkillSecurity;
  workspaceIds?: string[];
  uses: number;
  lastUsedAt?: string;
  updatedAt: string;
}

export interface CodexPinnedSkill {
  key: string;
  pluginId: string;
  skillId: string;
  name: string;
  source: string;
  revision: string;
  contentHash: string;
  security: CodexSkillSecurity;
}

interface CodexSkillRegistryFile {
  schemaVersion: typeof SCHEMA_VERSION;
  skills: CodexCachedSkill[];
}

/**
 * Persistent content-addressed cache for already-reviewed plugin skills.
 *
 * P2 deliberately does not discover or download skills. PluginManager remains
 * the authority for what is installed/enabled; this cache only pins verified
 * content so a Codex run can project exact skill bytes into an ephemeral root.
 */
export class CodexSkillCache {
  private skills = new Map<string, CodexCachedSkill>();
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const registry = await readRegistry(this.registryPath());
    this.skills = new Map(registry.skills.map((skill) => [skill.key, skill]));
    this.initialized = true;
  }

  async syncPluginSkills(skills: readonly PluginRuntimeSkill[]): Promise<void> {
    await this.ensureInitialized();
    if (skills.length > MAX_SKILLS) throw new Error(`Codex skill cache supports at most ${MAX_SKILLS} active plugin skills`);

    const next = new Map<string, CodexCachedSkill>();
    const timestamp = this.now().toISOString();
    for (const skill of skills) {
      const pluginId = identifier(skill.pluginId, "Codex skill plugin id");
      const skillId = identifier(skill.skillId, "Codex skill id");
      const key = skillKey(pluginId, skillId);
      if (next.has(key)) throw new Error(`Codex skill cache received duplicate skill ${key}`);
      const contentHash = sha256(skill.content);
      if (contentHash !== digest(skill.contentHash, "Codex skill content hash")) {
        throw new Error(`Codex skill ${key} failed content integrity validation`);
      }
      const bytes = Buffer.byteLength(skill.content, "utf8");
      if (bytes === 0 || bytes > MAX_SKILL_BYTES) throw new Error(`Codex skill ${key} exceeds runtime size limits`);
      const workspaceIds = skill.workspaceIds?.map((workspaceId) => identifier(workspaceId, "Codex skill workspace id"));
      const existing = this.skills.get(key);
      await this.ensureContent(pluginId, skillId, contentHash, skill.content);
      next.set(key, {
        key,
        pluginId,
        skillId,
        name: boundedText(skill.skillName, 1, 128, "Codex skill name"),
        source: `plugin:${pluginId}`,
        revision: boundedText(skill.pluginVersion, 1, 128, "Codex skill revision"),
        contentHash,
        security: "verified-plugin",
        ...(workspaceIds ? { workspaceIds: [...new Set(workspaceIds)].sort() } : {}),
        uses: existing?.uses ?? 0,
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        updatedAt: timestamp,
      });
    }

    this.skills = next;
    await this.enqueueWrite();
  }

  list(): CodexCachedSkill[] {
    this.assertInitialized();
    return [...this.skills.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneSkill);
  }

  resolve(key: string, workspaceId: string): CodexCachedSkill {
    this.assertInitialized();
    const normalizedKey = parseSkillKey(key);
    const normalizedWorkspace = identifier(workspaceId, "Codex skill workspace id");
    const skill = this.skills.get(normalizedKey);
    if (!skill) throw new Error(`Codex skill ${normalizedKey} is not available from enabled plugins`);
    if (skill.workspaceIds && !skill.workspaceIds.includes(normalizedWorkspace)) {
      throw new Error(`Codex skill ${normalizedKey} is not enabled for workspace ${normalizedWorkspace}`);
    }
    return cloneSkill(skill);
  }

  pin(skill: CodexCachedSkill): CodexPinnedSkill {
    return {
      key: skill.key,
      pluginId: skill.pluginId,
      skillId: skill.skillId,
      name: skill.name,
      source: skill.source,
      revision: skill.revision,
      contentHash: skill.contentHash,
      security: skill.security,
    };
  }

  contentPath(skill: Pick<CodexPinnedSkill, "pluginId" | "skillId" | "contentHash">): string {
    this.assertInitialized();
    return path.join(
      this.root,
      identifier(skill.pluginId, "Codex skill plugin id"),
      identifier(skill.skillId, "Codex skill id"),
      digest(skill.contentHash, "Codex skill content hash"),
      "SKILL.md",
    );
  }

  async readPinned(skill: CodexPinnedSkill): Promise<string> {
    await this.ensureInitialized();
    validatePinned(skill);
    const content = await readFile(this.contentPath(skill), "utf8").catch((error: unknown) => {
      if (isMissing(error)) throw new Error(`Pinned Codex skill ${skill.key}@${skill.contentHash.slice(0, 12)} is missing from cache`);
      throw error;
    });
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES || sha256(content) !== skill.contentHash) {
      throw new Error(`Pinned Codex skill ${skill.key} failed cache integrity validation`);
    }
    return content;
  }

  async markUsed(keys: readonly string[]): Promise<void> {
    await this.ensureInitialized();
    if (keys.length === 0) return;
    const timestamp = this.now().toISOString();
    for (const raw of [...new Set(keys)]) {
      const key = parseSkillKey(raw);
      const skill = this.skills.get(key);
      if (!skill) continue;
      this.skills.set(key, { ...skill, uses: skill.uses + 1, lastUsedAt: timestamp });
    }
    await this.enqueueWrite();
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Codex skill cache is not initialized");
  }

  private registryPath(): string {
    return path.join(this.root, "registry.json");
  }

  private async ensureContent(pluginId: string, skillId: string, contentHash: string, content: string): Promise<void> {
    const target = path.join(this.root, pluginId, skillId, contentHash, "SKILL.md");
    try {
      const existing = await readFile(target, "utf8");
      if (sha256(existing) !== contentHash) throw new Error(`Codex skill cache entry ${pluginId}/${skillId} is corrupt`);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private enqueueWrite(): Promise<void> {
    const file: CodexSkillRegistryFile = {
      schemaVersion: SCHEMA_VERSION,
      skills: [...this.skills.values()].sort((left, right) => left.key.localeCompare(right.key)).map(cloneSkill),
    };
    const write = this.writeQueue.then(() => writeRegistry(this.registryPath(), file));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }
}

export function codexSkillKey(pluginId: string, skillId: string): string {
  return skillKey(identifier(pluginId, "Codex skill plugin id"), identifier(skillId, "Codex skill id"));
}

async function readRegistry(filePath: string): Promise<CodexSkillRegistryFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) throw new Error("Codex skill cache registry exceeds 1 MiB");
    const parsed = JSON.parse(raw) as Partial<CodexSkillRegistryFile>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.skills) || parsed.skills.length > MAX_SKILLS) {
      throw new Error("unsupported Codex skill cache registry schema");
    }
    const skills = parsed.skills.map(validateStoredSkill);
    if (new Set(skills.map((skill) => skill.key)).size !== skills.length) throw new Error("Codex skill cache registry contains duplicate keys");
    return { schemaVersion: SCHEMA_VERSION, skills };
  } catch (error) {
    if (isMissing(error)) return { schemaVersion: SCHEMA_VERSION, skills: [] };
    throw error;
  }
}

async function writeRegistry(filePath: string, file: CodexSkillRegistryFile): Promise<void> {
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_BYTES) throw new Error("Codex skill cache registry exceeds 1 MiB");
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function validateStoredSkill(value: unknown): CodexCachedSkill {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Codex cached skill");
  const record = value as Partial<CodexCachedSkill>;
  const pluginId = identifier(record.pluginId, "Codex skill plugin id");
  const skillId = identifier(record.skillId, "Codex skill id");
  const key = parseSkillKey(record.key);
  if (key !== skillKey(pluginId, skillId)) throw new Error("Codex cached skill key is inconsistent");
  if (record.security !== "verified-plugin") throw new Error("Codex cached skill security classification is invalid");
  if (!Number.isSafeInteger(record.uses) || Number(record.uses) < 0) throw new Error("Codex cached skill use count is invalid");
  const updatedAt = timestamp(record.updatedAt, "Codex cached skill updatedAt");
  const lastUsedAt = record.lastUsedAt === undefined ? undefined : timestamp(record.lastUsedAt, "Codex cached skill lastUsedAt");
  const workspaceIds = record.workspaceIds?.map((item) => identifier(item, "Codex cached skill workspace id"));
  return {
    key,
    pluginId,
    skillId,
    name: boundedText(record.name, 1, 128, "Codex cached skill name"),
    source: boundedText(record.source, 1, 256, "Codex cached skill source"),
    revision: boundedText(record.revision, 1, 128, "Codex cached skill revision"),
    contentHash: digest(record.contentHash, "Codex cached skill content hash"),
    security: "verified-plugin",
    ...(workspaceIds ? { workspaceIds: [...new Set(workspaceIds)].sort() } : {}),
    uses: Number(record.uses),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    updatedAt,
  };
}

function validatePinned(skill: CodexPinnedSkill): void {
  const pluginId = identifier(skill.pluginId, "Codex pinned skill plugin id");
  const skillId = identifier(skill.skillId, "Codex pinned skill id");
  if (parseSkillKey(skill.key) !== skillKey(pluginId, skillId)) throw new Error("Codex pinned skill key is inconsistent");
  boundedText(skill.name, 1, 128, "Codex pinned skill name");
  boundedText(skill.source, 1, 256, "Codex pinned skill source");
  boundedText(skill.revision, 1, 128, "Codex pinned skill revision");
  digest(skill.contentHash, "Codex pinned skill content hash");
  if (skill.security !== "verified-plugin") throw new Error("Codex pinned skill security classification is invalid");
}

function cloneSkill(skill: CodexCachedSkill): CodexCachedSkill {
  return { ...skill, ...(skill.workspaceIds ? { workspaceIds: [...skill.workspaceIds] } : {}) };
}

function parseSkillKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("Codex skill key is invalid");
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error("Codex skill key is invalid");
  return skillKey(identifier(parts[0], "Codex skill plugin id"), identifier(parts[1], "Codex skill id"));
}

function skillKey(pluginId: string, skillId: string): string {
  return `${pluginId}/${skillId}`;
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
