import { randomBytes } from "node:crypto";

import type { DesktopRuntimeEvent } from "../shared/desktop-api";
import type {
  McpExtensionActivityQuery,
  McpExtensionActivityView,
  McpExtensionApprovalResult,
  McpExtensionAuthType,
  McpExtensionCredentialInput,
  McpExtensionEnvironmentValue,
  McpExtensionInstallInput,
  McpExtensionOAuthActionResult,
  McpExtensionToolPolicyInput,
  McpExtensionToolView,
  McpExtensionTransport,
  McpExtensionView,
  McpMarketplaceConfigurationField,
  McpMarketplaceInstallRequest,
  McpMarketplaceRollbackResult,
  McpMarketplaceUpdateResult,
  McpToolApproval,
} from "../shared/mcp-extension-api";
import {
  assertMcpEnterpriseExtensionAllowed,
  effectiveMcpEnterpriseToolPolicy,
  evaluateMcpEnterpriseExtension,
  governedExtensionFromInstall,
  governedExtensionFromView,
  loadMcpEnterpriseGovernance,
} from "./mcp-enterprise-governance";
import { planGovernedMcpMarketplaceInstall } from "./mcp-enterprise-marketplace";
import { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import type { EncryptedSecretStore } from "./secure-store";

const SECRET_PREFIX = "mcp-extension:";
const MAX_EXTENSION_ID = 64;
const MAX_TOOL_NAME = 128;
const UPDATE_BACKUP_VERSION = 1;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_ACTIVITY_LIMIT = 500;

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
    let health = parseHealthList(await this.client.health());
    if (await this.enforceEnterpriseGovernance(health)) {
      health = parseHealthList(await this.client.health());
    }
    for (const item of health) {
      if (!item.extension.enabled) continue;
      try {
        await this.restoreEnvironment(item.extension.id);
        await this.restoreRuntimeMaterial(item.extension.id, item.extension.auth_type);
      } catch (error) {
        this.emit(
          "warn",
          `MCP extension ${item.extension.id} secure runtime material restore deferred: ${safeMessage(error)}`,
        );
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.oauth.shutdown();
  }

  async list(): Promise<McpExtensionView[]> {
    let health = parseHealthList(await this.client.health());
    if (await this.enforceEnterpriseGovernance(health)) {
      health = parseHealthList(await this.client.health());
    }
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
      const environmentConfigured = await this.secretStore.hasOpaque(environmentKey(extension.id));
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
        environmentConfigured,
        environmentMaterialized: item.environment_materialized,
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
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromInstall(input), "install");
    const key = input.authType === "none" ? undefined : secretKey(input.id);
    await this.client.install(stripEnvironmentTransportMetadata(input), key);
    try {
      if (input.environment && input.environment.length > 0) {
        await this.saveEnvironment(input.id, input.environment);
      }
      if (input.authType === "oauth" && input.oauth) {
        await this.oauth.saveConfig(input.id, input.oauth);
      }
      if (input.authType === "bearer" && key && input.credential) {
        await this.secretStore.setOpaque(key, input.credential);
        await this.client.materializeCredential(input.id, input.credential);
      }
      await this.restoreEnvironment(input.id);
    } catch (error) {
      await this.client.remove(input.id).catch(() => undefined);
      await this.clearEnvironment(input.id).catch(() => undefined);
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
    const plan = await planGovernedMcpMarketplaceInstall(request.serverName);
    if (plan.blockers.length > 0 || !plan.input) {
      throw new Error(
        `MCP marketplace install requires review: ${plan.blockers.join(" ") || "no safe install plan is available"}`,
      );
    }
    const environment = validateRecipeValues(
      plan.server.configurationFields,
      request.environment ?? [],
    );
    const installed = await this.install({
      ...plan.input,
      ...(environment.length > 0 ? { environment } : {}),
    });
    if (installed.authType === "oauth") {
      await this.connectOAuth(installed.id);
    }
    this.emit("info", `Installed ${request.serverName} from the configured MCP marketplace`);
    return this.requireView(installed.id);
  }

  async updateMarketplace(extensionId: string): Promise<McpMarketplaceUpdateResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    const serverName = registryServerName(current.source);
    const plan = await planGovernedMcpMarketplaceInstall(serverName);
    if (!plan.input || plan.blockers.length > 0) {
      throw new Error(`MCP update cannot be staged safely: ${plan.blockers.join(" ")}`);
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

    const environment = await this.readEnvironment(extensionId);
    validateStoredRecipe(plan.server.configurationFields, environment);
    const snapshot = await this.snapshot(extensionId);
    const nextInput = mergeOAuthClientIdentity(snapshot.input, plan.input);
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromInstall(nextInput), "update");
    const staged = await this.preflightCandidate(nextInput, environment);
    await this.writeUpdateBackup(extensionId, snapshot);

    try {
      await this.swapRegistration(snapshot, nextInput, environment);
      this.emit("info", `Updated MCP extension ${extensionId} ${snapshot.input.version} -> ${nextInput.version}`);
      return {
        extensionId,
        fromVersion: snapshot.input.version,
        toVersion: nextInput.version,
        staged,
        rolledBack: false,
        message: staged
          ? "Candidate initialized under a temporary SourceNerve registration with the same secure environment recipe before activation; the previous registration is retained as a rollback snapshot."
          : "Authenticated candidate was activated behind automatic rollback because its OAuth/bearer identity is not copied into a temporary staging registration.",
      };
    } catch (error) {
      await this.restoreSnapshot(snapshot, environment).catch((rollbackError) => {
        throw new Error(
          `MCP update failed (${safeMessage(error)}) and automatic rollback also failed (${safeMessage(rollbackError)})`,
        );
      });
      this.emit("warn", `MCP extension ${extensionId} update failed and was rolled back`);
      return {
        extensionId,
        fromVersion: snapshot.input.version,
        toVersion: nextInput.version,
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
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromInstall(backup.input), "rollback");
    const current = await this.snapshot(extensionId);
    const environment = await this.readEnvironment(extensionId);
    await this.restoreSnapshot(backup, environment);
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
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromView(current), "enable");
    await this.restoreEnvironment(extensionId);
    await this.restoreRuntimeMaterial(extensionId, current.authType);
    await this.client.enable(extensionId);
    try {
      await this.enforceEnterpriseToolPolicies(extensionId);
    } catch (error) {
      await this.client.disable(extensionId).catch(() => undefined);
      throw error;
    }
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
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromView(current), "restart");
    await this.restoreEnvironment(extensionId);
    await this.restoreRuntimeMaterial(extensionId, current.authType);
    const tools = parseTools(await this.client.restart(extensionId));
    const governed = await this.enforceEnterpriseToolPolicies(extensionId, tools);
    this.emit("info", `Restarted MCP extension ${extensionId}; discovered ${governed.length} tools`);
    return governed;
  }

  async remove(extensionId: string): Promise<{ removed: boolean }> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType === "oauth") await this.oauth.remove(extensionId);
    else await this.secretStore.deleteOpaque(secretKey(extensionId)).catch(() => undefined);
    await this.clearEnvironment(extensionId).catch(() => undefined);
    await this.secretStore.deleteOpaque(updateBackupKey(extensionId)).catch(() => undefined);
    const response = parseRemoved(await this.client.remove(extensionId));
    this.emit("info", `Removed MCP extension ${extensionId}`);
    return response;
  }

  async listTools(extensionId: string): Promise<McpExtensionToolView[]> {
    validateExtensionId(extensionId);
    const tools = parseTools(await this.client.listTools(extensionId));
    return this.enforceEnterpriseToolPolicies(extensionId, tools);
  }

  async listActivity(input: McpExtensionActivityQuery = {}): Promise<McpExtensionActivityView[]> {
    if (input.extensionId !== undefined) validateExtensionId(input.extensionId);
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_ACTIVITY_LIMIT)
    ) {
      throw new Error(`MCP activity limit must be between 1 and ${MAX_ACTIVITY_LIMIT}`);
    }
    return parseActivityList(await this.client.listActivity(input));
  }

  async updateToolPolicy(input: McpExtensionToolPolicyInput): Promise<McpExtensionToolView> {
    validateExtensionId(input.extensionId);
    if (!input.toolName || input.toolName.length > MAX_TOOL_NAME) {
      throw new Error("MCP tool name is invalid");
    }
    if (!isApproval(input.approval)) throw new Error("MCP tool approval mode is invalid");
    const effective = effectiveMcpEnterpriseToolPolicy(
      input.extensionId,
      input.toolName,
      { enabled: input.enabled, approval: input.approval },
    );
    const tool = parseTool(
      await this.client.updateToolPolicy({
        ...input,
        enabled: effective.enabled,
        approval: effective.approval,
      }),
    );
    if (effective.enabled !== input.enabled || effective.approval !== input.approval) {
      this.emit(
        "warn",
        `Enterprise policy overrode ${tool.publicName} to ${effective.enabled ? effective.approval : "disabled"}`,
      );
    } else {
      this.emit(
        "info",
        `Updated ${tool.publicName} policy to ${tool.enabled ? effective.approval : "disabled"}`,
      );
    }
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
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromView(current), "enable");
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

  private async enforceEnterpriseGovernance(health: HealthItem[]): Promise<boolean> {
    const policy = loadMcpEnterpriseGovernance();
    if (!policy.managed) return false;
    let changed = false;
    for (const item of health) {
      const transport = parseTransport(item.extension.transport);
      const decision = evaluateMcpEnterpriseExtension(
        {
          id: item.extension.id,
          version: item.extension.version,
          source: item.extension.source,
          transport: transport.transport,
        },
        policy,
      );
      if (!decision.allowed) {
        if (item.extension.enabled) {
          await this.client.disable(item.extension.id);
          changed = true;
          this.emit(
            "warn",
            `Enterprise policy disabled MCP extension ${item.extension.id}: ${decision.blockers.join(" ")}`,
          );
        }
        continue;
      }
      if (item.extension.enabled) {
        const tools = parseTools(await this.client.listTools(item.extension.id));
        const governed = await this.enforceEnterpriseToolPolicies(item.extension.id, tools, policy);
        if (
          governed.some((tool, index) =>
            tool.enabled !== tools[index]?.enabled || tool.approval !== tools[index]?.approval,
          )
        ) {
          changed = true;
        }
      }
    }
    return changed;
  }

  private async enforceEnterpriseToolPolicies(
    extensionId: string,
    tools?: McpExtensionToolView[],
    policy = loadMcpEnterpriseGovernance(),
  ): Promise<McpExtensionToolView[]> {
    const current = tools ?? parseTools(await this.client.listTools(extensionId));
    if (!policy.managed) return current;
    const result: McpExtensionToolView[] = [];
    for (const tool of current) {
      const effective = effectiveMcpEnterpriseToolPolicy(
        extensionId,
        tool.originalName,
        { enabled: tool.enabled, approval: tool.approval },
        policy,
      );
      if (effective.enabled === tool.enabled && effective.approval === tool.approval) {
        result.push(tool);
        continue;
      }
      result.push(
        parseTool(
          await this.client.updateToolPolicy({
            extensionId,
            toolName: tool.originalName,
            enabled: effective.enabled,
            approval: effective.approval,
          }),
        ),
      );
    }
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

  private async preflightCandidate(
    input: McpExtensionInstallInput,
    environment: McpExtensionEnvironmentValue[],
  ): Promise<boolean> {
    if (input.authType !== "none") return false;
    const suffix = randomBytes(4).toString("hex");
    const stageId = `${input.id.slice(0, 48)}-stage-${suffix}`.slice(0, 64);
    const stageNamespace = `${input.namespace.slice(0, 31)}-stage-${suffix}`.slice(0, 48);
    const stagedInput: McpExtensionInstallInput = {
      ...stripEnvironmentTransportMetadata(input),
      id: stageId,
      namespace: stageNamespace,
      source: `${input.source}:stage`,
      required: false,
    };
    await this.client.install(stagedInput);
    try {
      if (environment.length > 0) {
        await this.client.materializeEnvironment(stageId, environmentRecord(environment));
      }
      await this.client.enable(stageId);
      const tools = parseTools(await this.client.listTools(stageId));
      if (tools.length > 512) throw new Error("staged MCP exposed too many tools");
      return true;
    } finally {
      await this.client.remove(stageId).catch(() => undefined);
      await this.client.clearEnvironment(stageId).catch(() => undefined);
    }
  }

  private async swapRegistration(
    previous: UpdateSnapshot,
    nextInput: McpExtensionInstallInput,
    environment: McpExtensionEnvironmentValue[],
  ): Promise<void> {
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromInstall(nextInput), "update");
    const extensionId = previous.input.id;
    if (previous.enabled) await this.client.disable(extensionId).catch(() => undefined);
    await this.client.remove(extensionId);
    const secretRef = nextInput.authType === "none" ? undefined : secretKey(extensionId);
    await this.client.install(stripEnvironmentTransportMetadata(nextInput), secretRef);
    if (nextInput.authType === "oauth" && nextInput.oauth) {
      await this.oauth.saveConfig(extensionId, nextInput.oauth);
    }
    if (environment.length > 0) {
      await this.client.materializeEnvironment(extensionId, environmentRecord(environment));
    }
    await this.restoreRuntimeMaterial(extensionId, nextInput.authType);
    await this.client.enable(extensionId);
    const discovered = parseTools(await this.client.listTools(extensionId));
    await this.restorePolicies(extensionId, previous.tools, discovered);
    if (!previous.enabled) await this.client.disable(extensionId);
  }

  private async restoreSnapshot(
    snapshot: UpdateSnapshot,
    environment: McpExtensionEnvironmentValue[],
  ): Promise<void> {
    assertMcpEnterpriseExtensionAllowed(governedExtensionFromInstall(snapshot.input), "rollback");
    const extensionId = snapshot.input.id;
    await this.client.disable(extensionId).catch(() => undefined);
    await this.client.remove(extensionId).catch(() => undefined);
    const secretRef = snapshot.input.authType === "none" ? undefined : secretKey(extensionId);
    await this.client.install(stripEnvironmentTransportMetadata(snapshot.input), secretRef);
    if (snapshot.input.authType === "oauth" && snapshot.input.oauth) {
      await this.oauth.saveConfig(extensionId, snapshot.input.oauth);
    }
    if (environment.length > 0) {
      await this.client.materializeEnvironment(extensionId, environmentRecord(environment));
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
      const effective = effectiveMcpEnterpriseToolPolicy(
        extensionId,
        policy.toolName,
        { enabled: policy.enabled, approval: policy.approval },
      );
      await this.client.updateToolPolicy({
        extensionId,
        toolName: policy.toolName,
        enabled: effective.enabled,
        approval: effective.approval,
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

  private async saveEnvironment(
    extensionId: string,
    values: McpExtensionEnvironmentValue[],
  ): Promise<void> {
    const validated = validateEnvironmentValues(values);
    if (validated.length === 0) {
      await this.clearEnvironment(extensionId);
      return;
    }
    await this.secretStore.setOpaque(environmentKey(extensionId), JSON.stringify(validated));
    await this.client.materializeEnvironment(extensionId, environmentRecord(validated));
  }

  private async readEnvironment(extensionId: string): Promise<McpExtensionEnvironmentValue[]> {
    const raw = await this.secretStore.getOpaque(environmentKey(extensionId));
    if (!raw) return [];
    try {
      return validateEnvironmentValues(JSON.parse(raw) as unknown);
    } catch {
      throw new Error(`MCP extension ${extensionId} secure environment recipe is invalid`);
    }
  }

  private async restoreEnvironment(extensionId: string): Promise<void> {
    const values = await this.readEnvironment(extensionId);
    if (values.length > 0) {
      await this.client.materializeEnvironment(extensionId, environmentRecord(values));
    }
  }

  private async clearEnvironment(extensionId: string): Promise<void> {
    await this.client.clearEnvironment(extensionId).catch(() => undefined);
    await this.secretStore.deleteOpaque(environmentKey(extensionId)).catch(() => undefined);
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
    throw new Error("Only marketplace-backed MCP extensions support automatic update/rollback");
  }
  const value = source.slice("registry:".length);
  if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("Installed MCP marketplace source is invalid");
  }
  return value;
}

function secretKey(extensionId: string): string {
  validateExtensionId(extensionId);
  return `${SECRET_PREFIX}${extensionId}:credential`;
}

function environmentKey(extensionId: string): string {
  validateExtensionId(extensionId);
  return `${SECRET_PREFIX}${extensionId}:environment`;
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
  if (input.environment) validateEnvironmentValues(input.environment);
}

function stripEnvironmentTransportMetadata(input: McpExtensionInstallInput): McpExtensionInstallInput {
  if (input.transport.transport !== "stdio" || !input.transport.environment) return input;
  return {
    ...input,
    transport: {
      transport: "stdio",
      command: input.transport.command,
      args: input.transport.args,
    },
  };
}

function validateRecipeValues(
  fields: McpMarketplaceConfigurationField[],
  values: McpExtensionEnvironmentValue[],
): McpExtensionEnvironmentValue[] {
  const validated = validateEnvironmentValues(values);
  const allowed = new Map(fields.map((field) => [field.name, field]));
  for (const value of validated) {
    const field = allowed.get(value.name);
    if (!field) throw new Error(`Environment value ${value.name} is not declared by the MCP Registry recipe`);
    if (field.secret && !value.secret) {
      throw new Error(`Environment value ${value.name} must be stored as a secret`);
    }
  }
  for (const field of fields) {
    if (field.required && !validated.some((value) => value.name === field.name && value.value.length > 0)) {
      throw new Error(`MCP Registry recipe requires ${field.name}`);
    }
  }
  return validated;
}

function validateStoredRecipe(
  fields: McpMarketplaceConfigurationField[],
  values: McpExtensionEnvironmentValue[],
): void {
  const names = new Set(values.map((value) => value.name));
  for (const field of fields) {
    if (field.required && !names.has(field.name)) {
      throw new Error(`MCP update introduces required environment value ${field.name}; review the install recipe before updating`);
    }
  }
}

function validateEnvironmentValues(value: unknown): McpExtensionEnvironmentValue[] {
  if (!Array.isArray(value) || value.length > MAX_ENV_ENTRIES) {
    throw new Error(`MCP extension environment may contain at most ${MAX_ENV_ENTRIES} values`);
  }
  const result: McpExtensionEnvironmentValue[] = [];
  const names = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(item.name) ||
      typeof item.value !== "string" ||
      item.value.length > MAX_ENV_VALUE_BYTES ||
      item.value.includes("\0") ||
      typeof item.secret !== "boolean" ||
      names.has(item.name)
    ) {
      throw new Error("MCP extension environment recipe is invalid");
    }
    names.add(item.name);
    result.push({ name: item.name, value: item.value, secret: item.secret });
  }
  return result;
}

function environmentRecord(values: McpExtensionEnvironmentValue[]): Record<string, string> {
  return Object.fromEntries(values.map((item) => [item.name, item.value]));
}

function mergeOAuthClientIdentity(
  previous: McpExtensionInstallInput,
  next: McpExtensionInstallInput,
): McpExtensionInstallInput {
  if (
    previous.authType !== "oauth" ||
    next.authType !== "oauth" ||
    !previous.oauth?.clientId ||
    !next.oauth ||
    next.oauth.clientId
  ) {
    return next;
  }
  const sameIssuer =
    Boolean(previous.oauth.issuer) &&
    Boolean(next.oauth.issuer) &&
    previous.oauth.issuer === next.oauth.issuer;
  if (!sameIssuer) return next;
  return {
    ...next,
    oauth: { ...next.oauth, clientId: previous.oauth.clientId },
  };
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
    environment_materialized:
      typeof value.environment_materialized === "boolean" ? value.environment_materialized : false,
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
    return {
      transport: "stdio",
      command: value.command,
      args: value.args.map((item) => item as string),
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

const ACTIVITY_RESPONSE_FIELDS = new Set([
  "id",
  "occurred_at",
  "principal_kind",
  "principal_subject",
  "workspace_id",
  "extension_id",
  "extension_version",
  "public_tool",
  "original_tool",
  "schema_hash",
  "policy_decision",
  "approval_decision",
  "result_category",
  "duration_ms",
  "error_category",
  "diagnostic",
]);

function parseActivityList(value: unknown): McpExtensionActivityView[] {
  if (!Array.isArray(value)) throw new Error("MCP extension activity response is invalid");
  if (value.length > MAX_ACTIVITY_LIMIT) {
    throw new Error("MCP extension activity response exceeds the Desktop bound");
  }
  return value.map(parseActivity);
}

function parseActivity(value: unknown): McpExtensionActivityView {
  if (!isRecord(value) || Object.keys(value).some((key) => !ACTIVITY_RESPONSE_FIELDS.has(key))) {
    throw new Error("MCP extension activity item contains unsupported fields");
  }
  if (
    !nonNegativeInteger(value.id) ||
    !nonNegativeInteger(value.occurred_at) ||
    !isPrincipalKind(value.principal_kind) ||
    !boundedActivityText(value.principal_subject, 512) ||
    !boundedActivityText(value.extension_id, 64) ||
    !boundedActivityText(value.extension_version, 64) ||
    !boundedActivityText(value.public_tool, 120) ||
    !boundedActivityText(value.original_tool, 128) ||
    !boundedActivityText(value.schema_hash, 128) ||
    !isActivityPolicyDecision(value.policy_decision) ||
    !isActivityApprovalDecision(value.approval_decision) ||
    !isActivityResultCategory(value.result_category) ||
    !nonNegativeInteger(value.duration_ms) ||
    !nullableBoundedActivityText(value.workspace_id, 128) ||
    !nullableBoundedActivityText(value.error_category, 64) ||
    !nullableBoundedActivityText(value.diagnostic, 256)
  ) {
    throw new Error("MCP extension activity fields are invalid");
  }
  return {
    id: value.id,
    occurredAt: value.occurred_at,
    principalKind: value.principal_kind,
    principalSubject: value.principal_subject,
    ...(typeof value.workspace_id === "string" ? { workspaceId: value.workspace_id } : {}),
    extensionId: value.extension_id,
    extensionVersion: value.extension_version,
    publicTool: value.public_tool,
    originalTool: value.original_tool,
    schemaHash: value.schema_hash,
    policyDecision: value.policy_decision,
    approvalDecision: value.approval_decision,
    resultCategory: value.result_category,
    durationMs: value.duration_ms,
    ...(typeof value.error_category === "string" ? { errorCategory: value.error_category } : {}),
    ...(typeof value.diagnostic === "string" ? { diagnostic: value.diagnostic } : {}),
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

function isPrincipalKind(value: unknown): value is McpExtensionActivityView["principalKind"] {
  return value === "operator" || value === "oauth";
}

function isActivityPolicyDecision(
  value: unknown,
): value is McpExtensionActivityView["policyDecision"] {
  return (
    value === "allow" ||
    value === "blocked" ||
    value === "ask" ||
    value === "authorization-denied" ||
    value === "configuration-error"
  );
}

function isActivityApprovalDecision(
  value: unknown,
): value is McpExtensionActivityView["approvalDecision"] {
  return (
    value === "not-required" ||
    value === "approved" ||
    value === "missing" ||
    value === "not-applicable"
  );
}

function isActivityResultCategory(
  value: unknown,
): value is McpExtensionActivityView["resultCategory"] {
  return (
    value === "success" ||
    value === "denied" ||
    value === "approval-required" ||
    value === "configuration-error" ||
    value === "downstream-error"
  );
}

function nullableBoundedActivityText(value: unknown, max: number): boolean {
  return value === null || value === undefined || boundedActivityText(value, max);
}

function boundedActivityText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
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
  environment_materialized: boolean;
}
