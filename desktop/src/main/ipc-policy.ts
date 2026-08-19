import { DESKTOP_IPC, type ManagedWorkspaceInput } from "../shared/desktop-api";

const NO_ARGUMENT_CHANNELS = new Set<string>([
  DESKTOP_IPC.runtimeInfo,
  DESKTOP_IPC.daemonState,
  DESKTOP_IPC.daemonStart,
  DESKTOP_IPC.daemonStop,
  DESKTOP_IPC.daemonRestart,
  DESKTOP_IPC.daemonAttachExternal,
  DESKTOP_IPC.daemonHealth,
  DESKTOP_IPC.serviceStatus,
  DESKTOP_IPC.readiness,
  DESKTOP_IPC.listWorkspaces,
  DESKTOP_IPC.workspacePickDirectory,
  DESKTOP_IPC.workspaceManagedList,
  DESKTOP_IPC.auth0State,
  DESKTOP_IPC.auth0SignIn,
  DESKTOP_IPC.auth0Refresh,
  DESKTOP_IPC.auth0Logout,
  DESKTOP_IPC.providerStates,
]);

const PROVIDER_CHANNELS = new Set<string>([
  DESKTOP_IPC.providerConnect,
  DESKTOP_IPC.providerDisconnect,
  DESKTOP_IPC.providerRepositories,
]);

const WORKSPACE_INPUT_KEYS = new Set([
  "id",
  "name",
  "root",
  "access",
  "remote",
  "defaultBranch",
  "provider",
  "repository",
]);

export const DESKTOP_INBOUND_IPC_CHANNELS = Object.freeze([
  ...NO_ARGUMENT_CHANNELS,
  ...PROVIDER_CHANNELS,
  DESKTOP_IPC.workspaceValidate,
  DESKTOP_IPC.workspaceSave,
  DESKTOP_IPC.workspaceRemove,
  DESKTOP_IPC.workspaceIndex,
  DESKTOP_IPC.providerRepositoryValidate,
  DESKTOP_IPC.gitTransportValidate,
  DESKTOP_IPC.cancelOperation,
]);

export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === DESKTOP_IPC.runtimeEvent) return "runtime event channel is outbound-only";
  if (NO_ARGUMENT_CHANNELS.has(channel)) return args.length === 0 ? null : "IPC operation does not accept arguments";
  if (PROVIDER_CHANNELS.has(channel)) {
    return args.length === 1 && isGitProvider(args[0])
      ? null
      : "provider operation requires exactly one github/gitlab identifier";
  }
  if (channel === DESKTOP_IPC.providerRepositoryValidate) {
    return args.length === 2 && isGitProvider(args[0]) && isRepositorySlug(args[1])
      ? null
      : "provider repository validation requires a bounded provider and repository slug";
  }
  if (channel === DESKTOP_IPC.gitTransportValidate) {
    return args.length === 1 && isWorkspaceId(args[0])
      ? null
      : "Git transport validation requires a bounded workspace id";
  }
  if (channel === DESKTOP_IPC.workspaceValidate || channel === DESKTOP_IPC.workspaceSave) {
    if (args.length !== 1 || !isManagedWorkspaceInput(args[0])) {
      return "workspace payload does not match the bounded Desktop workspace schema";
    }
    return null;
  }
  if (channel === DESKTOP_IPC.workspaceRemove || channel === DESKTOP_IPC.workspaceIndex) {
    if (args.length !== 1 || !isWorkspaceId(args[0])) {
      return "workspace id must be 1-128 letters, numbers, '.', '_' or '-'";
    }
    return null;
  }
  if (channel === DESKTOP_IPC.cancelOperation) {
    if (args.length !== 1 || !isValidOperationId(args[0])) {
      return "operationId must be 1-128 letters, numbers, '.', '_' or '-'";
    }
    return null;
  }
  return "IPC channel is not allowlisted";
}

export function isValidOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

export function isManagedWorkspaceInput(value: unknown): value is ManagedWorkspaceInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !WORKSPACE_INPUT_KEYS.has(key))) return false;
  if (!isWorkspaceId(value.id)) return false;
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 128) return false;
  if (typeof value.root !== "string" || value.root.length < 1 || value.root.length > 4096 || value.root.includes("\0")) return false;
  if (value.access !== "read-only" && value.access !== "read-write") return false;
  if (typeof value.remote !== "string" || value.remote.length < 1 || value.remote.length > 128) return false;
  if (typeof value.defaultBranch !== "string" || value.defaultBranch.length < 1 || value.defaultBranch.length > 256) return false;
  if (value.provider !== undefined && !isGitProvider(value.provider)) return false;
  if (value.repository !== undefined && !isRepositorySlug(value.repository)) return false;
  return true;
}

function isGitProvider(value: unknown): value is "github" | "gitlab" {
  return value === "github" || value === "gitlab";
}

function isRepositorySlug(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 512 || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
