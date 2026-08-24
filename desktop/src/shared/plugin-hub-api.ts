import type { DesktopResult } from "./desktop-api";

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

export interface PluginExploreItem {
  catalogId: string;
  sourcePath: string;
  category?: string;
  review?: PluginPackageReview;
  blocker?: string;
}

export interface PluginInstallResult {
  plugin: InstalledPluginRecord;
  createdMcpExtensions: string[];
  reusedMcpExtensions: string[];
}

export interface PluginPickResult {
  selected: boolean;
  path?: string;
  review?: PluginPackageReview;
}

export interface PluginHubApi {
  list(): Promise<DesktopResult<PluginRegistrySnapshot>>;
  explore(): Promise<DesktopResult<PluginExploreItem[]>>;
  inspectLocal(root: string): Promise<DesktopResult<PluginPackageReview>>;
  pickLocal(): Promise<DesktopResult<PluginPickResult>>;
  installLocal(root: string): Promise<DesktopResult<PluginInstallResult>>;
  enable(pluginId: string): Promise<DesktopResult<InstalledPluginRecord>>;
  disable(pluginId: string): Promise<DesktopResult<InstalledPluginRecord>>;
  remove(pluginId: string): Promise<DesktopResult<{ removed: boolean }>>;
}

export const PLUGIN_HUB_IPC = {
  list: "desktop:plugin-hub-list",
  explore: "desktop:plugin-hub-explore",
  inspectLocal: "desktop:plugin-hub-inspect-local",
  pickLocal: "desktop:plugin-hub-pick-local",
  installLocal: "desktop:plugin-hub-install-local",
  enable: "desktop:plugin-hub-enable",
  disable: "desktop:plugin-hub-disable",
  remove: "desktop:plugin-hub-remove",
} as const;

declare global {
  interface Window {
    sourcenervePluginHub: PluginHubApi;
  }
}
