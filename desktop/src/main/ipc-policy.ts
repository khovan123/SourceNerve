import { DESKTOP_IPC } from "../shared/desktop-api";

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
]);

export const DESKTOP_INBOUND_IPC_CHANNELS = Object.freeze([
  ...NO_ARGUMENT_CHANNELS,
  DESKTOP_IPC.cancelOperation,
]);

export function validateDesktopIpcInvocation(channel: string, args: readonly unknown[]): string | null {
  if (channel === DESKTOP_IPC.runtimeEvent) {
    return "runtime event channel is outbound-only";
  }
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    return args.length === 0 ? null : "IPC operation does not accept arguments";
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
