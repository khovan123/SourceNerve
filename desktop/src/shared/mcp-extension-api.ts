import type { DesktopResult } from "./desktop-api";

export type McpExtensionAuthType = "none" | "bearer" | "oauth";
export type McpExtensionStatus = "installed" | "enabled" | "disabled" | "error" | "updating";
export type McpToolApproval = "automatic" | "ask" | "blocked";
export type McpActivityPolicyDecision =
  | "allow"
  | "blocked"
  | "ask"
  | "authorization-denied"
  | "configuration-error";
export type McpActivityApprovalDecision =
  | "not-required"
  | "approved"
  | "missing"
  | "not-applicable";
export type McpActivityResultCategory =
  | "success"
  | "denied"
  | "approval-required"
  | "configuration-error"
  | "downstream-error";

export interface McpExtensionEnvironmentValue {
  name: string;
  value: string;
  secret: boolean;
}

export type McpExtensionTransport =
  | { transport: "stdio"; command: string; args: string[]; environment?: string[] }
  | { transport: "streamable-http"; url: string };

export interface McpExtensionOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId?: string;
  registrationEndpoint?: string;
  scopes: string[];
  revokeEndpoint?: string;
  resource?: string;
  issuer?: string;
}

export interface McpExtensionInstallInput {
  id: string;
  name: string;
  version: string;
  namespace: string;
  source: string;
  transport: McpExtensionTransport;
  authType: McpExtensionAuthType;
  credential?: string;
  oauth?: McpExtensionOAuthConfig;
  environment?: McpExtensionEnvironmentValue[];
  required?: boolean;
  updateChannel?: string;
}

export interface McpExtensionView {
  id: string;
  name: string;
  version: string;
  namespace: string;
  source: string;
  transport: McpExtensionTransport;
  authType: McpExtensionAuthType;
  status: McpExtensionStatus;
  enabled: boolean;
  required: boolean;
  updateChannel: string;
  lastError?: string;
  credentialConfigured: boolean;
  credentialMaterialized: boolean;
  environmentConfigured?: boolean;
  environmentMaterialized?: boolean;
  oauthConfigured: boolean;
  oauthConnected: boolean;
  oauthExpiresAt?: number;
  discoveredTools: number;
  exposedTools: number;
  createdAt: number;
  updatedAt: number;
}

export interface McpToolClassificationView {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface McpExtensionToolView {
  extensionId: string;
  originalName: string;
  publicName: string;
  description?: string;
  schemaHash: string;
  enabled: boolean;
  approval: McpToolApproval;
  classification: McpToolClassificationView;
}

export interface McpExtensionToolPolicyInput {
  extensionId: string;
  toolName: string;
  enabled: boolean;
  approval: McpToolApproval;
}

export interface McpExtensionCredentialInput {
  extensionId: string;
  credential: string;
}

export interface McpExtensionApprovalResult {
  publicTool: string;
  approvedOnce: true;
  expiresInSeconds: number;
}

export interface McpExtensionActivityQuery {
  extensionId?: string;
  limit?: number;
}

export interface McpExtensionActivityView {
  id: number;
  occurredAt: number;
  principalKind: "operator" | "oauth";
  principalSubject: string;
  workspaceId?: string;
  extensionId: string;
  extensionVersion: string;
  publicTool: string;
  originalTool: string;
  schemaHash: string;
  policyDecision: McpActivityPolicyDecision;
  approvalDecision: McpActivityApprovalDecision;
  resultCategory: McpActivityResultCategory;
  durationMs: number;
  errorCategory?: string;
}

export interface McpExtensionOAuthActionResult {
  extensionId: string;
  connected: boolean;
  expiresAt?: number;
  message: string;
}

export interface McpMarketplaceSearchInput {
  query: string;
  limit?: number;
}

export type McpMarketplaceInstallKind = "npm" | "pypi" | "remote" | "manual";
export type McpMarketplaceTrustLevel = "high" | "medium" | "low";
export type McpMarketplaceRegistryStatus = "active" | "deprecated" | "deleted" | "unknown";
export type McpMarketplaceSigningStatus =
  | "registry-provenance"
  | "publisher-metadata"
  | "not-available";

export interface McpMarketplaceTrustView {
  score: number;
  level: McpMarketplaceTrustLevel;
  registryStatus: McpMarketplaceRegistryStatus;
  namespaceVerified: boolean;
  packageOwnershipVerified: boolean;
  signingStatus: McpMarketplaceSigningStatus;
  publishedAt?: string;
  updatedAt?: string;
  reasons: string[];
}

export interface McpMarketplaceConfigurationField {
  name: string;
  description?: string;
  required: boolean;
  secret: boolean;
  defaultValue?: string;
}

export type McpAuthDiscoveryStatus = "not-required" | "oauth" | "manual";
export type McpAuthClientRegistration = "preconfigured" | "dynamic" | "unsupported";

export interface McpAuthDiscoveryView {
  status: McpAuthDiscoveryStatus;
  source: "challenge" | "well-known" | "none";
  registration: McpAuthClientRegistration;
  scopes: string[];
  config?: McpExtensionOAuthConfig;
  notes: string[];
}

export interface McpMarketplaceServerView {
  registryName: string;
  title: string;
  description: string;
  version: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  installKind: McpMarketplaceInstallKind;
  transport: "stdio" | "streamable-http" | "unknown";
  packageType?: string;
  packageIdentifier?: string;
  installHint: string;
  canAutoInstall: boolean;
  requiresConfiguration: boolean;
  configurationFields: McpMarketplaceConfigurationField[];
  trust: McpMarketplaceTrustView;
}

export interface McpMarketplaceInstallPlan {
  server: McpMarketplaceServerView;
  input?: McpExtensionInstallInput;
  commandPreview?: string;
  blockers: string[];
  auth?: McpAuthDiscoveryView;
}

export interface McpMarketplaceInstallRequest {
  serverName: string;
  environment?: McpExtensionEnvironmentValue[];
}

export interface McpMarketplaceUpdateResult {
  extensionId: string;
  fromVersion: string;
  toVersion: string;
  staged: boolean;
  rolledBack: boolean;
  message: string;
}

export interface McpMarketplaceRollbackResult {
  extensionId: string;
  fromVersion: string;
  toVersion: string;
  message: string;
}

export interface McpExtensionApi {
  list(): Promise<DesktopResult<McpExtensionView[]>>;
  install(input: McpExtensionInstallInput): Promise<DesktopResult<McpExtensionView>>;
  enable(extensionId: string): Promise<DesktopResult<McpExtensionView>>;
  disable(extensionId: string): Promise<DesktopResult<McpExtensionView>>;
  restart(extensionId: string): Promise<DesktopResult<McpExtensionToolView[]>>;
  remove(extensionId: string): Promise<DesktopResult<{ removed: boolean }>>;
  listTools(extensionId: string): Promise<DesktopResult<McpExtensionToolView[]>>;
  updateToolPolicy(input: McpExtensionToolPolicyInput): Promise<DesktopResult<McpExtensionToolView>>;
  setCredential(input: McpExtensionCredentialInput): Promise<DesktopResult<{ configured: true }>>;
  clearCredential(extensionId: string): Promise<DesktopResult<{ configured: false }>>;
  approveNext(publicTool: string): Promise<DesktopResult<McpExtensionApprovalResult>>;
  listActivity(input?: McpExtensionActivityQuery): Promise<DesktopResult<McpExtensionActivityView[]>>;
  connectOAuth(extensionId: string): Promise<DesktopResult<McpExtensionOAuthActionResult>>;
  refreshOAuth(extensionId: string): Promise<DesktopResult<McpExtensionOAuthActionResult>>;
  revokeOAuth(extensionId: string): Promise<DesktopResult<McpExtensionOAuthActionResult>>;
  searchMarketplace(input: McpMarketplaceSearchInput): Promise<DesktopResult<McpMarketplaceServerView[]>>;
  planMarketplaceInstall(serverName: string): Promise<DesktopResult<McpMarketplaceInstallPlan>>;
  installMarketplace(input: McpMarketplaceInstallRequest): Promise<DesktopResult<McpExtensionView>>;
  updateMarketplace(extensionId: string): Promise<DesktopResult<McpMarketplaceUpdateResult>>;
  rollbackMarketplace(extensionId: string): Promise<DesktopResult<McpMarketplaceRollbackResult>>;
}

export const MCP_EXTENSION_IPC = {
  list: "desktop:mcp-extensions-list",
  install: "desktop:mcp-extensions-install",
  enable: "desktop:mcp-extensions-enable",
  disable: "desktop:mcp-extensions-disable",
  restart: "desktop:mcp-extensions-restart",
  remove: "desktop:mcp-extensions-remove",
  tools: "desktop:mcp-extensions-tools",
  toolPolicy: "desktop:mcp-extensions-tool-policy",
  credentialSet: "desktop:mcp-extensions-credential-set",
  credentialClear: "desktop:mcp-extensions-credential-clear",
  approveNext: "desktop:mcp-extensions-approve-next",
  activity: "desktop:mcp-extensions-activity",
  oauthConnect: "desktop:mcp-extensions-oauth-connect",
  oauthRefresh: "desktop:mcp-extensions-oauth-refresh",
  oauthRevoke: "desktop:mcp-extensions-oauth-revoke",
  marketplaceSearch: "desktop:mcp-marketplace-search",
  marketplacePlan: "desktop:mcp-marketplace-plan",
  marketplaceInstall: "desktop:mcp-marketplace-install",
  marketplaceUpdate: "desktop:mcp-marketplace-update",
  marketplaceRollback: "desktop:mcp-marketplace-rollback",
} as const;