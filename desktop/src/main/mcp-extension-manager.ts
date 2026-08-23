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
  McpToolApproval,
} from "../shared/mcp-extension-api";
import { McpExtensionClient } from "./mcp-extension-client";
import { McpExtensionOAuthManager } from "./mcp-extension-oauth";
import type { EncryptedSecretStore } from "./secure-store";

const SECRET_PREFIX = "mcp-extension:";
const MAX_EXTENSION_ID = 64;
const MAX_TOOL_NAME = 128;

export interface McpExtensionManagerOptions {
  client: McpExtensionClient;
  secretStore: EncryptedSecretStore;
  openExternal(url: string): Promise<unknown>;
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
    this.oauth = new McpExtensionOAuthManager({
      client: options.client,
      secretStore: options.secretStore,
      openExternal: options.openExternal,
    });
    this.onEvent = options.onEvent;
  }

  async initialize(): Promise<void> {
    const health = parseHealthList(await this.client.health());
    for (const item of health) {
      if (item.extension.auth_type === "none" || !item.extension.enabled) continue;
      try {
        if (item.extension.auth_type === "oauth") {
          await this.oauth.restore(item.extension.id);
        } else {
          const credential = await this.secretStore.getOpaque(secretKey(item.extension.id));
          if (credential) await this.client.materializeCredential(item.extension.id, credential);
        }
      } catch (error) {
        this.emit(
          "warn",
          `MCP extension ${item.extension.id} credential restore deferred: ${safeMessage(error)}`,
        );
      }
    }
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
    const key = input.authType === "none" ? undefined : secretKey(input.id);
    await this.client.install(input, key);
    try {
      if (input.authType === "oauth" && input.oauth) {
        await this.oauth.saveConfig(input.id, input.oauth);
      }
      if (key && input.credential) {
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

  async enable(extensionId: string): Promise<McpExtensionView> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType === "oauth") {
      const restored = await this.oauth.restore(extensionId);
      if (!restored) {
        throw new Error(`MCP extension ${extensionId} requires OAuth Connect before it can be enabled`);
      }
    } else if (current.authType === "bearer") {
      const credential = await this.secretStore.getOpaque(secretKey(extensionId));
      if (!credential) {
        throw new Error(`MCP extension ${extensionId} requires a credential before it can be enabled`);
      }
      await this.client.materializeCredential(extensionId, credential);
    }
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
    if (current.authType === "oauth") {
      const restored = await this.oauth.restore(extensionId);
      if (!restored) throw new Error(`MCP extension ${extensionId} OAuth connection is unavailable`);
    } else if (current.authType === "bearer") {
      const credential = await this.secretStore.getOpaque(secretKey(extensionId));
      if (!credential) throw new Error(`MCP extension ${extensionId} credential is unavailable`);
      await this.client.materializeCredential(extensionId, credential);
    }
    const tools = parseTools(await this.client.restart(extensionId));
    this.emit("info", `Restarted MCP extension ${extensionId}; discovered ${tools.length} tools`);
    return tools;
  }

  async remove(extensionId: string): Promise<{ removed: boolean }> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType === "oauth") await this.oauth.remove(extensionId);
    else await this.secretStore.deleteOpaque(secretKey(extensionId)).catch(() => undefined);
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
      throw new Error("Manual credential storage is only available for bearer-authenticated MCP extensions");
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
      throw new Error("Manual credential clearing is only available for bearer-authenticated MCP extensions");
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
    if (current.authType !== "oauth") throw new Error("This MCP extension is not configured for OAuth");
    const result = await this.oauth.connect(extensionId);
    this.emit("info", `Started OAuth PKCE authorization for MCP extension ${extensionId}`);
    return result;
  }

  async handleOAuthCallback(callbackUrl: string): Promise<McpExtensionOAuthActionResult> {
    const result = await this.oauth.handleCallback(callbackUrl);
    const current = await this.requireView(result.extensionId);
    if (current.enabled) {
      await this.client.restart(result.extensionId);
    }
    this.emit("info", `Completed OAuth PKCE authorization for MCP extension ${result.extensionId}`);
    return result;
  }

  async refreshOAuth(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "oauth") throw new Error("This MCP extension is not configured for OAuth");
    const result = await this.oauth.refresh(extensionId);
    if (current.enabled) await this.client.restart(extensionId);
    this.emit("info", `Refreshed OAuth token for MCP extension ${extensionId}`);
    return result;
  }

  async revokeOAuth(extensionId: string): Promise<McpExtensionOAuthActionResult> {
    validateExtensionId(extensionId);
    const current = await this.requireView(extensionId);
    if (current.authType !== "oauth") throw new Error("This MCP extension is not configured for OAuth");
    if (current.enabled) await this.client.disable(extensionId);
    const result = await this.oauth.revoke(extensionId);
    this.emit("info", `Revoked OAuth connection for MCP extension ${extensionId}`);
    return result;
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

function secretKey(extensionId: string): string {
  validateExtensionId(extensionId);
  return `${SECRET_PREFIX}${extensionId}:credential`;
}

function validateExtensionId(value: string): void {
  if (!value || value.length > MAX_EXTENSION_ID || !/^[a-z0-9_-]+$/.test(value)) {
    throw new Error("MCP extension id must use lowercase letters, digits, '_' or '-'");
  }
}

function validateInstallInput(input: McpExtensionInstallInput): void {
  validateExtensionId(input.id);
  if (!input.name.trim() || input.name.length > 128) throw new Error("MCP extension name is invalid");
  if (!input.version.trim() || input.version.length > 64) throw new Error("MCP extension version is invalid");
  if (
    !input.namespace ||
    input.namespace === "sourcenerve" ||
    !/^[a-z0-9_-]{1,48}$/.test(input.namespace)
  ) {
    throw new Error("MCP extension namespace is invalid or reserved");
  }
  if (!input.source.trim() || input.source.length > 2048) throw new Error("MCP extension source is invalid");
  if (!isAuthType(input.authType)) throw new Error("MCP extension auth type is invalid");
  parseTransport(input.transport);
  if (input.authType === "bearer" && !input.credential) {
    throw new Error("Bearer-authenticated MCP extensions require a credential at install time");
  }
  if (input.authType === "oauth" && !input.oauth) {
    throw new Error("OAuth MCP extensions require authorization, token, client and scope configuration");
  }
  if (input.authType !== "oauth" && input.oauth) {
    throw new Error("OAuth configuration is only valid for OAuth MCP extensions");
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
