import type {
  DaemonSnapshot,
  ReadinessPayload,
  RuntimeComponent,
  RuntimeLogEntry,
  RuntimeLogLevel,
} from "../shared/desktop-api";

export type RuntimeLogLevelFilter = "all" | RuntimeLogLevel;
export type RuntimeComponentFilter = "all" | RuntimeComponent;

export function mergeRuntimeLogEntries(
  current: readonly RuntimeLogEntry[],
  incoming: readonly RuntimeLogEntry[],
  maxEntries: number,
): RuntimeLogEntry[] {
  const bounded = Number.isInteger(maxEntries)
    ? Math.max(1, Math.min(20_000, maxEntries))
    : 1_000;
  const bySequence = new Map<number, RuntimeLogEntry>();
  for (const entry of current) bySequence.set(entry.sequence, entry);
  for (const entry of incoming) bySequence.set(entry.sequence, entry);
  return [...bySequence.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-bounded);
}

export function filterRuntimeLogs(
  entries: readonly RuntimeLogEntry[],
  options: {
    level: RuntimeLogLevelFilter;
    component: RuntimeComponentFilter;
    query: string;
  },
): RuntimeLogEntry[] {
  const query = options.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (options.level !== "all" && entry.level !== options.level) return false;
    if (options.component !== "all" && entry.component !== options.component) return false;
    if (!query) return true;
    return `${entry.component} ${entry.level} ${entry.message}`.toLocaleLowerCase().includes(query);
  });
}

export interface ReadinessView {
  ready: boolean;
  label: string;
  reason: string;
}

export function deriveReadinessView(
  daemon: DaemonSnapshot | null,
  readiness: ReadinessPayload | null,
  requestError?: string | null,
): ReadinessView {
  const daemonState = daemon?.state ?? "stopped";
  if (daemonState !== "ready" && daemonState !== "external") {
    return {
      ready: false,
      label: daemonState === "starting" ? "Starting" : "Unavailable",
      reason: daemon?.message ?? `Daemon is ${daemonState}`,
    };
  }
  if (requestError) {
    return { ready: false, label: "Needs attention", reason: requestError };
  }
  if (!readiness) {
    return { ready: false, label: "Checking", reason: "Readiness has not been loaded yet" };
  }
  if (readiness.ready === true) {
    return { ready: true, label: "Ready", reason: "Local SourceNerve runtime is ready" };
  }
  return {
    ready: false,
    label: "Blocked",
    reason:
      nestedString(readiness, ["reason"]) ??
      nestedString(readiness, ["message"]) ??
      firstWorkspaceReadinessReason(readiness) ??
      "Local readiness reported one or more blockers",
  };
}

export function nestedString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  if (typeof current !== "string") return undefined;
  const bounded = current.replace(/[\r\n\0]/g, " ").trim().slice(0, 512);
  return bounded || undefined;
}

function firstWorkspaceReadinessReason(readiness: ReadinessPayload): string | undefined {
  if (!Array.isArray(readiness.workspaces)) return undefined;
  for (const workspace of readiness.workspaces) {
    if (!isRecord(workspace)) continue;
    if (workspace.ready === true) continue;
    const id = typeof workspace.id === "string" ? workspace.id : "workspace";
    const reason =
      nestedString(workspace, ["reason"]) ??
      nestedString(workspace, ["message"]);
    if (reason) return `${id}: ${reason}`.slice(0, 512);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
