import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DesktopRuntimeEvent,
  LegacyImportApplyInput,
  LegacyImportPreview,
  LegacyImportResult,
  LegacyImportStateStrategy,
  LegacyImportWorkspacePreview,
  WorkspaceProvider,
} from "../shared/desktop-api";
import type { DesktopBootstrapState } from "./bootstrap";
import type { DaemonManager } from "./daemon-manager";
import { materializeRuntime, type ManagedWorkspace } from "./runtime-profile";
import {
  readManagedStateLocation,
  stateLocationPath,
  writeManagedStateLocation,
} from "./state-location";
import { inspectRepository, WorkspaceManagerError } from "./workspace-manager";
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from "./workspace-store";

const execFileAsync = promisify(execFile);
const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PENDING_PREVIEWS = 8;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

interface RustLegacyPreview {
  config_path: string;
  workspaces: Array<{
    id: string;
    name: string;
    root: string;
    access: "read-only" | "read-write";
    remote: string;
    default_branch: string;
    provider?: WorkspaceProvider;
    repository?: string;
  }>;
  state: {
    path: string;
    database_exists: boolean;
    schema_version?: number;
    supported_schema_version: number;
    status: "missing" | "compatible" | "future" | "unknown" | "invalid";
    integrity?: string;
    message?: string;
  };
  legacy_product: {
    server_bind: string;
    oauth_issuer?: string;
    oauth_resource?: string;
    allow_operator_bearer: boolean;
  };
  reconnect: {
    local_bearer: boolean;
    auth0: boolean;
    providers: WorkspaceProvider[];
    ignored_inline_bearer: boolean;
    ignored_inline_github_token: boolean;
    shell_environment_inspected: false;
  };
}

interface PendingPreview {
  expiresAt: number;
  configPath: string;
  statePath: string;
  workspaces: ManagedWorkspace[];
  preview: LegacyImportPreview;
}

export class MigrationManager {
  private readonly pending = new Map<string, PendingPreview>();

  constructor(private readonly options: {
    bootstrap: DesktopBootstrapState;
    daemon: DaemonManager;
    daemonBinaryPath: string;
    onEvent: (event: DesktopRuntimeEvent) => void;
    now?: () => number;
  }) {}

  async stage(configPath: string): Promise<LegacyImportPreview> {
    this.prune();
    if (this.pending.size >= MAX_PENDING_PREVIEWS) {
      throw new WorkspaceManagerError("invalid_request", "Too many pending migration previews. Close an older preview and try again.");
    }
    const canonical = await realpath(configPath).catch(() => {
      throw new WorkspaceManagerError("invalid_request", "The selected SourceNerve config is unavailable.");
    });
    if (path.basename(canonical).toLowerCase() !== "sourcenerve.toml") {
      throw new WorkspaceManagerError("invalid_request", "Choose an existing sourcenerve.toml file.");
    }

    const raw = await this.inspectWithRust(canonical);
    const workspaces: ManagedWorkspace[] = [];
    const workspaceViews: LegacyImportWorkspacePreview[] = [];
    const warnings: string[] = [];

    for (const legacy of raw.workspaces) {
      try {
        const inspection = await inspectRepository(
          legacy.root,
          legacy.remote,
          legacy.default_branch,
        );
        if (legacy.access === "read-write" && !inspection.localWritable) {
          throw new Error("repository is not locally writable");
        }
        const provider = inspection.provider ?? legacy.provider;
        const repository = inspection.repository ?? legacy.repository;
        if (legacy.provider && inspection.provider && legacy.provider !== inspection.provider) {
          warnings.push(`${legacy.id}: provider mapping changed from ${legacy.provider} to ${inspection.provider} based on the configured Git remote.`);
        }
        if (legacy.repository && inspection.repository && legacy.repository !== inspection.repository) {
          warnings.push(`${legacy.id}: repository mapping was refreshed from the configured Git remote.`);
        }
        const workspace: ManagedWorkspace = {
          id: legacy.id,
          name: legacy.name,
          root: inspection.root,
          access: legacy.access,
          remote: legacy.remote,
          defaultBranch: legacy.default_branch,
          ...(provider ? { provider } : {}),
          ...(repository ? { repository } : {}),
        };
        workspaces.push(workspace);
        workspaceViews.push({
          ...workspace,
          validation: { state: "ready" },
        });
      } catch (error) {
        workspaceViews.push({
          id: legacy.id,
          name: legacy.name,
          root: legacy.root,
          access: legacy.access,
          remote: legacy.remote,
          defaultBranch: legacy.default_branch,
          ...(legacy.provider ? { provider: legacy.provider } : {}),
          ...(legacy.repository ? { repository: legacy.repository } : {}),
          validation: {
            state: "invalid",
            message: safeMessage(error, "Repository validation failed"),
          },
        });
      }
    }

    warnings.push(...productWarnings(raw, this.options.bootstrap));
    if (raw.reconnect.ignored_inline_bearer) {
      warnings.push("Legacy auth.bearer_token was detected but will be ignored; Desktop keeps its own encrypted local bearer.");
    }
    if (raw.reconnect.ignored_inline_github_token) {
      warnings.push("Legacy github.token was detected but will be ignored; reconnect GitHub through the Desktop provider flow.");
    }

    const desktopStatePath = path.resolve(this.options.bootstrap.paths.userData, "state");
    const legacyStatePath = path.resolve(raw.state.path);
    const sourceIsDesktopState = desktopStatePath === legacyStatePath;
    const selectionId = randomUUID();
    const stateStrategies = allowedStateStrategies(raw.state.status, sourceIsDesktopState);
    const recommendedStrategy: LegacyImportStateStrategy = stateStrategies.includes("copy")
      ? "copy"
      : stateStrategies.includes("reference")
        ? "reference"
        : "fresh";
    const preview: LegacyImportPreview = {
      selectionId,
      configPath: canonical,
      workspaces: workspaceViews,
      state: {
        path: raw.state.path,
        databaseExists: raw.state.database_exists,
        status: raw.state.status,
        ...(raw.state.schema_version !== undefined ? { schemaVersion: raw.state.schema_version } : {}),
        supportedSchemaVersion: raw.state.supported_schema_version,
        ...(raw.state.integrity ? { integrity: raw.state.integrity } : {}),
        ...(raw.state.message ? { message: raw.state.message } : {}),
        allowedStrategies: stateStrategies,
        recommendedStrategy,
      },
      legacyProduct: {
        serverBind: raw.legacy_product.server_bind,
        ...(raw.legacy_product.oauth_issuer ? { oauthIssuer: raw.legacy_product.oauth_issuer } : {}),
        ...(raw.legacy_product.oauth_resource ? { oauthResource: raw.legacy_product.oauth_resource } : {}),
        allowOperatorBearer: raw.legacy_product.allow_operator_bearer,
        warnings,
      },
      reconnect: {
        localBearer: true,
        auth0: raw.reconnect.auth0,
        providers: raw.reconnect.providers,
        shellEnvironmentInspected: false,
      },
      backupRequired: true,
    };
    this.pending.set(selectionId, {
      expiresAt: this.now() + PREVIEW_TTL_MS,
      configPath: canonical,
      statePath: raw.state.path,
      workspaces,
      preview,
    });
    return structuredClone(preview);
  }

  async apply(input: LegacyImportApplyInput): Promise<LegacyImportResult> {
    this.prune();
    const pending = this.pending.get(input.selectionId);
    if (!pending) {
      throw new WorkspaceManagerError("invalid_request", "Migration preview expired. Choose sourcenerve.toml again.");
    }
    if (!pending.preview.state.allowedStrategies.includes(input.stateStrategy)) {
      throw new WorkspaceManagerError("invalid_request", "Selected state migration strategy is not compatible with this legacy state.");
    }
    if (pending.workspaces.length !== pending.preview.workspaces.length) {
      throw new WorkspaceManagerError("invalid_request", "Repair invalid repositories before importing this setup.");
    }
    this.assertDaemonCanMigrate();
    this.pending.delete(input.selectionId);

    const bootstrap = this.options.bootstrap;
    const previousRegistry = await loadWorkspaceRegistry(bootstrap.paths.workspaceRegistryPath);
    const previousStateLocation = await readManagedStateLocation(bootstrap);
    const previousStateDirectory = bootstrap.paths.stateDirectory;
    const desktopStateDirectory = path.join(bootstrap.paths.userData, "state");
    if (
      (input.stateStrategy === "copy" || input.stateStrategy === "move") &&
      path.resolve(pending.statePath) === path.resolve(desktopStateDirectory)
    ) {
      throw new WorkspaceManagerError(
        "invalid_request",
        "Legacy state already uses the Desktop state directory. Choose Reference or Fresh state instead.",
      );
    }
    const backupPath = await this.createBackup(
      pending.configPath,
      pending.statePath,
      previousStateDirectory,
    );
    const wasRunning = this.options.daemon.snapshot().managed && this.options.daemon.snapshot().state === "ready";
    if (wasRunning) await this.options.daemon.stop();

    let importedStateDirectory = desktopStateDirectory;
    let touchedDesktopState = false;
    try {
      if (input.stateStrategy === "reference") {
        importedStateDirectory = pending.statePath;
      } else if (input.stateStrategy === "copy" || input.stateStrategy === "move") {
        await rm(importedStateDirectory, { recursive: true, force: true });
        await copyDirectory(pending.statePath, importedStateDirectory);
        touchedDesktopState = true;
      } else {
        await rm(importedStateDirectory, { recursive: true, force: true });
        await mkdir(importedStateDirectory, { recursive: true, mode: 0o700 });
        touchedDesktopState = true;
      }

      await writeManagedStateLocation(bootstrap, {
        strategy: input.stateStrategy === "fresh" ? "desktop" : input.stateStrategy,
        path: importedStateDirectory,
        ...(input.stateStrategy !== "fresh" ? { sourcePath: pending.statePath } : {}),
      });
      await saveWorkspaceRegistry(bootstrap.paths.workspaceRegistryPath, pending.workspaces);
      await this.applyRuntime(pending.workspaces, importedStateDirectory);

      let sourceStateRemoved = false;
      if (input.stateStrategy === "move" && path.resolve(pending.statePath) !== path.resolve(importedStateDirectory)) {
        try {
          await rm(pending.statePath, { recursive: true, force: false });
          sourceStateRemoved = true;
        } catch {
          // A successful import must not be rolled back merely because the safety copy could not be removed.
        }
      }
      this.options.onEvent({
        type: "state",
        component: "workspace",
        state: "migration-complete",
        message: `${pending.workspaces.length} workspace(s) imported`,
      });
      return {
        importedWorkspaces: pending.workspaces.length,
        stateStrategy: input.stateStrategy,
        statePath: importedStateDirectory,
        backupPath,
        sourceStateRemoved,
        reconnect: pending.preview.reconnect,
        rollback: [
          "Quit SourceNerve Desktop before rollback.",
          `Restore managed files and Desktop state from ${backupPath}.`,
          `A safety copy of the pre-migration legacy state is stored under ${path.join(backupPath, "legacy-state")}.`,
          `The original legacy config remains at ${pending.configPath}.`,
        ],
      };
    } catch (error) {
      await this.restoreBackup({
        backupPath,
        previousRegistry,
        previousStateLocation,
        previousStateDirectory,
        importedStateDirectory: touchedDesktopState ? importedStateDirectory : null,
        legacyStateDirectory: pending.statePath,
        restoreLegacyReference: input.stateStrategy === "reference",
      }).catch(() => undefined);
      throw error;
    }
  }

  private async inspectWithRust(configPath: string): Promise<RustLegacyPreview> {
    try {
      const { stdout } = await execFileAsync(
        this.options.daemonBinaryPath,
        ["--desktop-import-preview", configPath],
        {
          env: {},
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: MAX_PREVIEW_BYTES,
          encoding: "utf8",
        },
      );
      const parsed = JSON.parse(stdout) as RustLegacyPreview;
      validateRustPreview(parsed);
      return parsed;
    } catch (error) {
      throw new WorkspaceManagerError(
        "invalid_request",
        safeMessage(error, "Unable to inspect the selected legacy SourceNerve config."),
      );
    }
  }

  private async createBackup(
    legacyConfigPath: string,
    legacyStateDirectory: string,
    previousStateDirectory: string,
  ): Promise<string> {
    const backupPath = path.join(
      this.options.bootstrap.paths.userData,
      "migration-backups",
      `${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    await mkdir(backupPath, { recursive: true, mode: 0o700 });
    await cp(legacyConfigPath, path.join(backupPath, "legacy-sourcenerve.toml"));
    for (const [source, name] of [
      [this.options.bootstrap.paths.configPath, "managed-sourcenerve.toml"],
      [this.options.bootstrap.paths.workspaceRegistryPath, "workspaces.json"],
      [stateLocationPath(this.options.bootstrap), "state-location.json"],
    ] as const) {
      if (await exists(source)) await cp(source, path.join(backupPath, name));
    }
    if (await isDirectory(legacyStateDirectory)) {
      await copyDirectory(legacyStateDirectory, path.join(backupPath, "legacy-state"));
    }
    if (
      await isDirectory(previousStateDirectory) &&
      path.resolve(previousStateDirectory) !== path.resolve(legacyStateDirectory)
    ) {
      await copyDirectory(previousStateDirectory, path.join(backupPath, "desktop-state"));
    }
    return backupPath;
  }

  private async restoreBackup(input: {
    backupPath: string;
    previousRegistry: ManagedWorkspace[] | null;
    previousStateLocation: Awaited<ReturnType<typeof readManagedStateLocation>>;
    previousStateDirectory: string;
    importedStateDirectory: string | null;
    legacyStateDirectory: string;
    restoreLegacyReference: boolean;
  }): Promise<void> {
    if (this.options.daemon.snapshot().managed && this.options.daemon.snapshot().state !== "stopped") {
      await this.options.daemon.stop().catch(() => undefined);
    }

    const legacyStateBackup = path.join(input.backupPath, "legacy-state");
    if (input.restoreLegacyReference && await isDirectory(legacyStateBackup)) {
      await rm(input.legacyStateDirectory, { recursive: true, force: true });
      await copyDirectory(legacyStateBackup, input.legacyStateDirectory);
    }

    if (
      input.importedStateDirectory &&
      path.resolve(input.importedStateDirectory) !== path.resolve(input.previousStateDirectory)
    ) {
      await rm(input.importedStateDirectory, { recursive: true, force: true });
    }
    const desktopStateBackup = path.join(input.backupPath, "desktop-state");
    const previousEqualsLegacy =
      path.resolve(input.previousStateDirectory) === path.resolve(input.legacyStateDirectory);
    const restoreStateBackup = await isDirectory(desktopStateBackup)
      ? desktopStateBackup
      : previousEqualsLegacy && !input.restoreLegacyReference && await isDirectory(legacyStateBackup)
        ? legacyStateBackup
        : null;
    if (restoreStateBackup) {
      await rm(input.previousStateDirectory, { recursive: true, force: true });
      await copyDirectory(restoreStateBackup, input.previousStateDirectory);
    }
    if (input.previousStateLocation) {
      await writeManagedStateLocation(this.options.bootstrap, input.previousStateLocation);
    } else {
      await rm(stateLocationPath(this.options.bootstrap), { force: true });
      this.options.bootstrap.paths.stateDirectory = input.previousStateDirectory;
    }
    if (input.previousRegistry === null) {
      await rm(this.options.bootstrap.paths.workspaceRegistryPath, { force: true });
    } else {
      await saveWorkspaceRegistry(this.options.bootstrap.paths.workspaceRegistryPath, input.previousRegistry);
    }
    const previousConfig = path.join(input.backupPath, "managed-sourcenerve.toml");
    if (await exists(previousConfig)) {
      await cp(previousConfig, this.options.bootstrap.paths.configPath, { force: true });
    } else {
      await rm(this.options.bootstrap.paths.configPath, { force: true });
    }
  }

  private async applyRuntime(workspaces: ManagedWorkspace[], stateDirectory: string): Promise<void> {
    const bootstrap = this.options.bootstrap;
    const localBearer = await bootstrap.secretStore.get("localBearer");
    if (!localBearer) {
      throw new WorkspaceManagerError("not_ready", "SourceNerve local bootstrap is incomplete.", { retryable: true });
    }
    const [githubToken, gitlabToken] = await Promise.all([
      bootstrap.secretStore.get("githubToken"),
      bootstrap.secretStore.get("gitlabToken"),
    ]);
    const runtime = await materializeRuntime({
      productProfile: bootstrap.profile,
      configPath: bootstrap.paths.configPath,
      stateDirectory,
      localBearer,
      workspaces,
      githubToken,
      gitlabToken,
    });
    this.options.daemon.configure({
      configPath: runtime.configPath,
      environment: runtime.environment,
      redactedSecrets: [
        localBearer,
        ...(githubToken ? [githubToken] : []),
        ...(gitlabToken ? [gitlabToken] : []),
      ],
    });
    const result = await this.options.daemon.start();
    if (result.state !== "ready" || !result.managed) {
      throw new Error("managed SourceNerve daemon did not become ready after migration");
    }
  }

  private assertDaemonCanMigrate(): void {
    const snapshot = this.options.daemon.snapshot();
    if (!snapshot.managed && (snapshot.state === "external" || snapshot.state === "incompatible")) {
      throw new WorkspaceManagerError(
        "not_ready",
        "Stop the external SourceNerve daemon before importing legacy config/state.",
        { retryable: true },
      );
    }
    if (snapshot.state === "starting" || snapshot.state === "stopping") {
      throw new WorkspaceManagerError("not_ready", "SourceNerve daemon is changing state. Retry when it is stable.", { retryable: true });
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, preview] of this.pending) {
      if (preview.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export function allowedStateStrategies(
  status: RustLegacyPreview["state"]["status"],
  sourceIsDesktopState = false,
): LegacyImportStateStrategy[] {
  if (status !== "compatible") return ["fresh"];
  return sourceIsDesktopState
    ? ["reference", "fresh"]
    : ["copy", "move", "reference", "fresh"];
}

function productWarnings(raw: RustLegacyPreview, bootstrap: DesktopBootstrapState): string[] {
  const warnings: string[] = [];
  if (raw.legacy_product.server_bind !== bootstrap.profile.daemon.bind) {
    warnings.push(`Legacy server.bind ${raw.legacy_product.server_bind} will be replaced by the packaged Desktop loopback binding.`);
  }
  if (raw.legacy_product.oauth_issuer && raw.legacy_product.oauth_issuer !== bootstrap.profile.auth0.issuer) {
    warnings.push("Legacy OAuth issuer differs from the packaged SourceNerve account profile and will not be imported.");
  }
  if (raw.legacy_product.oauth_resource && raw.legacy_product.oauth_resource !== bootstrap.profile.auth0.audience) {
    warnings.push("Legacy OAuth resource differs from the packaged Public MCP resource and will not be imported.");
  }
  if (raw.legacy_product.allow_operator_bearer) {
    warnings.push("Legacy OAuth operator-bearer compatibility is disabled by Desktop policy.");
  }
  return warnings;
}

function validateRustPreview(value: RustLegacyPreview): void {
  if (!value || typeof value !== "object" || !Array.isArray(value.workspaces) || value.workspaces.length < 1) {
    throw new Error("legacy import preview is invalid");
  }
  if (!path.isAbsolute(value.config_path) || !path.isAbsolute(value.state?.path)) {
    throw new Error("legacy import preview contains a non-absolute path");
  }
  if (!value.reconnect || value.reconnect.shell_environment_inspected !== false) {
    throw new Error("legacy import preview violated the shell-environment boundary");
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  if (!(await isDirectory(source))) throw new Error("Legacy state directory is unavailable.");
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/[\r\n\t]+/g, " ").slice(0, 512) || fallback;
}
