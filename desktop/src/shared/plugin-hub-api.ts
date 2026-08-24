export type PluginStatus = "installed" | "enabled" | "disabled" | "error" | "updating";
export type PluginSourceKind = "local" | "catalog" | "github" | "https";

export interface PluginSourceView {
  kind: PluginSourceKind;
  label: string;
}

export type PluginMcpTransportView =
  | {
      kind: "streamable-http";
      url: string;
    }
  | {
      kind: "stdio";
      command: string;
      args: string[];
    };

export interface PluginMcpComponentView {
  id: string;
  name: string;
  transport: PluginMcpTransportView;
  auth: "none" | "bearer-env" | "unknown";
  definitionHash: string;
}

export interface PluginSkillView {
  id: string;
  name: string;
  description?: string;
  relativePath: string;
  contentHash: string;
  bytes: number;
}

export interface PluginPackageReview {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: string;
  category?: string;
  source: PluginSourceView;
  manifestHash: string;
  mcpServers: PluginMcpComponentView[];
  skills: PluginSkillView[];
  warnings: string[];
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: string;
  category?: string;
  source: PluginSourceView;
  status: PluginStatus;
  enabled: boolean;
  manifestHash: string;
  mcpExtensionIds: string[];
  skills: PluginSkillView[];
  installedAt: number;
  updatedAt: number;
}

export interface PluginMcpOwnershipRecord {
  extensionId: string;
  definitionHash: string;
  owners: string[];
  directInstall: boolean;
}

export interface PluginRegistrySnapshot {
  plugins: InstalledPluginRecord[];
  mcpOwnership: PluginMcpOwnershipRecord[];
}
