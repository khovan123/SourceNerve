import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  RecoveryActionResult,
  RecoveryReadinessResult,
  RecoveryStateView,
  StateBackupValidationView,
  SupportBundleExportFormat,
  SupportBundlePreview,
} from "../shared/desktop-api";
import type { Auth0Manager } from "./auth0-manager";
import type { DesktopBootstrapState } from "./bootstrap";
import type { CrashMarkerStore } from "./crash-marker-store";
import type { DaemonManager } from "./daemon-manager";
import type { ProviderManager } from "./provider-manager";
import type { PublicMcpManager } from "./public-mcp-manager";
import { sanitizeDiagnosticsText, sanitizeRuntimeText, type RuntimeLogStore } from "./runtime-log-store";
import { readManagedStateLocation } from "./state-location";
import type { SourceNerveClient } from "./sourcenerve-client";
import type { WorkspaceManager } from "./workspace-manager";

const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_PENDING_PREVIEWS = 4;
const MAX_LOG_ENTRIES = 50;
const RECOVERY_STATE_SCHEMA_VERSION = 1 as const;

interface PendingPreview {
  expiresAt: number;
  text: string;
  generatedAt: string;
  sha256: string;
}

interface StoredRecoveryState {
  schemaVersion: typeof RECOVERY_STATE_SCHEMA_VERSION;
  latestBackup?: string;
}

interface BundlePayload {
  payload: Record<string, unknown>;
  knownPaths: string[];
}

export class DiagnosticsManager {
  private readonly pending = new Map<string, PendingPreview>();
  private readonly recoveryStatePath: string;
  private latestBackup?: string;

  constructor(private readonly options: {
    bootstrap: DesktopBootstrapState;
    runtimeInfo(): Record<string, unknown>;
    packaged: boolean;
    homeDirectory?: string;
    daemon(): DaemonManager | null;
    client(): SourceNerveClient | null;
    workspaceManager(): WorkspaceManager | null;
    auth0Manager(): Auth0Manager | null;
    providerManager(): ProviderManager | null;
    publicMcpManager(): PublicMcpManager | null;
    runtimeLogStore(): RuntimeLogStore | null;
    resetDesktopUiSettings(): Promise<void>;
    crashMarkerStore(): CrashMarkerStore | null;
    now?: () => Date;
  }) {
    this.recoveryStatePath = path.join(options.bootstrap.paths.managedDirectory, "recovery-state.json");
  }

  async initialize(): Promise<void> {
    const stored = await readRecoveryState(this.recoveryStatePath);
    this.latestBackup = stored?.latestBackup;
  }

  async previewSupportBundle(): Promise<SupportBundlePreview> {
    this.prunePending();
    if (this.pending.size >= MAX_PENDING_PREVIEWS) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }

    const generatedAt = this.now().toISOString();
    const { payload, knownPaths } = await this.buildBundlePayload(generatedAt);
    const serialized = redactKnownPaths(`${JSON.stringify(payload, null, 2)}\n`, knownPaths);
    const text = sanitizeDiagnosticsText(serialized, this.options.homeDirectory);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const selectionId = randomUUID();
    this.pending.set(selectionId, {
      expiresAt: this.now().getTime() + PREVIEW_TTL_MS,
      text,
      generatedAt,
      sha256,
    });
    return {
      selectionId,
      generatedAt,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256,
      formats: ["text", "zip"],
      text,
    };
  }

  exportBytes(selectionId: string, format: SupportBundleExportFormat): {
    bytes: Buffer;
    suggestedFileName: string;
  } {
    this.prunePending();
    const preview = this.pending.get(selectionId);
    if (!preview) throw new Error("Support bundle preview expired. Generate a new preview before exporting.");
    if (format !== "text" && format !== "zip") throw new Error("Unsupported support bundle format");
    const timestamp = preview.generatedAt.replace(/[:.]/g, "-");
    if (format === "text") {
      return {
        bytes: Buffer.from(preview.text, "utf8"),
        suggestedFileName: `sourcenerve-support-${timestamp}.txt`,
      };
    }
    return {
      bytes: buildSingleFileZip("support-bundle.txt", Buffer.from(preview.text, "utf8"), this.now()),
      suggestedFileName: `sourcenerve-support-${timestamp}.zip`,
    };
  }

  async recoveryState(): Promise<RecoveryStateView> {
    return {
      crash: this.options.crashMarkerStore()?.snapshot() ?? {},
      ...(this.latestBackup ? { latestBackup: this.latestBackup } : {}),
      stateDirectoryHash: pathHash(this.options.bootstrap.paths.stateDirectory),
      logsDirectoryHash: pathHash(path.join(this.options.bootstrap.paths.userData, "logs")),
    };
  }

  async createAndValidateStateBackup(): Promise<StateBackupValidationView> {
    const client = this.requireClient();
    const created = await client.createStateBackup();
    this.latestBackup = created.backup;
    await writeRecoveryState(this.recoveryStatePath, { latestBackup: created.backup });
    return client.validateStateBackup(created.backup);
  }

  async validateLatestStateBackup(): Promise<StateBackupValidationView> {
    if (!this.latestBackup) throw new Error("No SourceNerve state backup has been created from Desktop yet.");
    return this.requireClient().validateStateBackup(this.latestBackup);
  }

  async rebuildManagedIndexes(): Promise<RecoveryActionResult> {
    const manager = this.options.workspaceManager();
    if (!manager) throw new Error("Workspace manager is not initialized");
    const workspaces = await manager.listManagedWorkspaces();
    const ready = workspaces.filter((workspace) => workspace.validation.state === "ready");
    if (ready.length === 0) throw new Error("No ready managed workspaces are available to rebuild.");

    let rebuilt = 0;
    const failures: string[] = [];
    for (const workspace of ready) {
      try {
        await manager.indexWorkspace(workspace.id);
        rebuilt += 1;
      } catch (error) {
        failures.push(`${workspace.id}: ${safeError(error)}`);
      }
    }
    return {
      ok: failures.length === 0,
      message:
        failures.length === 0
          ? `Rebuilt ${rebuilt} managed workspace index${rebuilt === 1 ? "" : "es"}.`
          : `Rebuilt ${rebuilt}/${ready.length} indexes. ${failures.join("; ")}`,
      affectedWorkspaces: rebuilt,
    };
  }

  async resetDesktopUiSettings(): Promise<RecoveryActionResult> {
    await this.options.resetDesktopUiSettings();
    return {
      ok: true,
      message: "Desktop startup/background preferences and OS launch-at-login state were reset to platform defaults.",
      affectedWorkspaces: 0,
    };
  }

  async rerunReadiness(): Promise<RecoveryReadinessResult> {
    const checkedAt = this.now().toISOString();
    const client = this.options.client();
    if (!client) {
      return { checkedAt, health: "unavailable", error: "SourceNerve client is not initialized" };
    }
    try {
      const health = await client.health();
      const [serviceStatus, readiness] = await Promise.all([
        client.serviceStatus(),
        client.readiness(),
      ]);
      return { checkedAt, health: health.status, serviceStatus, readiness };
    } catch (error) {
      return {
        checkedAt,
        health: "unavailable",
        error: sanitizeRuntimeText(safeError(error), this.options.homeDirectory),
      };
    }
  }

  stateDirectory(): string {
    return this.options.bootstrap.paths.stateDirectory;
  }

  logsDirectory(): string {
    return path.join(this.options.bootstrap.paths.userData, "logs");
  }

  private async buildBundlePayload(generatedAt: string): Promise<BundlePayload> {
    const bootstrap = this.options.bootstrap;
    const [localBearer, githubToken, gitlabToken, managedStateLocation] = await Promise.all([
      bootstrap.secretStore.get("localBearer"),
      bootstrap.secretStore.get("githubToken"),
      bootstrap.secretStore.get("gitlabToken"),
      readManagedStateLocation(bootstrap).catch(() => null),
    ]);
    const daemon = this.options.daemon()?.snapshot() ?? null;
    const auth = this.options.auth0Manager()?.state() ?? null;
    const providers = this.options.providerManager()?.states() ?? [];
    const publicMcp = this.options.publicMcpManager()?.state() ?? null;
    const workspaceManager = this.options.workspaceManager();
    const workspaces = workspaceManager
      ? await workspaceManager.listManagedWorkspaces().catch(() => [])
      : [];
    const logs = this.options.runtimeLogStore()?.snapshot();
    const local = await this.rerunReadiness();
    const knownPaths = uniquePaths([
      bootstrap.paths.userData,
      bootstrap.paths.stateDirectory,
      path.join(bootstrap.paths.userData, "logs"),
      bootstrap.paths.configPath,
      bootstrap.paths.workspaceRegistryPath,
      ...workspaces.map((workspace) => workspace.root),
    ]);

    return {
      knownPaths,
      payload: {
        generatedAt,
        supportBundleSchemaVersion: 1,
        runtime: {
          ...this.options.runtimeInfo(),
          packaged: this.options.packaged,
          productChannel: bootstrap.profile.product.channel,
        },
        packageUpdate: {
          channel: bootstrap.profile.product.channel,
          packaged: this.options.packaged,
          updaterIntegrated: false,
        },
        daemon,
        local,
        account: auth
          ? {
              status: auth.status,
              expiresAt: auth.expiresAt,
              scopes: auth.scopes,
              workspaceGrantCount: auth.workspaceGrants?.length ?? 0,
            }
          : null,
        providers: providers.map((provider) => ({
          provider: provider.provider,
          status: provider.status,
          connectedAt: provider.connectedAt,
          error: provider.error,
        })),
        publicMcp: publicMcp
          ? {
              state: publicMcp.state,
              tunnelRunning: publicMcp.tunnelRunning,
              lastCheckedAt: publicMcp.lastCheckedAt,
              hostnameHash: publicMcp.hostname ? shortHash(publicMcp.hostname) : undefined,
              message: publicMcp.message,
            }
          : null,
        configShape: {
          profileSchemaVersion: bootstrap.profile.schemaVersion,
          daemon: { managed: true, loopback: bootstrap.profile.daemon.bind.startsWith("127.0.0.1:") },
          localBearer: localBearer ? "configured" : "missing",
          auth0: { desktopManaged: true, sessionStatus: auth?.status ?? "unavailable" },
          providers: {
            githubCredential: githubToken ? "configured" : "missing",
            gitlabCredential: gitlabToken ? "configured" : "missing",
          },
          publicMcp: {
            routingMode: bootstrap.profile.publicMcp.routingMode,
            cloudflareMode: bootstrap.profile.cloudflare.mode,
          },
          state: {
            strategy: managedStateLocation?.strategy ?? "desktop",
            pathHash: pathHash(bootstrap.paths.stateDirectory),
          },
          workspaceCount: workspaces.length,
        },
        workspaces: workspaces.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          access: workspace.access,
          provider: workspace.provider,
          repository: workspace.repository,
          validation: workspace.validation,
          branch: workspace.branch,
          head: workspace.head,
          dirty: workspace.dirty,
          index: workspace.index,
        })),
        crash: this.options.crashMarkerStore()?.snapshot() ?? {},
        logRetention: logs
          ? {
              droppedEntries: logs.droppedEntries,
              maxEntries: logs.maxEntries,
              maxBytes: logs.maxBytes,
            }
          : null,
        recentLogs: logs?.entries.slice(-MAX_LOG_ENTRIES) ?? [],
      },
    };
  }

  private requireClient(): SourceNerveClient {
    const client = this.options.client();
    if (!client) throw new Error("SourceNerve client is not initialized");
    return client;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private prunePending(): void {
    const now = this.now().getTime();
    for (const [id, preview] of this.pending) {
      if (preview.expiresAt <= now) this.pending.delete(id);
    }
  }
}

export function validateSupportBundleSelectionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export function validateSupportBundleFormat(value: unknown): value is SupportBundleExportFormat {
  return value === "text" || value === "zip";
}

export function buildSingleFileZip(fileName: string, content: Buffer, now: Date): Buffer {
  const name = Buffer.from(fileName, "utf8");
  if (name.length < 1 || name.length > 255) throw new Error("Support bundle ZIP file name is invalid");
  const crc = crc32(content);
  const { date, time } = dosDateTime(now);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + content.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, content, central, name, end]);
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  const date = ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time = (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2);
  return { date, time };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function pathHash(value: string): string {
  return `sha256:${shortHash(path.resolve(value))}`;
}

function redactKnownPaths(value: string, paths: string[]): string {
  let result = value;
  for (const candidate of paths.sort((left, right) => right.length - left.length)) {
    if (candidate.length < 2) continue;
    result = result.split(candidate).join(`[PATH:${shortHash(candidate)}]`);
  }
  return result;
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.filter((value) => path.isAbsolute(value)))];
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 512) : "operation failed";
}

async function readRecoveryState(filePath: string): Promise<StoredRecoveryState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Desktop recovery state exceeds 64 KiB");
    const value = JSON.parse(raw) as Partial<StoredRecoveryState>;
    if (
      value.schemaVersion !== RECOVERY_STATE_SCHEMA_VERSION ||
      (value.latestBackup !== undefined && !isSafeBackupName(value.latestBackup))
    ) {
      throw new Error("unsupported Desktop recovery state schema");
    }
    return value as StoredRecoveryState;
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

async function writeRecoveryState(filePath: string, value: Omit<StoredRecoveryState, "schemaVersion">): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: RECOVERY_STATE_SCHEMA_VERSION, ...value }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(temporary, filePath);
}

function isSafeBackupName(value: string): boolean {
  return /^backups\/sourcenerve-[A-Za-z0-9._-]{1,200}\.sqlite3$/.test(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
