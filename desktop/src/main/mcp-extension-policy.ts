import {
  MCP_EXTENSION_IPC,
  type McpExtensionCredentialInput,
  type McpExtensionInstallInput,
  type McpExtensionOAuthConfig,
  type McpExtensionToolPolicyInput,
  type McpMarketplaceSearchInput,
} from "../shared/mcp-extension-api";

export const MCP_EXTENSION_INBOUND_IPC_CHANNELS = Object.freeze(
  Object.values(MCP_EXTENSION_IPC),
);

const NO_ARGUMENT_CHANNELS = new Set<string>([MCP_EXTENSION_IPC.list]);

export function validateMcpExtensionIpcInvocation(
  channel: string,
  args: readonly unknown[],
): string | null {
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    return args.length === 0 ? null : "MCP extension operation does not accept arguments";
  }
  if (channel === MCP_EXTENSION_IPC.install) {
    return args.length === 1 && isInstallInput(args[0])
      ? null
      : "MCP extension install payload is invalid";
  }
  if (channel === MCP_EXTENSION_IPC.marketplaceSearch) {
    return args.length === 1 && isMarketplaceSearchInput(args[0])
      ? null
      : "MCP marketplace search payload is invalid";
  }
  if (channel === MCP_EXTENSION_IPC.marketplacePlan) {
    return args.length === 1 && isRegistryServerName(args[0])
      ? null
      : "MCP marketplace server name is invalid";
  }
  if (
    channel === MCP_EXTENSION_IPC.enable ||
    channel === MCP_EXTENSION_IPC.disable ||
    channel === MCP_EXTENSION_IPC.restart ||
    channel === MCP_EXTENSION_IPC.remove ||
    channel === MCP_EXTENSION_IPC.tools ||
    channel === MCP_EXTENSION_IPC.credentialClear ||
    channel === MCP_EXTENSION_IPC.oauthConnect ||
    channel === MCP_EXTENSION_IPC.oauthRefresh ||
    channel === MCP_EXTENSION_IPC.oauthRevoke
  ) {
    return args.length === 1 && isExtensionId(args[0])
      ? null
      : "MCP extension id is invalid";
  }
  if (channel === MCP_EXTENSION_IPC.toolPolicy) {
    return args.length === 1 && isToolPolicyInput(args[0])
      ? null
      : "MCP extension tool policy payload is invalid";
  }
  if (channel === MCP_EXTENSION_IPC.credentialSet) {
    return args.length === 1 && isCredentialInput(args[0])
      ? null
      : "MCP extension credential payload is invalid";
  }
  if (channel === MCP_EXTENSION_IPC.approveNext) {
    return args.length === 1 && isPublicToolName(args[0])
      ? null
      : "MCP extension public tool name is invalid";
  }
  return "MCP extension IPC channel is not allowlisted";
}

function isInstallInput(value: unknown): value is McpExtensionInstallInput {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "id",
    "name",
    "version",
    "namespace",
    "source",
    "transport",
    "authType",
    "credential",
    "oauth",
    "required",
    "updateChannel",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!isExtensionId(value.id)) return false;
  if (!boundedText(value.name, 1, 128)) return false;
  if (!boundedText(value.version, 1, 64)) return false;
  if (!isNamespace(value.namespace)) return false;
  if (!boundedText(value.source, 1, 2048)) return false;
  if (!isTransport(value.transport)) return false;
  if (!isAuthType(value.authType)) return false;
  if (value.credential !== undefined && !isCredential(value.credential)) return false;
  if (value.authType === "bearer" && !isCredential(value.credential)) return false;
  if (value.authType === "oauth" && !isOAuthConfig(value.oauth)) return false;
  if (value.authType !== "oauth" && value.oauth !== undefined) return false;
  if (value.required !== undefined && typeof value.required !== "boolean") return false;
  if (
    value.updateChannel !== undefined &&
    (typeof value.updateChannel !== "string" ||
      !/^[a-z0-9_-]{1,32}$/.test(value.updateChannel))
  ) {
    return false;
  }
  return true;
}

function isMarketplaceSearchInput(value: unknown): value is McpMarketplaceSearchInput {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["query", "limit"].includes(key))) return false;
  if (
    typeof value.query !== "string" ||
    value.query.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(value.query)
  ) {
    return false;
  }
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 50)
  ) {
    return false;
  }
  return true;
}

function isToolPolicyInput(value: unknown): value is McpExtensionToolPolicyInput {
  if (!isRecord(value)) return false;
  const allowed = new Set(["extensionId", "toolName", "enabled", "approval"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return (
    isExtensionId(value.extensionId) &&
    boundedText(value.toolName, 1, 128) &&
    typeof value.enabled === "boolean" &&
    isApproval(value.approval)
  );
}

function isCredentialInput(value: unknown): value is McpExtensionCredentialInput {
  if (!isRecord(value)) return false;
  const allowed = new Set(["extensionId", "credential"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return isExtensionId(value.extensionId) && isCredential(value.credential);
}

function isTransport(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.transport === "stdio") {
    if (Object.keys(value).some((key) => !["transport", "command", "args"].includes(key))) return false;
    return (
      typeof value.command === "string" &&
      value.command.length >= 1 &&
      value.command.length <= 1024 &&
      /^[\x20-\x7e]+$/.test(value.command) &&
      Array.isArray(value.args) &&
      value.args.length <= 64 &&
      value.args.every(
        (item) =>
          typeof item === "string" &&
          item.length <= 1024 &&
          !/[\u0000-\u001f\u007f]/.test(item),
      )
    );
  }
  if (value.transport === "streamable-http") {
    if (Object.keys(value).some((key) => !["transport", "url"].includes(key))) return false;
    if (typeof value.url !== "string" || value.url.length > 2048) return false;
    try {
      const url = new URL(value.url);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  }
  return false;
}

function isOAuthConfig(value: unknown): value is McpExtensionOAuthConfig {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "authorizationEndpoint",
    "tokenEndpoint",
    "clientId",
    "scopes",
    "revokeEndpoint",
    "resource",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!isHttpsUrl(value.authorizationEndpoint) || !isHttpsUrl(value.tokenEndpoint)) return false;
  if (!boundedText(value.clientId, 1, 512)) return false;
  if (
    !Array.isArray(value.scopes) ||
    value.scopes.length < 1 ||
    value.scopes.length > 32 ||
    !value.scopes.every(
      (scope) => typeof scope === "string" && /^[A-Za-z0-9:._/-]{1,128}$/.test(scope),
    )
  ) {
    return false;
  }
  if (value.revokeEndpoint !== undefined && !isHttpsUrl(value.revokeEndpoint)) return false;
  if (value.resource !== undefined && !isHttpsUrl(value.resource)) return false;
  return true;
}

function isAuthType(value: unknown): boolean {
  return value === "none" || value === "bearer" || value === "oauth";
}

function isApproval(value: unknown): boolean {
  return value === "automatic" || value === "ask" || value === "blocked";
}

function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/.test(value);
}

function isNamespace(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "sourcenerve" &&
    /^[a-z0-9_-]{1,48}$/.test(value)
  );
}

function isRegistryServerName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 200 &&
    /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(value)
  );
}

function isPublicToolName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isCredential(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 32 * 1024 &&
    !value.includes("\0")
  );
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
