import { useEffect, useMemo, useRef, useState } from "react";

import type {
  Auth0SessionView,
  DaemonHealth,
  DaemonSnapshot,
  ManagedWorkspaceView,
  ProviderAccountView,
  PublicMcpView,
  ReadinessPayload,
  RuntimeInfo,
  RuntimeLogEntry,
  ServiceStatusPayload,
} from "../../shared/desktop-api";
import {
  deriveReadinessView,
  filterRuntimeLogs,
  mergeRuntimeLogEntries,
  nestedString,
  type RuntimeComponentFilter,
  type RuntimeLogLevelFilter,
} from "../overview";
import { OverviewRecoveryBar } from "./organisms/OverviewRecoveryBar";
import { OverviewSummary } from "./organisms/OverviewSummary";
import { RuntimeLogPanel } from "./organisms/RuntimeLogPanel";
import { WorkspaceReadinessSection } from "./organisms/WorkspaceReadinessSection";

const EMPTY_PUBLIC_MCP: PublicMcpView = {
  state: "not-enrolled",
  tunnelRunning: false,
};
const MAX_RENDERED_LOGS = 500;

export function OverviewDashboard() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonSnapshot | null>(null);
  const [auth, setAuth] = useState<Auth0SessionView>({ status: "signed-out" });
  const [providers, setProviders] = useState<ProviderAccountView[]>([]);
  const [publicMcp, setPublicMcp] = useState<PublicMcpView>(EMPTY_PUBLIC_MCP);
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusPayload | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [logMaxEntries, setLogMaxEntries] = useState(1_000);
  const [droppedLogs, setDroppedLogs] = useState(0);
  const [levelFilter, setLevelFilter] = useState<RuntimeLogLevelFilter>("all");
  const [componentFilter, setComponentFilter] = useState<RuntimeComponentFilter>("all");
  const [logQuery, setLogQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const unsubscribeLogs = window.sourcenerveDesktop.subscribeRuntimeLogs((entry) => {
      setLogs((current) => mergeRuntimeLogEntries(current, [entry], logMaxEntries));
    });
    const unsubscribeRuntime = window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state") void refreshOverview();
      if (
        event.type === "progress" &&
        event.operationId.startsWith("workspace-index") &&
        ["indexed", "index-ready", "index-complete"].includes(event.stage.toLowerCase())
      ) {
        void refreshOverview();
      }
    });

    void loadLogSnapshot();
    void refreshOverview();

    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      unsubscribeLogs();
      unsubscribeRuntime();
    };
    // Subscriptions are intentionally established once per mounted Overview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLogSnapshot(): Promise<void> {
    const result = await window.sourcenerveDesktop.getRuntimeLogs();
    if (!mounted.current || !result.ok) return;
    setLogMaxEntries(result.value.maxEntries);
    setDroppedLogs(result.value.droppedEntries);
    setLogs((current) =>
      mergeRuntimeLogEntries(current, result.value.entries, result.value.maxEntries),
    );
  }

  async function refreshOverview(): Promise<void> {
    const generation = ++refreshGeneration.current;
    const [runtimeResult, daemonResult, authResult, providerResult, publicResult, workspaceResult] =
      await Promise.all([
        window.sourcenerveDesktop.getRuntimeInfo(),
        window.sourcenerveDesktop.getDaemonState(),
        window.sourcenerveDesktop.getAuth0State(),
        window.sourcenerveDesktop.getProviderStates(),
        window.sourcenerveDesktop.getPublicMcpState(),
        window.sourcenerveDesktop.listManagedWorkspaces(),
      ]);
    if (!mounted.current || generation !== refreshGeneration.current) return;

    setRuntime(runtimeResult.ok ? runtimeResult.value : null);
    const daemonValue = daemonResult.ok ? daemonResult.value : null;
    setDaemon(daemonValue);
    setAuth(authResult.ok ? authResult.value : { status: "signed-out" });
    setProviders(providerResult.ok ? providerResult.value : []);
    setPublicMcp(publicResult.ok ? publicResult.value : EMPTY_PUBLIC_MCP);
    setWorkspaces(workspaceResult.ok ? workspaceResult.value : []);

    const daemonConnected = daemonValue?.state === "ready" || daemonValue?.state === "external";
    if (!daemonConnected) {
      setHealth(null);
      setReadiness(null);
      setServiceStatus(null);
      setReadinessError(
        daemonResult.ok
          ? daemonValue?.message ?? `Daemon is ${daemonValue?.state ?? "unavailable"}`
          : daemonResult.error.message,
      );
      return;
    }

    const [healthResult, readinessResult, serviceResult] = await Promise.all([
      window.sourcenerveDesktop.getDaemonHealth(),
      window.sourcenerveDesktop.getReadiness(),
      window.sourcenerveDesktop.getServiceStatus(),
    ]);
    if (!mounted.current || generation !== refreshGeneration.current) return;
    setHealth(healthResult.ok ? healthResult.value : null);
    setReadiness(readinessResult.ok ? readinessResult.value : null);
    setServiceStatus(serviceResult.ok ? serviceResult.value : null);
    setReadinessError(
      readinessResult.ok
        ? healthResult.ok
          ? null
          : healthResult.error.message
        : readinessResult.error.message,
    );
  }

  async function daemonAction(action: "start" | "stop" | "restart"): Promise<void> {
    setBusy(`daemon:${action}`);
    setActionMessage(null);
    try {
      const result =
        action === "start"
          ? await window.sourcenerveDesktop.startDaemon()
          : action === "stop"
            ? await window.sourcenerveDesktop.stopDaemon()
            : await window.sourcenerveDesktop.restartDaemon();
      setActionMessage(result.ok ? `Daemon ${result.value.state}.` : result.error.message);
      if (result.ok) await refreshOverview();
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function repairPublicMcp(): Promise<void> {
    setBusy("public-mcp:repair");
    setActionMessage(null);
    try {
      const result = await window.sourcenerveDesktop.retryPublicMcp();
      setActionMessage(result.ok ? `Public MCP ${result.value.state}.` : result.error.message);
      if (result.ok) {
        setPublicMcp(result.value);
        await refreshOverview();
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function copyDiagnostics(): Promise<void> {
    setBusy("diagnostics:copy");
    setActionMessage(null);
    try {
      const result = await window.sourcenerveDesktop.copyDiagnostics();
      setActionMessage(
        result.ok
          ? `Copied sanitized diagnostics (${result.value.characters.toLocaleString()} characters).`
          : result.error.message,
      );
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const readinessView = deriveReadinessView(daemon, readiness, readinessError);
  const filteredLogs = useMemo(
    () => filterRuntimeLogs(logs, {
      level: levelFilter,
      component: componentFilter,
      query: logQuery,
    }).slice(-MAX_RENDERED_LOGS),
    [componentFilter, levelFilter, logQuery, logs],
  );
  const buildCommit =
    nestedString(serviceStatus, ["identity", "build_commit"]) ??
    nestedString(serviceStatus, ["identity", "buildCommit"]);
  const daemonServiceVersion = nestedString(serviceStatus, ["identity", "version"]) ?? daemon?.version;

  return (
    <section className="space-y-4" aria-label="SourceNerve operational overview">
      <OverviewRecoveryBar
        busy={busy}
        actionMessage={actionMessage}
        onCopyDiagnostics={() => void copyDiagnostics()}
      />
      <OverviewSummary
        auth={auth}
        providers={providers}
        daemon={daemon}
        runtime={runtime}
        health={health}
        readiness={readinessView}
        publicMcp={publicMcp}
        buildCommit={buildCommit}
        daemonServiceVersion={daemonServiceVersion}
        busy={busy}
        onDaemonAction={(action) => void daemonAction(action)}
        onRepairPublicMcp={() => void repairPublicMcp()}
      />
      <WorkspaceReadinessSection workspaces={workspaces} />
      <RuntimeLogPanel
        logs={filteredLogs}
        retainedCount={logs.length}
        droppedLogs={droppedLogs}
        levelFilter={levelFilter}
        componentFilter={componentFilter}
        query={logQuery}
        onLevelFilter={setLevelFilter}
        onComponentFilter={setComponentFilter}
        onQuery={setLogQuery}
      />
    </section>
  );
}
