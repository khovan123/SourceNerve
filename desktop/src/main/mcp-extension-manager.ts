import { randomBytes } from "node:crypto";

import type { DesktopRuntimeEvent } from "../shared/desktop-api";
import type {
  McpExtensionApprovalResult,
  McpExtensionAuthType,
  McpExtensionCredentialInput,
  McpExtensionInstallInput,
  McpExtensionOAuthActionResult,
  McpExtensionToolPolicyInput,
  McpExtensionToolView,
  McpExtensionTransport,
  McpExtensionView,
  McpMarketplaceInstallRequest,
  McpMarketplaceRollbackResult,
  McpMarketplaceUpdateResult,
  McpToolApproval,
} from "../shared/mcp-extension-api";
import { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import { planMcpMarketplaceInstall } from "./mcp-marketplace";
import type { EncryptedSecretStore } from "./secure-store";

const SECRET_PREFIX = "mcp-extension:";
const MAX_EXTENSION_ID = 64;
const MAX_TOOL_NAME = 128;
const UPDATE_BACKUP_VERSION = 1;

interface UpdateSnapshot {
  schemaVersion: 1;
  input: McpExtensionInstallInput;
  enabled: boolean;
  tools: Array<{
    toolName: string;
    enabled: boolean;
    approval: McpToolApproval;
  }>;
}

export interface McpExtensionManagerOptions {
  client: McpExtensionClient;
  secretStore: EncryptedSecretStore;
  openExternal?(url: string): Promise<unknown>;
  onEvent?: (event: DesktopRuntimeEvent) => void;
}

export class McpExtensionManager {
  private readonly client: McpExtensionClient;
  private readonly secretStore: EncryptedSecretStore;
  private readonly oauth: McpExtensionOAuthManager;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;

  constructor(options: McpExtensionManagerOptions) {
    this.client = options.client;
    this.secretStore = options.secretStore;
    const openExternal =
      options.openExternal ??
      (async (url: string) => {
        const { shell } = await import("electron");
        return shell.openExternal(url);
      });
    this.oauth = new McpExtensionOAuthManager({
      client: options.client,
      secretStore: options.secretStore,
      openExternal,
    });
    this.onEvent = options.onEvent;
  }

  async initialize(): Promise<void> {
    const health = parseHealthList(await this.client.health());
    for (const item of health) {
      if (!item.extension.enabled) continue;
      try {
        await this.restoreRuntimeMaterial(item.extension.id, item.extension.auth_type);
      } catch (error) {
        this.emit(
          "warn",
          `MCP extension ${item.extension.id} credential restore deferred: ${safeMessage(error)}`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.oauth.shutdown();
  }

  async list(): Promise<McpExtensionView[]> {
    const health = parseHealthList(await this.client.health());
    const result: McpExtensionView[] = [];
    for (const item of health) {
      const extension = item.extension;
      const oauthStatus =
        extension.auth_type === "oauth"
          ? await this.oauth.status(extension.id)
          : { configured: false, connected: false as boolean, expiresAt: undefined };
      const credentialConfigured =
        extension.auth_type !== "none" &&
        (await this.secretStore.hasOpaque(secretKey(extension.id)));
      result.push({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        namespace: extension.namespace,
        source: extension.source,
        transport: parseTransport(extension.transport),
        authType: extension.auth_type,
        status: extension.status,
        enabled: extension.enabled,
        required: extension.required,
        updateChannel: extension.update_channel,
        ...(extension.last_error ? { lastError: extension.last_error } : {}),
        credentialConfigured,
        credentialMaterialized: item.credential_materialized,
        oauthConfigured: oauthStatus.configured,
        oauthConnected: oauthStatus.connected,
        ...(oauthStatus.expiresAt ? { oauthExpiresAt: oauthStatus.expiresAt } : {}),
        discoveredTools: item.discovered_tools,
        exposedTools: item.exposed_tools,
        createdAt: extension.created_at,
        updatedAt: extension.updated_at,
      });
    }
    return result;
  }

  async install(input: McpExtensionInstallInput): Promise<McpExtensionView> {
    validateInstallInput(input);
    if (input.environment && input.environment.length > 0) {
      throw new Error(
        "Registry environment recipes are not materialized by this runtime yet; SourceNerve refuses to install them without a safe environment sandbox",
      );
    }
    const key = input.authType === "none" ? undefined : secretKey(input.id);
    await this.client.install(input, key);
    try {
      if (input.authType === "oauth" && input.oauth) {
        await this.oauth.saveConfig(input.id, input.oauth);
      }
      if (input.authType === "bearer" && key && input.credential) {
        await this.secretStore.setOpaque(key, input.credential);
        await this.client.materializeCredential(input.id, input.credential);
      }
    } catch (error) {
      await this.client.remove(input.id).catch(() => undefined);
      if (input.authType === "oauth") await this.oauth.remove(input.id).catch(() => undefined);
      else if (key) await this.secretStore.deleteOpaque(key).catch(() => undefined);
      throw error;
    }
    this.emit(
      "info",
      `Installed MCP extension ${input.id}; tools remain blocked until explicitly permitted`,
    );
    return this.requireView(input.id);
  }

  async installMarketplace(request: McpMarketplaceInstallRequest): Promise<McpExtensionView> {
    const plan = await planMcpMarketplaceInstall(request.serverName);
    if (plan.blockers.length > 0 || !plan.input) {
      throw new Error(
        `MCP marketplace install requires review: ${plan.blockers.join(" ") || "no safe install plan is available"}`,
      );
    }
    if (plan.server.configurationFields.length > 0) {
      throw new Error(
        "This MCP declares environment configuration. SourceNerve discovered the recipe but will not inject it until the stdio sandbox can materialize only declared environment values.",
      );
    }
    const installed = await this.install(plan.input);
    if (installed.authType === "oauth") {
      await this.connectOAuth(installed.id);
    }
    this.emit("info", `Installed ${request.serverName} from the Official MCP Registry`);
    return this.requireView(installed.id);
  }

  async updateMarketplace(extensionId: string): Promise<McpMarketplaceUpdateResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    const serverName = registryServerName(current.source);
    const plan = await planMcpMarketplaceInstall(serverName);
    if (!plan.input || plan.blockers.length > 0) {
      throw new Error(`MCP update cannot be staged safely: ${plan.blockers.join(" ")}`);
    }
    if (plan.server.configurationFields.length > 0) {
      throw new Error("MCP update requires a reviewed environment recipe and cannot be activated automatically yet");
    }
    if (plan.input.id !== current.id) {
      throw new Error("MCP Registry update resolved to a different SourceNerve extension identity");
    }
    if (plan.server.version === current.version) {
      return {
        extensionId,
        fromVersion: current.version,
        toVersion: current.version,
        staged: false,
        rolledBack: false,
        message: `${current.name} is already on the latest registry version.`,
      };
    }

    const snapshot = await this.snapshot(extensionId);
    const staged = await this.preflightCandidate(plan.input);
    await this.writeUpdateBackup(extensionId, snapshot);

    try {
      await this.swapRegistration(snapshot, plan.input);
      this.emit("info", `Updated MCP extension ${extensionId} ${snapshot.input.version} -> ${plan.input.version}`);
      return {
        extensionId,
        fromVersion: snapshot.input.version,
        toVersion: plan.input.version,
        staged,
        rolledBack: false,
        message: staged
          ? "Candidate initialized in an isolated temporary registration before activation; the previous registration is retained as a rollback snapshot."
          : "Authenticated candidate was activated behind automatic rollback because its credential cannot be copied into a temporary staging identity.",
      };
    } catch (error) {
      await this.restoreSnapshot(snapshot).catch((rollbackError) => {
        throw new Error(
          `MCP update failed (${safeMessage(error)}) and automatic rollback also failed (${safeMessage(rollbackError)})`,
        );
      });
      this.emit("warn", `MCP extension ${extensionId} update failed and was rolled back`);
      return {
        extensionId,
        fromVersion: snapshot.input.version,
        toVersion: plan.input.version,
        staged,
        rolledBack: true,
        message: `Candidate activation failed and SourceNerve restored ${snapshot.input.version}: ${safeMessage(error)}`,
      };
    }
  }

  async rollbackMarketplace(extensionId: string): Promise<McpMarketplaceRollbackResult> {
    validateExtensionId(extensionId);
    const backup = await this.readUpdateBackup(extensionId);
    if (!backup) throw new Error(`MCP extension ${extensionId} does not have a rollback snapshot`);
    const current = await this.snapshot(extensionId);
    await this.restoreSnapshot(backup);
    await this.writeUpdateBackup(extensionId, current);
    this.emit("info", `Rolled back MCP extension ${extensionId} ${current.input.version} -> ${backup.input.version}`);
    return {
      extensionId,
      fromVersion: current.input.version,
      toVersion: backup.input.version,
      message: `Restored ${backup.input.version}. The replaced ${current.input.version} registration is now retained as the next rollback snapshot.`,
    };
  }

  async enable(extensionId: string): Promise<McpExtensionView> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    await this.restoreRuntimeMaterial(extensionId, current.authType);
    await this.client.enable(extensionId);
    this.emit("info", `Enabled MCP extension ${extensionId}`);
    return this.requireView(extensionId);
  }

  async disable(extensionId: string): Promise<McpExtensionView> {
    validateExtensionId(extensionId);
    await this.client.disable(extensionId);
    this.emit("info", `Disabled MCP extension ${extensionId}`);
    return this.requireView(extensionId);
  }

  async restart(extensionId: string): Promise<McpExtensionToolView[]> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    await this.restoreRuntimeMaterial(extensionId, current.authType);
    const tools = parseTools(await this.client.restart(extensionId));
    this.emit("info", `Restarted MCP extension ${extensionId}; discovered ${tools.length} tools`);
    return tools;
  }

  async remove(extensionId: string): Promise<{ removed: boolean }> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType === "oauth") await this.oauth.remove(extensionId);
    else await this.secretStore.deleteOpaque(secretKey(extensionId)).catch(() => undefined);
    await this.secretStore.deleteOpaque(updateBackupKey(extensionId)).catch(() => undefined);
    const response = parseRemoved(await this.client.remove(extensionId));
    this.emit("info", `Removed MCP extension ${extensionId}`);
    return response;
  }

  async listTools(extensionId: string): Promise<McpExtensionToolView[]> {
    validateExtensionId(extensionId);
    return parseTools(await this.client.listTools(extensionId));
  }

  async updateToolPolicy(input: McpExtensionToolPolicyInput): Promise<McpExtensionToolView> {
    validateExtensionId(input.extensionId);
    if (!input.toolName || input.toolName.length > MAX_TOOL_NAME) {
      throw new Error("MCP tool name is invalid");
    }
    if (!isApproval(input.approval)) throw new Error("MCP tool approval mode is invalid");
    const tool = parseTool(await this.client.updateToolPolicy(input));
    this.emit(
      "info",
      `Updated ${tool.publicName} policy to ${tool.enabled ? input.approval : "disabled"}`,
    );
    return tool;
  }

  async setCredential(input: McpExtensionCredentialInput): Promise<{ configured: true }> {
    validateExtensionId(input.extensionId);
    if (
      !input.credential ||
      input.credential.length > 32 * 1024 ||
      input.credential.includes("\0")
    ) {
      throw new Error("MCP extension credential is invalid");
    }
    const current = await this.requireView(input.extensionId);
    if (current.authType !== "bearer") {
      throw new Error(
        "Manual credential storage is only available for bearer-authenticated MCP extensions",
      );
    }
    const key = secretKey(input.extensionId);
    await this.secretStore.setOpaque(key, input.credential);
    try {
      await this.client.materializeCredential(input.extensionId, input.credential);
    } catch (error) {
      await this.secretStore.deleteOpaque(key).catch(() => undefined);
      throw error;
    }
    this.emit("info", `Updated secure credential for MCP extension ${input.extensionId}`);
    return { configured: true };
  }

  async clearCredential(extensionId: string): Promise<{ configured: false }> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "bearer") {
      throw new Error(
        "Manual credential clearing is only available for bearer-authenticated MCP extensions",
      );
    }
    await this.client.clearCredential(extensionId);
    await this.secretStore.deleteOpaque(secretKey(extensionId));
    this.emit("info", `Cleared secure credential for MCP extension ${extensionId}`);
    return { configured: false };
  }

  async approveNext(publicTool: string): Promise<McpExtensionApprovalResult> {
    if (!publicTool || publicTool.length > 120 || /[\r\n\0]/.test(publicTool)) {
      throw new Error("MCP public tool name is invalid");
    }
    const value = parseApproval(await this.client.approveNext(publicTool));
    this.emit(
      "info",
      `Approved one execution of ${publicTool} for ${value.expiresInSeconds}s`,
    );
    return value;
  }

  async connectOAuth(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "oauth") {
      throw new Error("This MCP extension is not configured for OAuth");
    }
    this.emit("info", `Started OAuth PKCE authorization for MCP extension ${extensionId}`);
    const result = await this.oauth.connect(extensionId);
    this.emit("info", `Completed OAuth PKCE authorization for MCP extension ${extensionId}`);
    return result;
  }

  async refreshOAuth(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "oauth") {
      throw new Error("This MCP extension is not configured for OAuth");
    }
    const result = await this.oauth.refresh(extensionId);
    this.emit("info", `Refreshed OAuth token for MCP extension ${extensionId}`);
    return result;
  }

  async revokeOAuth(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "oauth") {
      throw new Error("This MCP extension is not configured for OAuth");
    }
    if (current.enabled) await this.client.disable(extensionId);
    const result = await this.oauth.revoke(extensionId);
    this.emit("info", `Revoked OAuth connection for MCP extension ${extensionId}`);
    return result;
  }

  private async snapshot(extensionId: string): Promise<UpdateSnapshot> {
    const view = await this.requireView(extensionId);
    const oauth = view.authType === "oauth" ? await this.oauth.exportConfig(extensionId) : null;
    if (view.authType === "oauth" && !oauth) {
      throw new Error(`MCP extension ${extensionId} OAuth configuration is unavailable for rollback`);
    }
    const input: McpExtensionInstallInput = {
      id: view.id,
      name: view.name,
      version: view.version,
      namespace: view.namespace,
      source: view.source,
      transport: view.transport,
      authType: view.authType,
      ...(oauth ? { oauth } : {}),
      required: view.required,
      updateChannel: view.updateChannel,
    };
    const tools = await this.listTools(extensionId);
    return {
      schemaVersion: UPDATE_BACKUP_VERSION,
      input,
      enabled: view.enabled,
      tools: tools.map((tool) => ({
        toolName: tool.originalName,
        enabled: tool.enabled,
        approval: tool.approval,
      })),
    };
  }

  private async preflightCandidate(input: McpExtensionInstallInput): Promise<boolean> {
    if (input.authType !== "none") return false;
    const suffix = randomBytes(4).toString("hex");
    const stageId = `${input.id.slice(0, 48)}-stage-${suffix}`.slice(0, 64);
    const stageNamespace = `${input.namespace.slice(0, 31)}-stage-${suffix}`.slice(0, 48);
    const stagedInput: McpExtensionInstallInput = {
      ...input,
      id: stageId,
      namespace: stageNamespace,
      source: `${input.source}:stage`,
      required: false,
    };
    await this.client.install(stagedInput);
    try {
      await this.client.enable(stageId);
      const tools = parseTools(await this.client.listTools(stageId));
      if (tools.length > 512) throw new Error("staged MCP exposed too many tools");
      return true;
    } finally {
      await this.client.remove(stageId).catch(() => undefined);
    }
  }

  private async swapRegistration(
    previous: UpdateSnapshot,
    nextInput: McpExtensionInstallInput,
  ): Promise<void> {
    const extensionId = previous.input.id;
    if (previous.enabled) await this.client.disable(extensionId).catch(() => undefined);
    await this.client.remove(extensionId);
    const secretRef = nextInput.authType === "none" ? undefined : secretKey(extensionId);
    await this.client.install(nextInput, secretRef);
    if (nextInput.authType === "oauth" && nextInput.oauth) {
      await this.oauth.saveConfig(extensionId, nextInput.oauth);
    }
    await this.restoreRuntimeMaterial(extensionId, nextInput.authType);
    await this.client.enable(extensionId);
    const discovered = parseTools(await this.client.listTools(extensionId));
    await this.restorePolicies(extensionId, previous.tools, discovered);
    if (!previous.enabled) await this.client.disable(extensionId);
  }

  private async restoreSnapshot(snapshot: UpdateSnapshot): Promise<void> {
    const extensionId = snapshot.input.id;
    await this.client.disable(extensionId).catch(() => undefined);
    await this.client.remove(extensionId).catch(() => undefined);
    const secretRef = snapshot.input.authType === "none" ? undefined : secretKey(extensionId);
    await this.client.install(snapshot.input, secretRef);
    if (snapshot.input.authType === "oauth" && snapshot.input.oauth) {
      await this.oauth.saveConfig(extensionId, snapshot.input.oauth);
    }
    await this.restoreRuntimeMaterial(extensionId, snapshot.input.authType);
    await this.client.enable(extensionId);
    const discovered = parseTools(await this.client.listTools(extensionId));
    await this.restorePolicies(extensionId, snapshot.tools, discovered);
    if (!snapshot.enabled) await this.client.disable(extensionId);
  }

  private async restorePolicies(
    extensionId: string,
    previous: UpdateSnapshot["tools"],
    discovered: McpExtensionToolView[],
  ): Promise<void> {
    const names = new Set(discovered.map((tool) => tool.originalName));
    for (const policy of previous) {
      if (!names.has(policy.toolName)) continue;
      await this.client.updateToolPolicy({
        extensionId,
        toolName: policy.toolName,
        enabled: policy.enabled,
        approval: policy.approval,
      });
    }
  }

  private async restoreRuntimeMaterial(
    extensionId: string,
    authType: McpExtensionAuthType,
  ): Promise<void> {
    if (authType === "none") return;
    if (authType === "oauth") {
      const restored = await this.oauth.restore(extensionId);
      if (!restored) {
        throw new Error(`MCP extension ${extensionId} requires OAuth Connect before it can be enabled`);
      }
      return;
    }
    const credential = await this.secretStore.getOpaque(secretKey(extensionId));
    if (!credential) {
      throw new Error(`MCP extension ${extensionId} requires a credential before it can be enabled`);
    }
    await this.client.materializeCredential(extensionId, credential);
  }

  private async writeUpdateBackup(extensionId: string, snapshot: UpdateSnapshot): Promise<void> {
    const encoded = JSON.stringify(snapshot);
    if (encoded.length > 512 * 1024) throw new Error("MCP update rollback snapshot exceeds the supported size");
    await this.secretStore.setOpaque(updateBackupKey(extensionId), encoded);
  }

  private async readUpdateBackup(extensionId: string): Promise<UpdateSnapshot | null> {
    const raw = await this.secretStore.getOpaque(updateBackupKey(extensionId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      return parseUpdateSnapshot(value);
    } catch {
      throw new Error(`MCP extension ${extensionId} rollback snapshot is invalid`);
    }
  }

  private async requireView(extensionId: string): Promise<McpExtensionView> {
    const item = (await this.list()).find((extension) => extension.id === extensionId);
    if (!item) throw new Error(`MCP extension ${extensionId} is not registered`);
    return item;
  }

  private emit(level: "info" | "warn", message: string): void {
    this.onEvent?.({
      type: "log",
      component: "desktop",
      level,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}

function registryServerName(source: string): string {
  if (!source.startsWith("registry:")) {
    throw new Error("Only Official MCP Registry extensions support automatic update/rollback");
  }
  const value = source.slice("registry:".length);
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Installed MCP Registry source is invalid");
  }
  return value;
}

function secretKey(extensionId: string): string {
  validateExtensionId(extensionId);
  return `${SECRET_PREFIX}${extensionId}:credential`;
}

function updateBackupKey(extensionId: string): string {
  validateExtensionId(extensionId);
  return `${SECRET_PREFIX}${extensionId}:update-backup`;
}

function validateExtensionId(value: string): void {
  if (!value || value.length > MAX_EXTENSION_ID || !/^[a-z0-9_-]+$/.test(value)) {
    throw new Error("MCP extension id must use lowercase letters, digits, '_' or '-'");
  }
}

function validateInstallInput(input: McpExtensionInstallInput): void {
  validateExtensionId(input.id);
  if (!input.name.trim() || input.name.length > 128) throw new Error("MCP extension name is invalid");
  if (!input.version.trim() || input.version.length > 64) {
    throw new Error("MCP extension version is invalid");
  }
  if (
    !input.namespace ||
    input.namespace === "sourcenerve" ||
    !/^[a-z0-9_-]{1,48}$/.test(input.namespace)
  ) {
    throw new Error("MCP extension namespace is invalid or reserved");
  }
  if (!input.source.trim() || input.source.length > 2048) {
    throw new Error("MCP extension source is invalid");
  }
  if (!isAuthType(input.authType)) throw new Error("MCP extension auth type is invalid");
  parseTransport(input.transport);
  if (input.authType === "bearer" && !input.credential) {
    throw new Error("Bearer-authenticated MCP extensions require a credential at install time");
  }
  if (input.authType === "oauth" && !input.oauth) {
    throw new Error("OAuth MCP extensions require discovered or explicit OAuth configuration");
  }
  if (input.authType !== "oauth" && input.oauth) {
    throw new Error("OAuth configuration is only valid for OAuth MCP extensions");
  }
}

function parseUpdateSnapshot(value: unknown): UpdateSnapshot {
  if (!isRecord(value) || value.schemaVersion !== UPDATE_BACKUP_VERSION || !isRecord(value.input)) {
    throw new Error("rollback snapshot schema is invalid");
  }
  const input = value.input as unknown as McpExtensionInstallInput;
  validateInstallInputForSnapshot(input);
  if (typeof value.enabled !== "boolean" || !Array.isArray(value.tools)) {
    throw new Error("rollback snapshot state is invalid");
  }
  const tools = value.tools.map((tool) => {
    if (
      !isRecord(tool) ||
      typeof tool.toolName !== "string" ||
      tool.toolName.length > MAX_TOOL_NAME ||
      typeof tool.enabled !== "boolean" ||
      !isApproval(tool.approval)
    ) {
      throw new Error("rollback snapshot tool policy is invalid");
    }
    return { toolName: tool.toolName, enabled: tool.enabled, approval: tool.approval };
  });
  return { schemaVersion: 1, input, enabled: value.enabled, tools };
}

function validateInstallInputForSnapshot(input: McpExtensionInstallInput): void {
  const credential = input.credential;
  input.credential = input.authType === "bearer" ? "snapshot-placeholder" : undefined;
  try {
    validateInstallInput(input);
  } finally {
    input.credential = credential;
  }
}

function parseHealthList(value: unknown): HealthItem[] {
  if (!Array.isArray(value)) throw new Error("SourceNerve MCP extension health response is invalid");
  return value.map(parseHealthItem);
}

function parseHealthItem(value: unknown): HealthItem {
  if (!isRecord(value) || !isRecord(value.extension)) {
    throw new Error("MCP extension health item is invalid");
  }
  const extension = parseExtension(value.extension);
  if (
    !nonNegativeInteger(value.discovered_tools) ||
    !nonNegativeInteger(value.exposed_tools) ||
    typeof value.credential_materialized !== "boolean"
  ) {
    throw new Error("MCP extension health counters are invalid");
  }
  return {
    extension,
    discovered_tools: value.discovered_tools,
    exposed_tools: value.exposed_tools,
    credential_materialized: value.credential_materialized,
  };
}

function parseExtension(value: Record<string, unknown>): ExtensionRecordShape {
  const authType = value.auth_type;
  const status = value.status;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.namespace !== "string" ||
    typeof value.source !== "string" ||
    !isAuthType(authType) ||
    !isStatus(status) ||
    typeof value.enabled !== "boolean" ||
    typeof value.required !== "boolean" ||
    typeof value.update_channel !== "string" ||
    typeof value.created_at !== "number" ||
    !Number.isSafeInteger(value.created_at) ||
    typeof value.updated_at !== "number" ||
    !Number.isSafeInteger(value.updated_at) ||
    !isRecord(value.transport)
  ) {
    throw new Error("MCP extension record is invalid");
  }
  return {
    id: value.id,
    name: value.name,
    version: value.version,
    namespace: value.namespace,
    source: value.source,
    transport: value.transport,
    auth_type: authType,
    status,
    enabled: value.enabled,
    required: value.required,
    update_channel: value.update_channel,
    ...(typeof value.last_error === "string" ? { last_error: value.last_error } : {}),
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function parseTransport(value: unknown): McpExtensionTransport {
  if (!isRecord(value)) throw new Error("MCP extension transport is invalid");
  if (
    value.transport === "stdio" &&
    typeof value.command === "string" &&
    Array.isArray(value.args) &&
    value.args.every((item) => typeof item === "string")
  ) {
    const environment =
      Array.isArray(value.environment) && value.environment.every((item) => typeof item === "string")
        ? value.environment.map((item) => item as string)
        : undefined;
    return {
      transport: "stdio",
      command: value.command,
      args: value.args.map((item) => item as string),
      ...(environment && environment.length > 0 ? { environment } : {}),
    };
  }
  if (value.transport === "streamable-http" && typeof value.url === "string") {
    return { transport: "streamable-http", url: value.url };
  }
  throw new Error("MCP extension transport is invalid");
}

function parseTools(value: unknown): McpExtensionToolView[] {
  if (!Array.isArray(value)) throw new Error("MCP extension tool response is invalid");
  return value.map(parseTool);
}

function parseTool(value: unknown): McpExtensionToolView {
  if (!isRecord(value) || !isRecord(value.policy) || !isRecord(value.policy.classification)) {
    throw new Error("MCP extension tool item is invalid");
  }
  if (
    typeof value.extension_id !== "string" ||
    typeof value.original_name !== "string" ||
    typeof value.public_name !== "string" ||
    typeof value.schema_hash !== "string" ||
    typeof value.policy.enabled !== "boolean" ||
    !isApproval(value.policy.approval)
  ) {
    throw new Error("MCP extension tool fields are invalid");
  }
  const classification = value.policy.classification;
  return {
    extensionId: value.extension_id,
    originalName: value.original_name,
    publicName: value.public_name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    schemaHash: value.schema_hash,
    enabled: value.policy.enabled,
    approval: value.policy.approval,
    classification: {
      ...(typeof classification.read_only === "boolean"
        ? { readOnly: classification.read_only }
        : {}),
      ...(typeof classification.destructive === "boolean"
        ? { destructive: classification.destructive }
        : {}),
      ...(typeof classification.idempotent === "boolean"
        ? { idempotent: classification.idempotent }
        : {}),
      ...(typeof classification.open_world === "boolean"
        ? { openWorld: classification.open_world }
        : {}),
    },
  };
}

function parseRemoved(value: unknown): { removed: boolean } {
  if (!isRecord(value) || typeof value.removed !== "boolean") {
    throw new Error("MCP extension remove response is invalid");
  }
  return { removed: value.removed };
}

function parseApproval(value: unknown): McpExtensionApprovalResult {
  if (
    !isRecord(value) ||
    typeof value.public_tool !== "string" ||
    value.approved_once !== true ||
    !nonNegativeInteger(value.expires_in_seconds)
  ) {
    throw new Error("MCP extension approval response is invalid");
  }
  return {
    publicTool: value.public_tool,
    approvedOnce: true,
    expiresInSeconds: value.expires_in_seconds,
  };
}

function isAuthType(value: unknown): value is McpExtensionAuthType {
  return value === "none" || value === "bearer" || value === "oauth";
}

function isStatus(value: unknown): value is McpExtensionView["status"] {
  return (
    value === "installed" ||
    value === "enabled" ||
    value === "disabled" ||
    value === "error" ||
    value === "updating"
  );
}

function isApproval(value: unknown): value is McpToolApproval {
  return value === "automatic" || value === "ask" || value === "blocked";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "operation failed";
  return message.replace(/[\r\n\0]+/g, " ").slice(0, 512);
}

interface ExtensionRecordShape {
  id: string;
  name: string;
  version: string;
  namespace: string;
  source: string;
  transport: Record<string, unknown>;
  auth_type: McpExtensionAuthType;
  status: McpExtensionView["status"];
  enabled: boolean;
  required: boolean;
  update_channel: string;
  last_error?: string;
  created_at: number;
  updated_at: number;
}

interface HealthItem {
  extension: ExtensionRecordShape;
  discovered_tools: number;
  exposed_tools: number;
  credential_materialized: boolean;
}
