import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  InstalledPluginRecord,
  PluginHarnessExtensionView,
  PluginHarnessPolicyInterceptorView,
  PluginHarnessSandboxProviderView,
  PluginMcpOwnershipRecord,
  PluginRegistrySnapshot,
} from "../shared/plugin-hub-api";

const REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const MAX_PLUGINS = 128;
const MAX_OWNERSHIP = 512;
const MAX_HARNESS_ITEMS = 64;
const MAX_HARNESS_EVENTS = 32;
const HARNESS_OBSERVER_EVENTS = new Set([
  "tool/requested",
  "tool/approved",
  "tool/started",
  "tool/result",
  "tool/failed",
  "job/started",
  "job/completed",
  "job/failed",
  "approval/requested",
  "approval/resolved",
  "checkpoint/created",
  "run/completed",
  "run/cancelled",
  "run/failed",
  "run/stale",
]);

interface PluginRegistryFile {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  plugins: InstalledPluginRecord[];
  mcpOwnership: PluginMcpOwnershipRecord[];
}

export class DesktopPluginRegistry {
  private snapshot: PluginRegistrySnapshot = { plugins: [], mcpOwnership: [] };

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    const loaded = await loadPluginRegistry(this.filePath);
    this.snapshot = loaded ?? { plugins: [], mcpOwnership: [] };
  }

  view(): PluginRegistrySnapshot {
    return structuredClone(this.snapshot);
  }

  async replace(snapshot: PluginRegistrySnapshot): Promise<void> {
    const validated = validateRegistry({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      plugins: snapshot.plugins,
      mcpOwnership: snapshot.mcpOwnership,
    });
    await savePluginRegistry(this.filePath, validated);
    this.snapshot = {
      plugins: structuredClone(validated.plugins),
      mcpOwnership: structuredClone(validated.mcpOwnership),
    };
  }
}

export async function loadPluginRegistry(filePath: string): Promise<PluginRegistrySnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Desktop plugin registry exceeds 2 MiB limit");
  }
  const parsed = JSON.parse(raw) as unknown;
  const validated = validateRegistry(parsed);
  return {
    plugins: validated.plugins,
    mcpOwnership: validated.mcpOwnership,
  };
}

async function savePluginRegistry(filePath: string, registry: PluginRegistryFile): Promise<void> {
  const content = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) {
    throw new Error("Desktop plugin registry exceeds 2 MiB limit");
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function validateRegistry(value: unknown): PluginRegistryFile {
  if (!isRecord(value) || value.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error("Desktop plugin registry has invalid schema");
  }
  if (!Array.isArray(value.plugins) || value.plugins.length > MAX_PLUGINS) {
    throw new Error(`Desktop plugin registry exceeds ${MAX_PLUGINS} plugin limit`);
  }
  if (!Array.isArray(value.mcpOwnership) || value.mcpOwnership.length > MAX_OWNERSHIP) {
    throw new Error(`Desktop plugin registry exceeds ${MAX_OWNERSHIP} MCP ownership limit`);
  }

  const pluginIds = new Set<string>();
  const plugins = value.plugins.map((candidate) => validatePlugin(candidate, pluginIds));
  const ownershipIds = new Set<string>();
  const mcpOwnership = value.mcpOwnership.map((candidate) =>
    validateOwnership(candidate, ownershipIds, pluginIds),
  );
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, plugins, mcpOwnership };
}

function validatePlugin(value: unknown, ids: Set<string>): InstalledPluginRecord {
  if (!isRecord(value)) throw new Error("Desktop plugin registry item is invalid");
  const id = identifier(value.id, 64, "plugin id");
  if (ids.has(id)) throw new Error(`duplicate plugin id: ${id}`);
  ids.add(id);
  const status = value.status;
  if (!isPluginStatus(status)) throw new Error(`invalid plugin status: ${id}`);
  if (typeof value.enabled !== "boolean") throw new Error(`invalid plugin enabled flag: ${id}`);
  const source = validateSource(value.source, id);
  const mcpExtensionIds = stringList(value.mcpExtensionIds, 64, 128, `plugin ${id} MCP ids`);
  const skills = validateSkills(value.skills, id);
  const harness = value.harness === undefined ? undefined : validateHarness(value.harness, id, skills, mcpExtensionIds);
  const installedAt = timestamp(value.installedAt, `plugin ${id} installedAt`);
  const updatedAt = timestamp(value.updatedAt, `plugin ${id} updatedAt`);
  return {
    id,
    name: boundedText(value.name, 1, 128, `plugin ${id} name`),
    version: boundedText(value.version, 1, 64, `plugin ${id} version`),
    description: boundedText(value.description, 1, 4096, `plugin ${id} description`),
    ...(value.publisher !== undefined
      ? { publisher: boundedText(value.publisher, 1, 256, `plugin ${id} publisher`) }
      : {}),
    ...(value.category !== undefined
      ? { category: boundedText(value.category, 1, 128, `plugin ${id} category`) }
      : {}),
    source,
    status,
    enabled: value.enabled,
    manifestHash: sha256(value.manifestHash, `plugin ${id} manifest hash`),
    mcpExtensionIds,
    skills,
    ...(harness ? { harness } : {}),
    installedAt,
    updatedAt,
  };
}

function validateHarness(
  value: unknown,
  pluginId: string,
  skills: InstalledPluginRecord["skills"],
  mcpExtensionIds: string[],
): PluginHarnessExtensionView {
  if (!isRecord(value)) throw new Error(`plugin ${pluginId} Harness extension is invalid`);
  const skillIds = new Set(skills.map((skill) => skill.id));
  const policyInterceptors: PluginHarnessPolicyInterceptorView[] = itemArray(
    value.policyInterceptors,
    `plugin ${pluginId} Harness policies`,
  ).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`plugin ${pluginId} Harness policy is invalid`);
    const id = identifier(candidate.id, 64, `plugin ${pluginId} Harness policy id`);
    if (!isRecord(candidate.target)) throw new Error(`plugin ${pluginId} Harness policy ${id} target is invalid`);
    const kind = candidate.target.kind;
    const target = kind === "skill"
      ? (() => {
          const skillId = identifier(candidate.target.skillId, 64, `plugin ${pluginId} Harness policy ${id} skill`);
          if (!skillIds.has(skillId)) throw new Error(`plugin ${pluginId} Harness policy ${id} references unknown skill`);
          return { kind: "skill" as const, skillId };
        })()
      : kind === "mcp"
        ? (() => {
            if (mcpExtensionIds.length === 0) throw new Error(`plugin ${pluginId} Harness MCP policy has no MCP component`);
            return { kind: "mcp" as const };
          })()
        : (() => { throw new Error(`plugin ${pluginId} Harness policy ${id} target is invalid`); })();
    if (candidate.decision !== "ask" && candidate.decision !== "deny") {
      throw new Error(`plugin ${pluginId} Harness policy ${id} cannot weaken central policy`);
    }
    const decision: "ask" | "deny" = candidate.decision;
    return { id, target, decision };
  });
  const jobProviders = itemArray(value.jobProviders, `plugin ${pluginId} Harness job providers`).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`plugin ${pluginId} Harness job provider is invalid`);
    const id = identifier(candidate.id, 64, `plugin ${pluginId} Harness job provider id`);
    if (candidate.runtime !== "harness-job") throw new Error(`plugin ${pluginId} Harness job provider ${id} runtime is invalid`);
    return { id, runtime: "harness-job" as const };
  });
  const sandboxProviders: PluginHarnessSandboxProviderView[] = itemArray(
    value.sandboxProviders,
    `plugin ${pluginId} Harness sandbox providers`,
  ).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`plugin ${pluginId} Harness sandbox provider is invalid`);
    const id = identifier(candidate.id, 64, `plugin ${pluginId} Harness sandbox provider id`);
    if (!Array.isArray(candidate.modes) || candidate.modes.length === 0 || candidate.modes.length > 2) {
      throw new Error(`plugin ${pluginId} Harness sandbox provider ${id} modes are invalid`);
    }
    const modes: Array<"read-only" | "workspace-write"> = candidate.modes.map((mode) => {
      if (mode !== "read-only" && mode !== "workspace-write") throw new Error(`plugin ${pluginId} Harness sandbox provider ${id} mode is invalid`);
      return mode;
    });
    if (new Set(modes).size !== modes.length) throw new Error(`plugin ${pluginId} Harness sandbox provider ${id} modes duplicate`);
    if (candidate.enforcement !== "partial" && candidate.enforcement !== "unavailable") {
      throw new Error(`plugin ${pluginId} Harness sandbox provider ${id} enforcement is invalid`);
    }
    const enforcement: "partial" | "unavailable" = candidate.enforcement;
    return { id, modes, enforcement };
  });
  const contextProviders = itemArray(value.contextProviders, `plugin ${pluginId} Harness context providers`).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`plugin ${pluginId} Harness context provider is invalid`);
    const id = identifier(candidate.id, 64, `plugin ${pluginId} Harness context provider id`);
    const skillId = identifier(candidate.skillId, 64, `plugin ${pluginId} Harness context provider ${id} skill`);
    if (!skillIds.has(skillId)) throw new Error(`plugin ${pluginId} Harness context provider ${id} references unknown skill`);
    return { id, skillId };
  });
  const eventObservers = itemArray(value.eventObservers, `plugin ${pluginId} Harness event observers`).map((candidate) => {
    if (!isRecord(candidate)) throw new Error(`plugin ${pluginId} Harness event observer is invalid`);
    const id = identifier(candidate.id, 64, `plugin ${pluginId} Harness event observer id`);
    if (candidate.mode !== "sanitized-metadata") throw new Error(`plugin ${pluginId} Harness event observer ${id} mode is invalid`);
    if (!Array.isArray(candidate.events) || candidate.events.length === 0 || candidate.events.length > MAX_HARNESS_EVENTS) {
      throw new Error(`plugin ${pluginId} Harness event observer ${id} events are invalid`);
    }
    const events = candidate.events.map((event) => {
      const text = boundedText(event, 1, 64, `plugin ${pluginId} Harness observer ${id} event`);
      if (!HARNESS_OBSERVER_EVENTS.has(text)) throw new Error(`plugin ${pluginId} Harness observer ${id} event is invalid`);
      return text;
    });
    if (new Set(events).size !== events.length) throw new Error(`plugin ${pluginId} Harness event observer ${id} events duplicate`);
    return { id, events, mode: "sanitized-metadata" as const };
  });

  const registrationIds = [
    ...policyInterceptors.map((item) => `policy:${item.id}`),
    ...jobProviders.map((item) => `job:${item.id}`),
    ...sandboxProviders.map((item) => `sandbox:${item.id}`),
    ...contextProviders.map((item) => `context:${item.id}`),
    ...eventObservers.map((item) => `observer:${item.id}`),
  ];
  if (new Set(registrationIds).size !== registrationIds.length) {
    throw new Error(`plugin ${pluginId} Harness registrations contain duplicates`);
  }

  return {
    configHash: sha256(value.configHash, `plugin ${pluginId} Harness config hash`),
    policyInterceptors,
    jobProviders,
    sandboxProviders,
    contextProviders,
    eventObservers,
  };
}

function itemArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_HARNESS_ITEMS) throw new Error(`${label} are invalid`);
  return value;
}

function validateOwnership(
  value: unknown,
  ids: Set<string>,
  pluginIds: Set<string>,
): PluginMcpOwnershipRecord {
  if (!isRecord(value)) throw new Error("Desktop plugin MCP ownership item is invalid");
  const extensionId = identifier(value.extensionId, 64, "MCP ownership extension id");
  if (ids.has(extensionId)) throw new Error(`duplicate MCP ownership extension id: ${extensionId}`);
  ids.add(extensionId);
  if (typeof value.directInstall !== "boolean") {
    throw new Error(`invalid direct-install marker: ${extensionId}`);
  }
  const owners = stringList(value.owners, MAX_PLUGINS, 64, `MCP ownership ${extensionId} owners`);
  for (const owner of owners) {
    if (!pluginIds.has(owner)) throw new Error(`MCP ownership ${extensionId} references unknown plugin ${owner}`);
  }
  return {
    extensionId,
    definitionHash: sha256(value.definitionHash, `MCP ownership ${extensionId} definition hash`),
    owners,
    directInstall: value.directInstall,
  };
}

function validateSkills(value: unknown, pluginId: string): InstalledPluginRecord["skills"] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`plugin ${pluginId} has invalid skills`);
  }
  const ids = new Set<string>();
  return value.map((skill) => {
    if (!isRecord(skill)) throw new Error(`plugin ${pluginId} skill is invalid`);
    const id = identifier(skill.id, 64, `plugin ${pluginId} skill id`);
    if (ids.has(id)) throw new Error(`plugin ${pluginId} has duplicate skill ${id}`);
    ids.add(id);
    const bytes = integer(skill.bytes, 0, 128 * 1024, `plugin ${pluginId} skill ${id} bytes`);
    return {
      id,
      name: boundedText(skill.name, 1, 128, `plugin ${pluginId} skill ${id} name`),
      ...(skill.description !== undefined
        ? { description: boundedText(skill.description, 1, 512, `plugin ${pluginId} skill ${id} description`) }
        : {}),
      relativePath: safeRelativePath(skill.relativePath, `plugin ${pluginId} skill ${id} path`),
      contentHash: sha256(skill.contentHash, `plugin ${pluginId} skill ${id} hash`),
      bytes,
    };
  });
}

function validateSource(value: unknown, pluginId: string): InstalledPluginRecord["source"] {
  if (!isRecord(value)) throw new Error(`plugin ${pluginId} source is invalid`);
  if (!matches(value.kind, ["local", "catalog", "github", "https"])) {
    throw new Error(`plugin ${pluginId} source kind is invalid`);
  }
  return {
    kind: value.kind,
    label: boundedText(value.label, 1, 1024, `plugin ${pluginId} source label`),
  };
}

function isPluginStatus(value: unknown): value is InstalledPluginRecord["status"] {
  return matches(value, ["installed", "enabled", "disabled", "error", "updating"]);
}

function stringList(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} is invalid`);
  const seen = new Set<string>();
  return value.map((item) => {
    const text = identifier(item, maxLength, label);
    if (seen.has(text)) throw new Error(`${label} contains duplicate ${text}`);
    seen.add(text);
    return text;
  });
}

function safeRelativePath(value: unknown, label: string): string {
  const text = boundedText(value, 1, 512, label).replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:\//.test(text)) throw new Error(`${label} must be relative`);
  const normalized = path.posix.normalize(text);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} escapes the managed root`);
  }
  return normalized;
}

function identifier(value: unknown, max: number, label: string): string {
  const text = boundedText(value, 1, max, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(`${label} is invalid`);
  return text;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
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

function matches<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
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
