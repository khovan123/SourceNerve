import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  PluginMcpComponentView,
  PluginPackageReview,
  PluginSkillView,
} from "../shared/plugin-hub-api";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MCP_CONFIG_BYTES = 256 * 1024;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_MCP_SERVERS = 16;
const MAX_SKILLS = 32;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 1024;
const EXECUTION_FIELDS = new Set([
  "scripts",
  "hooks",
  "install",
  "preinstall",
  "postinstall",
  "preuninstall",
  "postuninstall",
  "binaries",
  "executables",
  "commands",
]);

export interface InspectedPluginSkill {
  descriptor: PluginSkillView;
  content: string;
}

export interface InspectedPluginPackage {
  root: string;
  review: PluginPackageReview;
  skills: InspectedPluginSkill[];
}

export async function inspectLocalPluginPackage(root: string): Promise<InspectedPluginPackage> {
  if (!root || root.length > 4096 || /[\0\r\n]/.test(root)) {
    throw new Error("Plugin package root is invalid");
  }
  const packageRoot = await realpath(root);
  const manifestPath = inside(packageRoot, ".codex-plugin/plugin.json");
  const manifestRaw = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES, "plugin manifest");
  const manifest = parseJsonRecord(manifestRaw, "plugin manifest");
  rejectExecutionFields(manifest);

  const id = identifier(manifest.name, "plugin name");
  const version = boundedText(manifest.version, 1, 64, "plugin version");
  const description = boundedText(manifest.description, 1, 4096, "plugin description");
  const interfaceValue = optionalRecord(manifest.interface, "plugin interface");
  const displayName = interfaceValue
    ? optionalBoundedText(interfaceValue.displayName, 1, 128, "plugin display name") ?? id
    : id;
  const publisher = publisherName(manifest, interfaceValue);
  const category = interfaceValue
    ? optionalBoundedText(interfaceValue.category, 1, 128, "plugin category")
    : undefined;

  let mcpRaw = "";
  let mcpServers: PluginMcpComponentView[] = [];
  if (manifest.mcpServers !== undefined) {
    const declared = declaredRelativePath(manifest.mcpServers, "mcpServers");
    const mcpPath = inside(packageRoot, declared);
    mcpRaw = await readBoundedRegularFile(mcpPath, MAX_MCP_CONFIG_BYTES, "plugin MCP config");
    mcpServers = parseMcpServers(mcpRaw);
  }

  let skills: InspectedPluginSkill[] = [];
  if (manifest.skills !== undefined) {
    const declared = declaredRelativePath(manifest.skills, "skills");
    const skillsRoot = inside(packageRoot, declared);
    skills = await inspectSkills(packageRoot, skillsRoot);
  }

  const manifestHash = digest([
    `manifest\0${manifestRaw}`,
    `mcp\0${mcpRaw}`,
    ...skills
      .map((item) => `${item.descriptor.relativePath}\0${item.descriptor.contentHash}`)
      .sort(),
  ]);

  return {
    root: packageRoot,
    review: {
      id,
      name: displayName,
      version,
      description,
      ...(publisher ? { publisher } : {}),
      ...(category ? { category } : {}),
      source: { kind: "local", label: path.basename(packageRoot) || id },
      manifestHash,
      mcpServers,
      skills: skills.map((item) => item.descriptor),
      warnings: [],
    },
    skills,
  };
}

async function inspectSkills(packageRoot: string, skillsRoot: string): Promise<InspectedPluginSkill[]> {
  const rootStat = await lstat(skillsRoot).catch((error: unknown) => {
    if (isMissingFile(error)) throw new Error("Plugin skills directory is missing");
    throw error;
  });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Plugin skills path must be a real directory, not a symlink");
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const candidates = entries.filter((entry) => !entry.name.startsWith("."));
  if (candidates.length > MAX_SKILLS) {
    throw new Error(`Plugin package may contain at most ${MAX_SKILLS} skills`);
  }

  const result: InspectedPluginSkill[] = [];
  for (const entry of candidates.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Plugin skill entry ${entry.name} must be a directory`);
    }
    const id = identifier(entry.name, "skill id");
    const skillFile = inside(packageRoot, path.relative(packageRoot, path.join(skillsRoot, entry.name, "SKILL.md")));
    const content = await readBoundedRegularFile(skillFile, MAX_SKILL_BYTES, `skill ${id}`);
    const relativePath = path.relative(packageRoot, skillFile).split(path.sep).join("/");
    const name = skillTitle(content) ?? id;
    const description = skillDescription(content);
    result.push({
      descriptor: {
        id,
        name,
        ...(description ? { description } : {}),
        relativePath,
        contentHash: digest([content]),
        bytes: Buffer.byteLength(content, "utf8"),
      },
      content,
    });
  }
  return result;
}

function parseMcpServers(raw: string): PluginMcpComponentView[] {
  const parsed = parseJsonRecord(raw, "plugin MCP config");
  const config = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  const entries = Object.entries(config);
  if (entries.length > MAX_MCP_SERVERS) {
    throw new Error(`Plugin package may contain at most ${MAX_MCP_SERVERS} MCP servers`);
  }

  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, candidate]) => {
      const id = identifier(name, "MCP server id");
      if (!isRecord(candidate)) throw new Error(`MCP server ${id} configuration is invalid`);
      rejectInlineSecrets(candidate, id);

      if (candidate.type === "http" || candidate.type === "streamable-http" || candidate.url !== undefined) {
        const url = secureHttpsUrl(candidate.url, `MCP server ${id} URL`);
        const auth = candidate.bearer_token_env_var === undefined
          ? "none"
          : environmentVariable(candidate.bearer_token_env_var, `MCP server ${id} bearer token environment variable`) && "bearer-env";
        const normalized = { type: "streamable-http", url, auth };
        return {
          id,
          name: id,
          transport: { kind: "streamable-http", url },
          auth,
          definitionHash: digest([JSON.stringify(normalized)]),
        } satisfies PluginMcpComponentView;
      }

      if (candidate.type === "stdio" || candidate.command !== undefined) {
        const command = boundedText(candidate.command, 1, 1024, `MCP server ${id} command`);
        if (/[/\\]/.test(command) || command.startsWith("-")) {
          throw new Error(`MCP server ${id} command must be a reviewed executable name, not a path`);
        }
        const args = stringArray(candidate.args, `MCP server ${id} args`, MAX_ARGS, MAX_ARG_BYTES);
        const normalized = { type: "stdio", command, args };
        return {
          id,
          name: id,
          transport: { kind: "stdio", command, args },
          auth: "unknown",
          definitionHash: digest([JSON.stringify(normalized)]),
        } satisfies PluginMcpComponentView;
      }

      throw new Error(`MCP server ${id} uses an unsupported transport`);
    });
}

function rejectExecutionFields(manifest: Record<string, unknown>): void {
  const blocked = Object.keys(manifest).find((key) => EXECUTION_FIELDS.has(key.toLowerCase()));
  if (blocked) {
    throw new Error(`Plugin manifest execution field ${blocked} is not supported in Phase 1`);
  }
}

function rejectInlineSecrets(value: Record<string, unknown>, id: string): void {
  for (const key of Object.keys(value)) {
    const normalized = key.toLowerCase();
    if (normalized === "bearer_token_env_var") continue;
    if (/token|secret|password|api[_-]?key|credential/.test(normalized)) {
      throw new Error(`MCP server ${id} must not embed secret field ${key} in the plugin package`);
    }
  }
  if (isRecord(value.env) || isRecord(value.environment) || isRecord(value.headers)) {
    throw new Error(`MCP server ${id} must not embed environment or header values in the plugin package`);
  }
}

function publisherName(
  manifest: Record<string, unknown>,
  interfaceValue: Record<string, unknown> | undefined,
): string | undefined {
  if (typeof manifest.author === "string") {
    return optionalBoundedText(manifest.author, 1, 256, "plugin author");
  }
  if (isRecord(manifest.author) && manifest.author.name !== undefined) {
    return optionalBoundedText(manifest.author.name, 1, 256, "plugin author");
  }
  if (interfaceValue?.developerName !== undefined) {
    return optionalBoundedText(interfaceValue.developerName, 1, 256, "plugin developer name");
  }
  return undefined;
}

function declaredRelativePath(value: unknown, field: string): string {
  const text = boundedText(value, 1, 512, `plugin ${field} path`).replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) {
    throw new Error(`Plugin ${field} path must be relative`);
  }
  const normalized = path.posix.normalize(text.replace(/^\.\//, ""));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Plugin ${field} path escapes the package root`);
  }
  return normalized;
}

function inside(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (!relation || relation === ".") return resolved;
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Plugin package path escapes the package root");
  }
  return resolved;
}

async function readBoundedRegularFile(filePath: string, maxBytes: number, label: string): Promise<string> {
  const stat = await lstat(filePath).catch((error: unknown) => {
    if (isMissingFile(error)) throw new Error(`${label} is missing`);
    throw error;
  });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
  const content = await readFile(filePath, "utf8");
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} byte limit`);
  }
  return content;
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function identifier(value: unknown, label: string): string {
  const text = boundedText(value, 1, 64, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw new Error(`${label} may contain only letters, digits, dot, underscore, and hyphen`);
  }
  return text;
}

function boundedText(value: unknown, min: number, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.trim().length < min ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function optionalBoundedText(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, min, max, label);
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems: number, maxBytes: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  return value.map((item, index) => boundedText(item, 1, maxBytes, `${label}[${index}]`));
}

function secureHttpsUrl(value: unknown, label: string): string {
  const text = boundedText(value, 1, 2048, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be credential-free HTTPS`);
  }
  return parsed.toString();
}

function environmentVariable(value: unknown, label: string): true {
  const text = boundedText(value, 1, 128, label);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(text)) throw new Error(`${label} is invalid`);
  return true;
}

function skillTitle(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  }
  return undefined;
}

function skillDescription(content: string): string | undefined {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "---" || line.startsWith("#") || /^[A-Za-z0-9_-]+:\s*/.test(line)) continue;
    return line.slice(0, 512);
  }
  return undefined;
}

function digest(parts: string[]): string {
  const hash = createHash("sha256");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\0", "utf8");
    hash.update(part, "utf8");
  });
  return hash.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
