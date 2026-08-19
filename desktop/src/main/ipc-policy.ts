import {
  DESKTOP_IPC,
  type DesktopBehaviorPreferences,
  type GitProvider,
  type LegacyImportApplyInput,
  type WorkspaceSaveInput,
} from "../shared/desktop-api";
import { validateDesktopPreferencesInput } from "./desktop-preferences";
import {
  INTELLIGENCE_INBOUND_IPC_CHANNELS,
  validateIntelligenceIpcInvocation,
} from "./intelligence-policy";
import { TASK_INBOUND_IPC_CHANNELS, validateTaskIpcInvocation } from "./task-policy";

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
  DESKTOP_IPC.workspacePickRepository,
  DESKTOP_IPC.workspaceListManaged,
  DESKTOP_IPC.legacyImportPick,
  DESKTOP_IPC.auth0State,
  DESKTOP_IPC.auth0SignIn,
  DESKTOP_IPC.auth0Refresh,
  DESKTOP_IPC.auth0Logout,
  DESKTOP_IPC.providerStates,
  DESKTOP_IPC.publicMcpState,
  DESKTOP_IPC.publicMcpEnroll,
  DESKTOP_IPC.publicMcpRetry,
  DESKTOP_IPC.publicMcpRotate,
  DESKTOP_IPC.publicMcpRevoke,
  DESKTOP_IPC.publicMcpReEnroll,
  DESKTOP_IPC.runtimeLogs,
  DESKTOP_IPC.diagnosticsCopy,
  DESKTOP_IPC.supportBundlePreview,
  DESKTOP_IPC.recoveryState,
  DESKTOP_IPC.recoveryRebuildIndexes,
  DESKTOP_IPC.recoveryBackupCreateValidate,
  DESKTOP_IPC.recoveryBackupValidateLatest,
  DESKTOP_IPC.recoveryOpenStateDirectory,
  DESKTOP_IPC.recoveryOpenLogsDirectory,
  DESKTOP_IPC.recoveryResetUiSettings,
  DESKTOP_IPC.recoveryReadiness,
  DESKTOP_IPC.desktopBehavior,
]);
const INTELLIGENCE_CHANNELS = new Set<string>(INTELLIGENCE_INBOUND_IPC_CHANNELS);
const TASK_CHANNELS = new Set<string>(TASK_INBOUND_IPC_CHANNELS);

export const DESKTOP_INBOUND_IPC_CHANNELS = Object.freeze([
  ...NO_ARGUMENT_CHANNELS,
  DESKTOP_IPC.workspaceSave,
  DESKTOP_IPC.workspaceRemove,
  DESKTOP_IPC.workspaceIndex,
  DESKTOP_IPC.legacyImportApply,
  DESKTOP_IPC.providerConnect,
  DESKTOP_IPC.providerDisconnect,
  DESKTOP_IPC.providerRepositories,
  DESKTOP_IPC.providerValidateRepository,
  DESKTOP_IPC.providerValidateTransport,
  DESKTOP_IPC.supportBundleExport,
  DESKTOP_IPC.desktopBehaviorUpdate,
  DESKTOP_IPC.cancelOperation,
  ...INTELLIGENCE_INBOUND_IPC_CHANNELS,
  ...TASK_INBOUND_IPC_CHANNELS,
]);

export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (INTELLIGENCE_CHANNELS.has(channel)) return validateIntelligenceIpcInvocation(channel, args);
  if (TASK_CHANNELS.has(channel)) return validateTaskIpcInvocation(channel, args);
  if (channel === DESKTOP_IPC.runtimeEvent || channel === DESKTOP_IPC.runtimeLogEvent) {
    return "runtime event channel is outbound-only";
  }
  if (NO_ARGUMENT_CHANNELS.has(channel)) return args.length === 0 ? null : "IPC operation does not accept arguments";
  if (channel === DESKTOP_IPC.workspaceSave) {
    return args.length === 1 && isWorkspaceSaveInput(args[0]) ? null : "workspace save payload is invalid";
  }
  if (channel === DESKTOP_IPC.legacyImportApply) {
    return args.length === 1 && isLegacyImportApplyInput(args[0]) ? null : "legacy import payload is invalid";
  }
  if (channel === DESKTOP_IPC.workspaceRemove || channel === DESKTOP_IPC.workspaceIndex || channel === DESKTOP_IPC.providerValidateTransport) {
    return args.length === 1 && isValidWorkspaceId(args[0]) ? null : "workspaceId must be 1-128 letters, numbers, '.', '_' or '-'";
  }
  if (channel === DESKTOP_IPC.providerConnect || channel === DESKTOP_IPC.providerDisconnect || channel === DESKTOP_IPC.providerRepositories) {
    return args.length === 1 && isGitProvider(args[0]) ? null : "provider must be github or gitlab";
  }
  if (channel === DESKTOP_IPC.providerValidateRepository) {
    return args.length === 2 && isGitProvider(args[0]) && isRepositorySlug(args[1]) ? null : "provider repository validation input is invalid";
  }
  if (channel === DESKTOP_IPC.supportBundleExport) {
    return args.length === 2 && isValidSelectionId(args[0]) && (args[1] === "text" || args[1] === "zip") ? null : "support bundle export input is invalid";
  }
  if (channel === DESKTOP_IPC.desktopBehaviorUpdate) {
    return args.length === 1 && validateDesktopPreferencesInput(args[0]) ? null : "Desktop behavior preferences are invalid";
  }
  if (channel === DESKTOP_IPC.cancelOperation) {
    return args.length === 1 && isValidOperationId(args[0]) ? null : "operationId must be 1-128 letters, numbers, '.', '_' or '-'";
  }
  return "IPC channel is not allowlisted";
}

export function isGitProvider(value: unknown): value is GitProvider {
  return value === "github" || value === "gitlab";
}

export function isRepositorySlug(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 512 || value.startsWith("/") || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.length >= 2 && segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== "..");
}

export function isValidOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

export function isValidWorkspaceId(value: unknown): value is string {
  return isValidOperationId(value);
}

export function isWorkspaceSaveInput(value: unknown): value is WorkspaceSaveInput {
  if (!isRecord(value)) return false;
  const allowed = new Set(["originalId", "selectionId", "id", "name", "access", "remote", "defaultBranch"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.originalId !== undefined && !isValidWorkspaceId(value.originalId)) return false;
  if (value.selectionId !== undefined && !isValidSelectionId(value.selectionId)) return false;
  if (!isValidWorkspaceId(value.id)) return false;
  if (!boundedText(value.name, 1, 128)) return false;
  if (value.access !== "read-only" && value.access !== "read-write") return false;
  if (!isValidRemoteName(value.remote)) return false;
  if (!boundedText(value.defaultBranch, 1, 256) || value.defaultBranch.startsWith("-")) return false;
  return true;
}

export function isLegacyImportApplyInput(value: unknown): value is LegacyImportApplyInput {
  if (!isRecord(value)) return false;
  const allowed = new Set(["selectionId", "stateStrategy"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!isValidSelectionId(value.selectionId)) return false;
  return value.stateStrategy === "copy" || value.stateStrategy === "move" || value.stateStrategy === "reference" || value.stateStrategy === "reindex";
}

export function asDesktopBehaviorPreferences(value: unknown): DesktopBehaviorPreferences | null {
  return validateDesktopPreferencesInput(value) ? value : null;
}

function isValidSelectionId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function isValidRemoteName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}
function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && value.trim().length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
