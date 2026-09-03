import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  PluginSkillView,
  WorkspaceSkillPolicyUpdateInput,
  WorkspaceSkillPolicyView,
} from "../shared/plugin-hub-api";

const SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_POLICIES = 256;
const MAX_SKILL_OVERRIDES = 256;
const MAX_DISCOVERY_ENTRIES = 768;
const MAX_DISCOVERY_DEPTH = 3;
const MAX_MANIFEST_BYTES = 256 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const SIGNAL_ALIASES: Record<string, string[]> = {
  angular: ["angular", "@angular"],
  aws: ["aws", "amazon web services"],
  azure: ["azure"],
  cargo: ["cargo", "cargo.toml"],
  confluence: ["confluence"],
  django: ["django"],
  docker: ["docker", "dockerfile", "compose.yaml", "docker-compose"],
  electron: ["electron"],
  fastapi: ["fastapi"],
  figma: ["figma"],
  gcp: ["gcp", "google cloud"],
  go: ["golang", "go.mod", "go.sum"],
  java: ["java", "maven", "pom.xml"],
  jira: ["jira", "atlassian"],
  jest: ["jest"],
  kotlin: ["kotlin", "gradle.kts"],
  kubernetes: ["kubernetes", "k8s", "helm"],
  mysql: ["mysql"],
  next: ["next", "nextjs", "next.js"],
  node: ["node", "nodejs", "package.json", "npm", "pnpm", "yarn"],
  playwright: ["playwright"],
  postgres: ["postgres", "postgresql"],
  prisma: ["prisma"],
  python: ["python", "pyproject.toml", "requirements.txt", "pip"],
  react: ["react", "react-dom"],
  redis: ["redis"],
  rust: ["rust", "cargo", "cargo.toml"],
  svelte: ["svelte", "sveltekit"],
  tailwind: ["tailwind", "tailwindcss"],
  terraform: ["terraform", ".tf"],
  typescript: ["typescript", "tsconfig", ".ts", ".tsx"],
  vite: ["vite", "vitest"],
  vitest: ["vitest"],
  vue: ["vue", "nuxt"],
};

const GENERIC_SKILL_TOKENS = new Set([
  "coding",
  "debug",
  "debugging",
  "documentation",
  "git",
  "guidelines",
  "karpathy",
  "repository",
  "review",
  "testing",
  "workflow",
]);

interface PolicyStoreFile {
  schemaVersion: 1;
  policies: WorkspaceSkillPolicyView[];
}

export class WorkspaceSkillPolicyStore {
  private policies = new Map<string, WorkspaceSkillPolicyView>();
  private initialized = false;

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let raw: string | undefined;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (raw !== undefined) {
      if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) {
        throw new Error("Workspace skill policy store exceeds the Desktop size limit");
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.policies)) {
        throw new Error("Workspace skill policy store has invalid schema");
      }
      if (parsed.policies.length > MAX_POLICIES) {
        throw new Error("Workspace skill policy store exceeds the workspace limit");
      }
      for (const candidate of parsed.policies) {
        const policy = validateStoredPolicy(candidate);
        if (this.policies.has(policy.workspaceId)) {
          throw new Error(`Workspace skill policy store contains duplicate workspace ${policy.workspaceId}`);
        }
        this.policies.set(policy.workspaceId, policy);
      }
    }
    this.initialized = true;
  }

  async get(workspaceId: string): Promise<WorkspaceSkillPolicyView> {
    await this.ensureInitialized();
    const id = identifier(workspaceId, "workspace id");
    return clonePolicy(this.policies.get(id) ?? defaultWorkspaceSkillPolicy(id));
  }

  async set(input: WorkspaceSkillPolicyUpdateInput): Promise<WorkspaceSkillPolicyView> {
    await this.ensureInitialized();
    const policy = validatePolicyInput(input, this.now());
    const before = this.policies.get(policy.workspaceId);
    this.policies.set(policy.workspaceId, policy);
    try {
      await this.persist();
    } catch (error) {
      if (before) this.policies.set(policy.workspaceId, before);
      else this.policies.delete(policy.workspaceId);
      throw error;
    }
    return clonePolicy(policy);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async persist(): Promise<void> {
    const policies = [...this.policies.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
    const file: PolicyStoreFile = { schemaVersion: SCHEMA_VERSION, policies };
    const encoded = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Workspace skill policy store exceeds the Desktop size limit");
    }
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporary, encoded, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function defaultWorkspaceSkillPolicy(workspaceId: string): WorkspaceSkillPolicyView {
  return {
    workspaceId: identifier(workspaceId, "workspace id"),
    discovery: "automatic",
    use: "automatic",
    install: "manual",
    include: [],
    exclude: [],
    updatedAt: 0,
  };
}

export async function discoverWorkspaceSkillSignals(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const signals = new Set<string>();
  const queue: Array<{ directory: string; depth: number }> = [{ directory: resolvedRoot, depth: 0 }];
  let visitedEntries = 0;

  while (queue.length > 0 && visitedEntries < MAX_DISCOVERY_ENTRIES) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visitedEntries >= MAX_DISCOVERY_ENTRIES) break;
      visitedEntries += 1;
      if (entry.isSymbolicLink()) continue;
      const lower = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (current.depth < MAX_DISCOVERY_DEPTH && !SKIPPED_DIRECTORIES.has(lower)) {
          queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      addSignalsFromFileName(lower, signals);
      if (isManifestFile(lower)) {
        await addSignalsFromManifest(path.join(current.directory, entry.name), lower, signals);
      }
    }
  }

  if (signals.has("cargo")) signals.add("rust");
  if (signals.has("react") || signals.has("next") || signals.has("vite") || signals.has("electron")) {
    signals.add("node");
  }
  return [...signals].sort();
}

export function workspaceSkillKey(pluginId: string, skillId: string): string {
  return `${identifier(pluginId, "plugin id")}/${identifier(skillId, "skill id")}`;
}

export function skillSignalMatches(skill: Pick<PluginSkillView, "id" | "name" | "description">, signals: string[]): string[] {
  const haystack = normalize(`${skill.id} ${skill.name} ${skill.description ?? ""}`);
  const matched = new Set<string>();
  for (const signal of signals) {
    const aliases = SIGNAL_ALIASES[signal] ?? [signal];
    if (aliases.some((alias) => haystack.includes(normalize(alias)))) matched.add(signal);
  }
  return [...matched].sort();
}

export function isGenericWorkspaceSkill(skill: Pick<PluginSkillView, "id" | "name" | "description">): boolean {
  const text = normalize(`${skill.id} ${skill.name} ${skill.description ?? ""}`);
  const metaSkill = /(^| )(manage-skills|skill-optimizer|skill-scanner|skill-check|skill-creator)( |$)/.test(text);
  if (metaSkill) return true;
  const declaresTechnology = Object.values(SIGNAL_ALIASES)
    .flat()
    .some((alias) => text.includes(normalize(alias)));
  if (declaresTechnology) return false;
  return text.split(" ").filter(Boolean).some((token) => GENERIC_SKILL_TOKENS.has(token));
}

export function workspaceSkillIsActive(
  policy: WorkspaceSkillPolicyView,
  pluginId: string,
  skill: Pick<PluginSkillView, "id" | "name" | "description">,
  signals: string[],
): { active: boolean; generic: boolean; matchedSignals: string[]; reason: string } {
  const key = workspaceSkillKey(pluginId, skill.id);
  const generic = isGenericWorkspaceSkill(skill);
  const matchedSignals = skillSignalMatches(skill, signals);
  if (policy.exclude.includes(key)) {
    return { active: false, generic, matchedSignals, reason: "Excluded for this workspace" };
  }
  if (policy.include.includes(key)) {
    return { active: true, generic, matchedSignals, reason: "Explicitly enabled for this workspace" };
  }
  if (policy.discovery === "manual") {
    return { active: false, generic, matchedSignals, reason: "Automatic discovery is disabled" };
  }
  if (policy.use === "manual") {
    return { active: false, generic, matchedSignals, reason: "Automatic skill use is disabled" };
  }
  if (generic) {
    return { active: true, generic, matchedSignals, reason: "General repository skill" };
  }
  if (matchedSignals.length > 0) {
    return {
      active: true,
      generic,
      matchedSignals,
      reason: `Matched workspace signal: ${matchedSignals.join(", ")}`,
    };
  }
  return { active: false, generic, matchedSignals, reason: "No matching workspace signal" };
}

export function catalogIdMatchesSignals(catalogId: string, signals: string[]): boolean {
  const haystack = normalize(catalogId);
  return signals.some((signal) => (SIGNAL_ALIASES[signal] ?? [signal]).some((alias) => haystack.includes(normalize(alias))));
}

function validatePolicyInput(input: WorkspaceSkillPolicyUpdateInput, updatedAt: number): WorkspaceSkillPolicyView {
  if (!isRecord(input)) throw new Error("Workspace skill policy input is invalid");
  const workspaceId = identifier(input.workspaceId, "workspace id");
  if (input.discovery !== "automatic" && input.discovery !== "manual") {
    throw new Error("Workspace skill discovery policy is invalid");
  }
  if (input.use !== "automatic" && input.use !== "manual") {
    throw new Error("Workspace skill use policy is invalid");
  }
  if (input.install !== "manual" && input.install !== "skills-only") {
    throw new Error("Workspace skill install policy is invalid");
  }
  const include = validateOverrides(input.include, "include");
  const exclude = validateOverrides(input.exclude, "exclude");
  if (include.some((key) => exclude.includes(key))) {
    throw new Error("Workspace skill policy cannot include and exclude the same skill");
  }
  return { workspaceId, discovery: input.discovery, use: input.use, install: input.install, include, exclude, updatedAt };
}

function validateStoredPolicy(value: unknown): WorkspaceSkillPolicyView {
  if (!isRecord(value) || typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) {
    throw new Error("Workspace skill policy record is invalid");
  }
  return {
    ...validatePolicyInput(value as unknown as WorkspaceSkillPolicyUpdateInput, value.updatedAt),
    updatedAt: value.updatedAt,
  };
}

function validateOverrides(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SKILL_OVERRIDES) {
    throw new Error(`Workspace skill ${label} list is invalid`);
  }
  return [...new Set(value.map((item) => validateSkillKey(item, label)))].sort();
}

function validateSkillKey(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Workspace skill ${label} entry is invalid`);
  const parts = value.split("/");
  if (parts.length !== 2) throw new Error(`Workspace skill ${label} entry is invalid`);
  return workspaceSkillKey(parts[0], parts[1]);
}

function addSignalsFromFileName(file: string, signals: Set<string>): void {
  if (file === "package.json" || file === "package-lock.json" || file === "pnpm-lock.yaml" || file === "yarn.lock") signals.add("node");
  if (file === "tsconfig.json" || file.endsWith(".ts") || file.endsWith(".tsx")) signals.add("typescript");
  if (file === "cargo.toml" || file === "cargo.lock") signals.add("cargo");
  if (file === "pyproject.toml" || file.startsWith("requirements") || file.endsWith(".py")) signals.add("python");
  if (file === "go.mod" || file === "go.sum" || file.endsWith(".go")) signals.add("go");
  if (file === "pom.xml" || file === "build.gradle") signals.add("java");
  if (file === "build.gradle.kts" || file.endsWith(".kt")) signals.add("kotlin");
  if (file === "dockerfile" || file.startsWith("dockerfile.") || file === "compose.yaml" || file === "compose.yml" || file.startsWith("docker-compose")) signals.add("docker");
  if (file.endsWith(".tf")) signals.add("terraform");
  if (file.includes("playwright")) signals.add("playwright");
  if (file.includes("vitest")) signals.add("vitest");
}

async function addSignalsFromManifest(filePath: string, fileName: string, signals: Set<string>): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) return;
  const normalized = normalize(`${fileName} ${raw}`);
  for (const [signal, aliases] of Object.entries(SIGNAL_ALIASES)) {
    if (aliases.some((alias) => normalized.includes(normalize(alias)))) signals.add(signal);
  }
}

function isManifestFile(file: string): boolean {
  return file === "package.json"
    || file === "cargo.toml"
    || file === "pyproject.toml"
    || file.startsWith("requirements")
    || file === "go.mod"
    || file === "pom.xml"
    || file === "build.gradle"
    || file === "build.gradle.kts"
    || file.endsWith(".tf");
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.+_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function clonePolicy(policy: WorkspaceSkillPolicyView): WorkspaceSkillPolicyView {
  return { ...policy, include: [...policy.include], exclude: [...policy.exclude] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
