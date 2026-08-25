import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { McpExtensionInstallInput, McpExtensionView } from "../shared/mcp-extension-api";
import type {
  InstalledPluginRecord,
  PluginExploreItem,
  PluginInstallResult,
  PluginMcpComponentView,
  PluginMcpOwnershipRecord,
  PluginPackageReview,
  PluginRegistrySnapshot,
} from "../shared/plugin-hub-api";
import type { McpExtensionManager } from "./mcp-extension-manager";
import { inspectLocalPluginPackage, type InspectedPluginPackage } from "./plugin-package";
import { DesktopPluginRegistry } from "./plugin-registry";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CATALOG_PLUGINS = 128;
const MAX_RUNTIME_SKILL_BYTES = 128 * 1024;

export interface PluginRuntimeSkill {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  publisher?: string;
  skillId: string;
  skillName: string;
  description?: string;
  contentHash: string;
  content: string;
}

export interface PluginRuntimeMaterializer {
  materialize(skills: PluginRuntimeSkill[]): Promise<void>;
}

export interface PluginManagerOptions {
  mcp: McpExtensionManager;
  registryPath: string;
  skillStoreRoot: string;
  repositoryRoot?: string;
  runtime?: PluginRuntimeMaterializer;
}

export class PluginManager {
  private readonly mcp: McpExtensionManager;
  private readonly registry: DesktopPluginRegistry;
  private readonly skillStoreRoot: string;
  private readonly repositoryRoot?: string;
  private readonly runtime?: PluginRuntimeMaterializer;
  private initialized = false;

  constructor(options: PluginManagerOptions) {
    this.mcp = options.mcp;
    this.registry = new DesktopPluginRegistry(options.registryPath);
    this.skillStoreRoot = options.skillStoreRoot;
    this.repositoryRoot = options.repositoryRoot;
    this.runtime = options.runtime;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.registry.initialize();
    await mkdir(this.skillStoreRoot, { recursive: true, mode: 0o700 });
    this.initialized = true;
    await this.materializeRuntime();
  }

  async list(): Promise<PluginRegistrySnapshot> {
    await this.ensureInitialized();
    return this.registry.view();
  }

  async inspectLocal(root: string): Promise<PluginPackageReview> {
    return (await inspectLocalPluginPackage(root)).review;
  }

  async explore(): Promise<PluginExploreItem[]> {
    await this.ensureInitialized();
    if (!this.repositoryRoot) return [];
    const marketplacePath = path.join(this.repositoryRoot, ".agents", "plugins", "marketplace.json");
    let raw: string;
    try {
      raw = await readFile(marketplacePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_CATALOG_BYTES) {
      throw new Error("Plugin marketplace exceeds the Desktop size limit");
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins) || parsed.plugins.length > MAX_CATALOG_PLUGINS) {
      throw new Error("Plugin marketplace has invalid schema");
    }

    const result: PluginExploreItem[] = [];
    for (const candidate of parsed.plugins) {
      if (!isRecord(candidate) || !isRecord(candidate.source)) continue;
      const catalogId = text(candidate.name, 64) ?? "unknown";
      const category = text(candidate.category, 128);
      if (candidate.source.source !== "local" || typeof candidate.source.path !== "string") {
        result.push({
          catalogId,
          sourcePath: String(candidate.source.path ?? candidate.source.source ?? "unsupported"),
          ...(category ? { category } : {}),
          blocker: "Desktop Plugin Marketplace accepts staged declarative packages only until remote package provenance is implemented.",
        });
        continue;
      }
      const sourcePath = safeCatalogPath(this.repositoryRoot, candidate.source.path);
      try {
        const inspected = await inspectLocalPluginPackage(sourcePath);
        result.push({
          catalogId,
          sourcePath,
          ...(category ? { category } : {}),
          review: {
            ...inspected.review,
            source: { kind: "catalog", label: catalogId },
          },
        });
      } catch (error) {
        result.push({
          catalogId,
          sourcePath,
          ...(category ? { category } : {}),
          blocker: safeMessage(error),
        });
      }
    }
    return result;
  }

  async installLocal(root: string, sourceKind: "local" | "catalog" = "local"): Promise<PluginInstallResult> {
    await this.ensureInitialized();
    const inspected = await inspectLocalPluginPackage(root);
    const before = this.registry.view();
    const alreadyInstalled = before.plugins.find((item) => item.id === inspected.review.id);
    if (alreadyInstalled) {
      return {
        plugin: alreadyInstalled,
        createdMcpExtensions: [],
        reusedMcpExtensions: [...alreadyInstalled.mcpExtensionIds],
      };
    }

    const currentExtensions = await this.mcp.list();
    const createdMcpExtensions: string[] = [];
    const reusedMcpExtensions: string[] = [];
    const ownership = before.mcpOwnership.map((item) => ({ ...item, owners: [...item.owners] }));
    const extensionIds: string[] = [];
    let skillsCommitted = false;

    try {
      for (const component of inspected.review.mcpServers) {
        const resolution = await this.ensureMcpComponent(
          inspected.review,
          component,
          currentExtensions,
          ownership,
        );
        extensionIds.push(resolution.extensionId);
        if (resolution.created) createdMcpExtensions.push(resolution.extensionId);
        else reusedMcpExtensions.push(resolution.extensionId);
      }

      await this.commitSkills(inspected);
      skillsCommitted = true;
      const now = Date.now();
      const effectiveSourceKind = sourceKind === "local" && this.repositoryRoot && isInside(this.repositoryRoot, inspected.root)
        ? "catalog"
        : sourceKind;
      const plugin: InstalledPluginRecord = {
        id: inspected.review.id,
        name: inspected.review.name,
        version: inspected.review.version,
        description: inspected.review.description,
        ...(inspected.review.publisher ? { publisher: inspected.review.publisher } : {}),
        ...(inspected.review.category ? { category: inspected.review.category } : {}),
        source: {
          kind: effectiveSourceKind,
          label: effectiveSourceKind === "catalog" ? inspected.review.id : inspected.root,
        },
        status: "enabled",
        enabled: true,
        manifestHash: inspected.review.manifestHash,
        mcpExtensionIds: extensionIds,
        skills: inspected.review.skills,
        installedAt: now,
        updatedAt: now,
      };
      const next: PluginRegistrySnapshot = {
        plugins: [...before.plugins, plugin],
        mcpOwnership: ownership,
      };
      await this.registry.replace(next);
      await this.materializeRuntime();
      return { plugin, createdMcpExtensions, reusedMcpExtensions };
    } catch (error) {
      if (skillsCommitted) await this.removeSkillDirectory(inspected.review.id).catch(() => undefined);
      for (const extensionId of createdMcpExtensions.reverse()) {
        await this.mcp.remove(extensionId).catch(() => undefined);
      }
      await this.registry.replace(before).catch(() => undefined);
      await this.materializeRuntime().catch(() => undefined);
      throw error;
    }
  }

  async enable(pluginId: string): Promise<InstalledPluginRecord> {
    await this.ensureInitialized();
    const before = this.registry.view();
    const plugin = requirePlugin(before, pluginId);
    if (plugin.enabled) return plugin;
    const enabledIds: string[] = [];
    try {
      for (const extensionId of plugin.mcpExtensionIds) {
        const view = (await this.mcp.list()).find((item) => item.id === extensionId);
        if (!view) throw new Error(`Plugin MCP extension ${extensionId} is no longer installed`);
        if (!view.enabled) {
          await this.mcp.enable(extensionId);
          enabledIds.push(extensionId);
        }
      }
      const updated = { ...plugin, enabled: true, status: "enabled" as const, updatedAt: Date.now() };
      await this.registry.replace({
        ...before,
        plugins: before.plugins.map((item) => item.id === pluginId ? updated : item),
      });
      await this.materializeRuntime();
      return updated;
    } catch (error) {
      for (const extensionId of enabledIds.reverse()) {
        if (!isDirectInstall(before, extensionId)) await this.mcp.disable(extensionId).catch(() => undefined);
      }
      throw error;
    }
  }

  async disable(pluginId: string): Promise<InstalledPluginRecord> {
    await this.ensureInitialized();
    const before = this.registry.view();
    const plugin = requirePlugin(before, pluginId);
    if (!plugin.enabled) return plugin;
    const updated = { ...plugin, enabled: false, status: "disabled" as const, updatedAt: Date.now() };
    const next = {
      ...before,
      plugins: before.plugins.map((item) => item.id === pluginId ? updated : item),
    };
    await this.registry.replace(next);
    try {
      for (const extensionId of plugin.mcpExtensionIds) {
        if (isDirectInstall(next, extensionId)) continue;
        if (!hasEnabledOwner(next, extensionId)) {
          await this.mcp.disable(extensionId).catch(() => undefined);
        }
      }
      await this.materializeRuntime();
      return updated;
    } catch (error) {
      await this.registry.replace(before).catch(() => undefined);
      await this.materializeRuntime().catch(() => undefined);
      throw error;
    }
  }

  async remove(pluginId: string): Promise<{ removed: boolean }> {
    await this.ensureInitialized();
    const before = this.registry.view();
    const plugin = before.plugins.find((item) => item.id === pluginId);
    if (!plugin) return { removed: false };

    const nextOwnership: PluginMcpOwnershipRecord[] = [];
    const removable: string[] = [];
    for (const record of before.mcpOwnership) {
      if (!record.owners.includes(pluginId)) {
        nextOwnership.push(record);
        continue;
      }
      const owners = record.owners.filter((owner) => owner !== pluginId);
      if (owners.length === 0) {
        if (!record.directInstall) removable.push(record.extensionId);
      } else {
        nextOwnership.push({ ...record, owners });
      }
    }
    const next: PluginRegistrySnapshot = {
      plugins: before.plugins.filter((item) => item.id !== pluginId),
      mcpOwnership: nextOwnership,
    };

    await this.registry.replace(next);
    try {
      await this.removeSkillDirectory(pluginId);
      for (const extensionId of removable) {
        await this.mcp.remove(extensionId).catch(() => undefined);
      }
      for (const record of next.mcpOwnership) {
        if (!record.directInstall && !hasEnabledOwner(next, record.extensionId)) {
          await this.mcp.disable(record.extensionId).catch(() => undefined);
        }
      }
      await this.materializeRuntime();
      return { removed: true };
    } catch (error) {
      await this.registry.replace(before).catch(() => undefined);
      await this.materializeRuntime().catch(() => undefined);
      throw error;
    }
  }

  private async ensureMcpComponent(
    plugin: PluginPackageReview,
    component: PluginMcpComponentView,
    currentExtensions: McpExtensionView[],
    ownership: PluginMcpOwnershipRecord[],
  ): Promise<{ extensionId: string; created: boolean }> {
    const owned = ownership.find((item) => item.definitionHash === component.definitionHash);
    if (owned) {
      if (!owned.owners.includes(plugin.id)) owned.owners.push(plugin.id);
      const existing = currentExtensions.find((item) => item.id === owned.extensionId);
      if (!existing) throw new Error(`Shared MCP component ${owned.extensionId} is missing`);
      if (!existing.enabled) await this.mcp.enable(existing.id);
      return { extensionId: existing.id, created: false };
    }

    const compatibleExisting = currentExtensions.find((item) =>
      extensionDefinitionHash(item) === component.definitionHash,
    );
    if (compatibleExisting) {
      ownership.push({
        extensionId: compatibleExisting.id,
        definitionHash: component.definitionHash,
        owners: [plugin.id],
        directInstall: !compatibleExisting.source.startsWith("plugin-hub:"),
      });
      if (!compatibleExisting.enabled) await this.mcp.enable(compatibleExisting.id);
      return { extensionId: compatibleExisting.id, created: false };
    }

    if (component.auth === "bearer-env") {
      throw new Error(
        `Plugin MCP ${component.id} requires bearer environment configuration; Phase 1 refuses to copy ambient secrets automatically`,
      );
    }

    const input = installInput(plugin, component);
    const reserved = currentExtensions.find((item) => item.id === input.id || item.namespace === input.namespace);
    if (reserved) {
      if (!sameComponentDefinition(reserved, component)) {
        throw new Error(
          `Plugin MCP ${component.id} conflicts with existing MCP extension ${reserved.id}; remove or rename the conflicting extension before installing this plugin`,
        );
      }
      ownership.push({
        extensionId: reserved.id,
        definitionHash: component.definitionHash,
        owners: [plugin.id],
        directInstall: !reserved.source.startsWith("plugin-hub:"),
      });
      if (!reserved.enabled) await this.mcp.enable(reserved.id);
      return { extensionId: reserved.id, created: false };
    }

    const installed = await this.mcp.install(input);
    await this.mcp.enable(installed.id);
    const tools = await this.mcp.listTools(installed.id);
    try {
      for (const tool of tools) {
        if (!tool.enabled || tool.approval !== "automatic") {
          await this.mcp.updateToolPolicy({
            extensionId: installed.id,
            toolName: tool.originalName,
            enabled: true,
            approval: "automatic",
          });
        }
      }
    } catch (error) {
      await this.mcp.remove(installed.id).catch(() => undefined);
      throw error;
    }
    ownership.push({
      extensionId: installed.id,
      definitionHash: component.definitionHash,
      owners: [plugin.id],
      directInstall: false,
    });
    currentExtensions.push(installed);
    return { extensionId: installed.id, created: true };
  }

  private async commitSkills(inspected: InspectedPluginPackage): Promise<void> {
    const pluginRoot = skillDirectory(this.skillStoreRoot, inspected.review.id);
    const temporary = `${pluginRoot}.tmp-${process.pid}-${Date.now()}`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    try {
      for (const skill of inspected.skills) {
        const bytes = Buffer.byteLength(skill.content, "utf8");
        if (bytes > MAX_RUNTIME_SKILL_BYTES || bytes !== skill.descriptor.bytes) {
          throw new Error(`Plugin skill ${skill.descriptor.id} changed after package inspection`);
        }
        if (hash(skill.content) !== skill.descriptor.contentHash) {
          throw new Error(`Plugin skill ${skill.descriptor.id} content hash changed after inspection`);
        }
        await writeFile(
          path.join(temporary, `${skill.descriptor.id}.md`),
          skill.content,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      await rm(pluginRoot, { recursive: true, force: true });
      await rename(temporary, pluginRoot);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private removeSkillDirectory(pluginId: string): Promise<void> {
    return rm(skillDirectory(this.skillStoreRoot, pluginId), { recursive: true, force: true });
  }

  private async materializeRuntime(): Promise<void> {
    if (!this.runtime) return;
    const snapshot = this.registry.view();
    const skills: PluginRuntimeSkill[] = [];
    for (const plugin of snapshot.plugins.filter((item) => item.enabled)) {
      for (const descriptor of plugin.skills) {
        const content = await readFile(
          path.join(skillDirectory(this.skillStoreRoot, plugin.id), `${descriptor.id}.md`),
          "utf8",
        );
        if (Buffer.byteLength(content, "utf8") > MAX_RUNTIME_SKILL_BYTES) {
          throw new Error(`Managed plugin skill ${plugin.id}/${descriptor.id} exceeds runtime limit`);
        }
        if (hash(content) !== descriptor.contentHash) {
          throw new Error(`Managed plugin skill ${plugin.id}/${descriptor.id} failed integrity validation`);
        }
        skills.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          ...(plugin.publisher ? { publisher: plugin.publisher } : {}),
          skillId: descriptor.id,
          skillName: descriptor.name,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          contentHash: descriptor.contentHash,
          content,
        });
      }
    }
    await this.runtime.materialize(skills);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

function installInput(plugin: PluginPackageReview, component: PluginMcpComponentView): McpExtensionInstallInput {
  const extensionId = managedExtensionId(component);
  const namespace = managedNamespace(component);
  return {
    id: extensionId,
    name: `${plugin.name} · ${component.name}`.slice(0, 128),
    version: plugin.version,
    namespace,
    source: `plugin-hub:${plugin.id}:${component.id}:${component.definitionHash.slice(0, 16)}`,
    transport: component.transport.kind === "streamable-http"
      ? { transport: "streamable-http", url: component.transport.url }
      : { transport: "stdio", command: component.transport.command, args: component.transport.args },
    authType: "none",
    required: false,
    updateChannel: "plugin",
  };
}

function managedExtensionId(component: PluginMcpComponentView): string {
  const prefix = component.id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 38);
  return `plugin-${prefix}-${component.definitionHash.slice(0, 16)}`.slice(0, 64);
}

function managedNamespace(component: PluginMcpComponentView): string {
  const prefix = component.id.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 30);
  return `plugin-${prefix}-${component.definitionHash.slice(0, 8)}`.slice(0, 48);
}

function extensionDefinitionHash(extension: McpExtensionView): string {
  if (extension.transport.transport === "streamable-http") {
    const normalized = {
      type: "streamable-http",
      url: normalizeUrl(extension.transport.url),
      auth: extension.authType === "bearer" ? "bearer-env" : "none",
    };
    return hash(JSON.stringify(normalized));
  }
  const normalized = {
    type: "stdio",
    command: extension.transport.command,
    args: extension.transport.args,
  };
  return hash(JSON.stringify(normalized));
}

function sameComponentDefinition(extension: McpExtensionView, component: PluginMcpComponentView): boolean {
  const expected = component.transport;
  if (expected.kind === "streamable-http") {
    return extension.transport.transport === "streamable-http"
      && normalizeUrl(extension.transport.url) === normalizeUrl(expected.url)
      && (extension.authType === "bearer" ? "bearer-env" : "none") === component.auth;
  }
  if (extension.transport.transport !== "stdio") return false;
  return extension.transport.command === expected.command
    && extension.transport.args.length === expected.args.length
    && extension.transport.args.every((value, index) => value === expected.args[index]);
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function requirePlugin(snapshot: PluginRegistrySnapshot, pluginId: string): InstalledPluginRecord {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pluginId)) throw new Error("Plugin id is invalid");
  const plugin = snapshot.plugins.find((item) => item.id === pluginId);
  if (!plugin) throw new Error(`Plugin ${pluginId} is not installed`);
  return plugin;
}

function hasEnabledOwner(snapshot: PluginRegistrySnapshot, extensionId: string): boolean {
  const owners = snapshot.mcpOwnership.find((item) => item.extensionId === extensionId)?.owners ?? [];
  return snapshot.plugins.some((plugin) => plugin.enabled && owners.includes(plugin.id));
}

function isDirectInstall(snapshot: PluginRegistrySnapshot, extensionId: string): boolean {
  return snapshot.mcpOwnership.find((item) => item.extensionId === extensionId)?.directInstall ?? false;
}

function skillDirectory(root: string, pluginId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pluginId)) throw new Error("Plugin id is invalid");
  const resolved = path.resolve(root, pluginId);
  const relation = path.relative(path.resolve(root), resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Plugin skill path escaped the managed store");
  }
  return resolved;
}

function safeCatalogPath(repositoryRoot: string, value: string): string {
  if (!value || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error("Plugin catalog path is invalid");
  const resolved = path.resolve(repositoryRoot, value);
  const relation = path.relative(path.resolve(repositoryRoot), resolved);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Plugin catalog path escaped the repository root");
  }
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relation = path.relative(path.resolve(root), path.resolve(candidate));
  return relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 1024) : "Plugin package could not be inspected";
}
