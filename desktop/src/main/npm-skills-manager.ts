import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import {
  CodexSkillCache,
  codexSkillKey,
  type CodexNpmSkill,
} from "./codex-skill-cache";
import { resolveNpxExecutable } from "./codex-cli-manager";
import {
  discoverPromptSkillSignals,
  discoverWorkspaceSkillSignals,
  promptNeedsAutomaticSkills,
  promptScopedSkillSignals,
} from "./workspace-skill-policy";

const SKILLS_CLI_SPEC = "skills@latest";
const MAX_SEARCH_QUERIES = 2;
const MAX_ACTIVE_SKILLS = 2;
const MAX_SEARCH_RESULTS = 20;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_BYTES = 128 * 1024;

const BROAD_SIGNALS = new Set(["node", "typescript", "vite"]);
const WORKSPACE_SEARCH_PRIORITY = [
  "react", "next", "svelte", "vue", "angular", "electron", "prisma", "playwright", "vitest", "tailwind",
  "postgres", "mysql", "redis", "python", "django", "fastapi", "rust", "cargo", "go", "java", "kotlin",
];
const STOP_WORDS = new Set([
  "about", "add", "after", "again", "also", "been", "before", "being", "build", "button", "change", "check", "code",
  "create", "current", "debug", "delete", "edit", "fix", "from", "have", "help", "implement", "inspect", "into", "just",
  "make", "need", "only", "please", "redesign", "refactor", "remove", "review", "screen", "should", "test", "that", "the",
  "then", "this", "through", "update", "using", "verify", "want", "with", "workspace", "your",
]);

export interface NpmSkillSearchCandidate {
  source: string;
  skill: string;
  installs: number;
  query: string;
}

export interface NpmSkillsPreflightResult {
  activeSkillKeys: string[];
  installed: string[];
  searches: string[];
  candidates: NpmSkillSearchCandidate[];
}

export interface NpmSkillsWorkspaceProvider {
  listManagedWorkspaces(): Promise<ManagedWorkspaceView[]>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type RunCommand = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

interface SkillLockEntry {
  source?: unknown;
  skillFolderHash?: unknown;
  updatedAt?: unknown;
}

interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

export class NpmSkillsManager {
  private initialized = false;

  constructor(private readonly options: {
    root: string;
    cache: CodexSkillCache;
    workspaces: NpmSkillsWorkspaceProvider;
    resolveNpx?: () => string | null;
    runCommand?: RunCommand;
  }) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await this.options.cache.initialize();
    this.initialized = true;
  }

  async prepareWorkspaceSkills(workspaceId: string, prompt: string): Promise<NpmSkillsPreflightResult> {
    await this.initialize();
    const workspace = await this.requireWorkspace(workspaceId);
    const promptSignals = discoverPromptSkillSignals(prompt);
    const workspaceSignals = await discoverWorkspaceSkillSignals(workspace.root);
    const promptRelevant = promptNeedsAutomaticSkills(prompt, promptSignals);
    const scopedWorkspaceSignals = promptScopedSkillSignals(workspaceSignals, promptSignals);
    const searches = buildNpmSkillSearchQueries(prompt, promptSignals, scopedWorkspaceSignals, promptRelevant);
    const npx = this.options.resolveNpx?.() ?? resolveNpxExecutable();
    if (!npx) {
      throw new Error("npx is required for the mandatory npm Skills CLI preflight");
    }

    const home = this.workspaceHome(workspace.id);
    const cacheRoot = path.join(home, ".npm-cache");
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const env = skillsCliEnvironment(home, cacheRoot);
    const discovered: NpmSkillSearchCandidate[] = [];

    for (const query of searches) {
      const result = await this.run(npx, ["--yes", SKILLS_CLI_SPEC, "find", query], {
        cwd: workspace.root,
        env,
      });
      if (result.exitCode !== 0) {
        throw new Error(`npm Skills CLI search failed for ${query}: ${safeProcessMessage(result)}`);
      }
      discovered.push(...parseNpmSkillsFindOutput(result.stdout, query));
    }

    // Discovery is mandatory, activation is not. A greeting/acknowledgement still
    // runs `skills find`, but must not install or inject arbitrary workspace skills.
    const candidates = promptRelevant ? chooseCandidates(discovered) : [];
    const imported: CodexNpmSkill[] = [];
    const installed: string[] = [];
    for (const candidate of candidates) {
      const lockBefore = await readSkillLock(home);
      const alreadyInstalled = lockEntryMatches(lockBefore, candidate)
        && await installedSkillContent(home, candidate.skill).then(() => true, () => false);
      if (!alreadyInstalled) {
        const result = await this.run(npx, [
          "--yes",
          SKILLS_CLI_SPEC,
          "add",
          candidate.source,
          "--skill",
          candidate.skill,
          "--agent",
          "codex",
          "--global",
          "--yes",
          "--copy",
        ], {
          cwd: workspace.root,
          env,
        });
        if (result.exitCode !== 0) {
          throw new Error(`npm Skills CLI install failed for ${candidate.source}@${candidate.skill}: ${safeProcessMessage(result)}`);
        }
        installed.push(`${candidate.source}@${candidate.skill}`);
      }

      const lock = await readSkillLock(home);
      const entry = lock.skills?.[candidate.skill];
      if (!lockEntryMatches(lock, candidate)) {
        throw new Error(`npm Skills CLI did not install the expected source for ${candidate.skill}`);
      }
      const content = await installedSkillContent(home, candidate.skill);
      const identity = npmSkillIdentity(candidate.source, candidate.skill);
      imported.push({
        key: codexSkillKey(identity.pluginId, identity.skillId),
        pluginId: identity.pluginId,
        skillId: identity.skillId,
        name: skillName(content, candidate.skill),
        source: `npm-skills:${candidate.source}@${candidate.skill}`,
        revision: skillRevision(entry),
        contentHash: sha256(content),
        content,
        workspaceIds: [workspace.id],
      });
    }

    if (imported.length > 0) await this.options.cache.upsertNpmSkills(imported);
    return {
      activeSkillKeys: imported.map((skill) => skill.key).slice(0, MAX_ACTIVE_SKILLS),
      installed,
      searches,
      candidates,
    };
  }

  private workspaceHome(workspaceId: string): string {
    return path.join(this.options.root, identifier(workspaceId, "npm Skills workspace id"));
  }

  private async requireWorkspace(workspaceId: string): Promise<ManagedWorkspaceView> {
    const normalized = identifier(workspaceId, "npm Skills workspace id");
    const workspace = (await this.options.workspaces.listManagedWorkspaces()).find((item) => item.id === normalized);
    if (!workspace) throw new Error(`Workspace ${normalized} is not registered`);
    if (workspace.validation.state !== "ready") throw new Error(`Workspace ${normalized} is not ready for npm skill discovery`);
    return workspace;
  }

  private run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return (this.options.runCommand ?? runBoundedCommand)(command, args, options);
  }
}

export function buildNpmSkillSearchQueries(
  prompt: string,
  promptSignals: string[],
  workspaceSignals: string[],
  promptRelevant = promptNeedsAutomaticSkills(prompt, promptSignals),
): string[] {
  const result: string[] = [];
  const push = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized || result.includes(normalized) || result.length >= MAX_SEARCH_QUERIES) return;
    result.push(normalized);
  };

  // Keep the user's mandatory npm Skills search even for a conversational turn,
  // but do not derive a technology from the workspace when the prompt has no task intent.
  if (!promptRelevant) {
    push("coding");
    return result;
  }

  for (const signal of promptSignals.filter((signal) => !BROAD_SIGNALS.has(signal))) push(signal);
  for (const signal of promptSignals.filter((signal) => BROAD_SIGNALS.has(signal))) push(signal);
  if (result.length === 0) {
    for (const token of prompt.toLowerCase().match(/[a-z][a-z0-9.+_-]{2,}/g) ?? []) {
      if (!STOP_WORDS.has(token)) push(token);
    }
  }
  if (result.length === 0) {
    for (const signal of rankWorkspaceSignals(promptScopedSkillSignals(workspaceSignals, promptSignals)).filter((signal) => !BROAD_SIGNALS.has(signal))) push(signal);
  }
  if (result.length === 0) push("coding");
  return result;
}

export function parseNpmSkillsFindOutput(stdout: string, query: string): NpmSkillSearchCandidate[] {
  const text = stripTerminalControls(stdout);
  const results: NpmSkillSearchCandidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(\S+)\s+([0-9]+(?:\.[0-9]+)?(?:[KMB])?) installs$/i.exec(line);
    if (!match) continue;
    if (!portableSkillName(match[2])) continue;
    results.push({
      source: match[1],
      skill: match[2],
      installs: parseInstallCount(match[3]),
      query,
    });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results;
}

function rankWorkspaceSignals(signals: string[]): string[] {
  const rank = new Map(WORKSPACE_SEARCH_PRIORITY.map((signal, index) => [signal, index]));
  return [...new Set(signals)].sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

function chooseCandidates(discovered: NpmSkillSearchCandidate[]): NpmSkillSearchCandidate[] {
  const selected: NpmSkillSearchCandidate[] = [];
  const seenSources = new Set<string>();
  const seenSkills = new Set<string>();
  const queries = [...new Set(discovered.map((candidate) => candidate.query))];
  for (const query of queries) {
    const candidate = discovered
      .filter((item) => item.query === query && !seenSources.has(`${item.source}@${item.skill}`) && !seenSkills.has(item.skill))
      .sort((a, b) => b.installs - a.installs || `${a.source}@${a.skill}`.localeCompare(`${b.source}@${b.skill}`))[0];
    if (!candidate) continue;
    selected.push(candidate);
    seenSources.add(`${candidate.source}@${candidate.skill}`);
    seenSkills.add(candidate.skill);
    if (selected.length >= MAX_ACTIVE_SKILLS) break;
  }
  return selected;
}

async function installedSkillContent(home: string, skill: string): Promise<string> {
  if (!portableSkillName(skill)) throw new Error("npm Skills CLI returned a non-portable skill name");
  const file = path.join(home, ".agents", "skills", skill, "SKILL.md");
  const content = await readFile(file, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0 || bytes > MAX_SKILL_BYTES) throw new Error(`npm skill ${skill} exceeds runtime size limits`);
  return content;
}

async function readSkillLock(home: string): Promise<SkillLockFile> {
  try {
    const raw = await readFile(path.join(home, ".agents", ".skill-lock.json"), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 512 * 1024) throw new Error("npm Skills CLI lock file exceeds size limits");
    const parsed = JSON.parse(raw) as SkillLockFile;
    if (!parsed || typeof parsed !== "object" || !parsed.skills || typeof parsed.skills !== "object") return { skills: {} };
    return parsed;
  } catch (error) {
    if (isMissing(error)) return { skills: {} };
    throw error;
  }
}

function lockEntryMatches(lock: SkillLockFile, candidate: NpmSkillSearchCandidate): boolean {
  const entry = lock.skills?.[candidate.skill];
  return Boolean(entry && entry.source === candidate.source);
}

function skillRevision(entry: SkillLockEntry | undefined): string {
  if (typeof entry?.skillFolderHash === "string" && /^[a-f0-9]{7,64}$/i.test(entry.skillFolderHash)) return entry.skillFolderHash;
  if (typeof entry?.updatedAt === "string" && Number.isFinite(Date.parse(entry.updatedAt))) return entry.updatedAt;
  return "skills-cli-latest";
}

function skillName(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/).slice(0, 40)) {
    const match = /^name:\s*["']?([^"']+?)["']?\s*$/.exec(line.trim());
    if (match?.[1]) return boundedName(match[1]);
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) return boundedName(heading[1]);
  }
  return boundedName(fallback);
}

function npmSkillIdentity(source: string, skill: string): { pluginId: string; skillId: string } {
  const sourceHash = sha256(source).slice(0, 12);
  const identityHash = sha256(`${source}@${skill}`).slice(0, 10);
  const base = skill.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";
  return {
    pluginId: `npm-${sourceHash}`,
    skillId: `${base}-${identityHash}`.slice(0, 63),
  };
}

function skillsCliEnvironment(home: string, cacheRoot: string): NodeJS.ProcessEnv {
  const source = process.env;
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_CACHE: cacheRoot,
    npm_config_cache: cacheRoot,
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  for (const key of [
    "PATH", "Path", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

function runBoundedCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer | string) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
      return Buffer.from(next, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function parseInstallCount(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB])?$/i.exec(value);
  if (!match) return 0;
  const multiplier = match[2]?.toUpperCase() === "B" ? 1_000_000_000
    : match[2]?.toUpperCase() === "M" ? 1_000_000
      : match[2]?.toUpperCase() === "K" ? 1_000
        : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function portableSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function boundedName(value: string): string {
  const normalized = value.replace(/[\0\r\n]/g, " ").trim().slice(0, 128);
  return normalized || "npm skill";
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeProcessMessage(result: CommandResult): string {
  const message = stripTerminalControls(result.stderr || result.stdout).replace(/\s+/g, " ").trim();
  return (message || `exit ${result.exitCode}`).slice(0, 512);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
