import { DESKTOP_IPC, type WorkspaceSaveInput } from "../shared/desktop-api";

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
]);

export const DESKTOP_INBOUND_IPC_CHANNELS = Object.freeze([
  ...NO_ARGUMENT_CHANNELS,
  DESKTOP_IPC.workspaceSave,
  DESKTOP_IPC.workspaceRemove,
  DESKTOP_IPC.workspaceIndex,
  DESKTOP_IPC.cancelOperation,
]);

export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === DESKTOP_IPC.runtimeEvent) {
    return "runtime event channel is outbound-only";
  }
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    return args.length === 0 ? null : "IPC operation does not accept arguments";
  }
  if (channel === DESKTOP_IPC.workspaceSave) {
    if (args.length !== 1 || !isWorkspaceSaveInput(args[0])) {
      return "workspace save payload is invalid";
    }
    return null;
  }
  if (channel === DESKTOP_IPC.workspaceRemove || channel === DESKTOP_IPC.workspaceIndex) {
    if (args.length !== 1 || !isValidWorkspaceId(args[0])) {
      return "workspaceId must be 1-128 letters, numbers, '.', '_' or '-'";
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
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

export function isValidWorkspaceId(value: unknown): value is string {
  return isValidOperationId(value);
}

export function isWorkspaceSaveInput(value: unknown): value is WorkspaceSaveInput {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "originalId",
    "selectionId",
    "id",
    "name",
    "access",
    "remote",
    "defaultBranch",
  ]);
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

function isValidSelectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isValidRemoteName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  );
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.trim().length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
