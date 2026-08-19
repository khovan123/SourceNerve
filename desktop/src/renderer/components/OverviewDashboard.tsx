import { useEffect, useMemo, useRef, useState } from "react";

import type {
  Auth0SessionView,
  DaemonHealth,
  DaemonSnapshot,
  ManagedWorkspaceView,
  ProviderAccountView,
  PublicMcpView,
  ReadinessPayload,
  RuntimeComponent,
  RuntimeInfo,
  RuntimeLogEntry,
  RuntimeLogLevel,
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
import { routeHash } from "../navigation";
import { Panel } from "./Panel";
import { StatusBadge, type StatusTone } from "./StatusBadge";

const EMPTY_PUBLIC_MCP: PublicMcpView = {
  state: "not-enrolled",
  tunnelRunning: false,
};
const MAX_RENDERED_LOGS = 500;
const LOG_COMPONENTS: RuntimeComponent[] = [
  "desktop",
  "daemon",
  "auth",
  "provider",
  "git",
  "workspace",
  "public-mcp",
];
const LOG_LEVELS: RuntimeLogLevel[] = ["debug", "info", "warn", "error"];

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

    const daemonConnected =
      daemonValue?.state === "ready" || daemonValue?.state === "external";
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
      setActionMessage(
        result.ok ? `Daemon ${result.value.state}.` : result.error.message,
      );
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
      setActionMessage(
        result.ok ? `Public MCP ${result.value.state}.` : result.error.message,
      );
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
    () =>
      filterRuntimeLogs(logs, {
        level: levelFilter,
        component: componentFilter,
        query: logQuery,
      }).slice(-MAX_RENDERED_LOGS),
    [componentFilter, levelFilter, logQuery, logs],
  );
  const buildCommit =
    nestedString(serviceStatus, ["identity", "build_commit"]) ??
    nestedString(serviceStatus, ["identity", "buildCommit"]);
  const daemonServiceVersion =
    nestedString(serviceStatus, ["identity", "version"]) ?? daemon?.version;
  const daemonState = daemon?.state ?? "stopped";
  const daemonTransition = daemonState === "starting" || daemonState === "stopping";

  return (
    <section className="overview-dashboard" aria-label="SourceNerve operational overview">
      <div className="overview-recovery-bar">
        <div>
          <strong>Operational overview</strong>
          <span>Live state, readiness, workspaces and sanitized runtime logs.</span>
        </div>
        <div className="overview-actions">
          <button className="button button--quiet" type="button" onClick={() => openRoute("connections")}>
            Open Connections
          </button>
          <button className="button button--quiet" type="button" onClick={() => openRoute("workspaces")}>
            Open Workspaces
          </button>
          <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void copyDiagnostics()}>
            {busy === "diagnostics:copy" ? "Copying…" : "Copy diagnostics"}
          </button>
        </div>
      </div>
      {actionMessage ? <div className="overview-action-message" role="status">{actionMessage}</div> : null}

      <div className="overview-summary-grid">
        <Panel title="SourceNerve Account" eyebrow="Auth0">
          <div className="metric-row">
            <StatusBadge label={authLabel(auth)} tone={authTone(auth)} />
            <span>{auth.status === "authenticated" ? auth.identity?.name ?? auth.identity?.email ?? "Authenticated" : "SourceNerve account is not authenticated."}</span>
          </div>
          <dl className="facts">
            <div><dt>Workspace grants</dt><dd>{auth.workspaceGrants?.length ?? 0}</dd></div>
            <div><dt>Session</dt><dd>{auth.expiresAt ? new Date(auth.expiresAt).toLocaleString() : "—"}</dd></div>
          </dl>
        </Panel>

        <Panel title="Git Providers" eyebrow="Repository access">
          <div className="overview-provider-list">
            {(["github", "gitlab"] as const).map((providerName) => {
              const provider = providers.find((candidate) => candidate.provider === providerName);
              const connected = provider?.status === "connected";
              return (
                <div className="metric-row" key={providerName}>
                  <StatusBadge label={providerName === "github" ? "GitHub" : "GitLab"} tone={connected ? "ready" : provider?.status === "error" ? "warning" : "neutral"} />
                  <span>{connected ? provider?.login ?? provider?.name ?? "Connected" : provider?.error ?? provider?.status ?? "Disconnected"}</span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Daemon & Build" eyebrow="Local runtime">
          <div className="metric-row">
            <StatusBadge label={daemonState} tone={daemonTone(daemonState)} />
            <span>{daemon?.message ?? (daemon?.managed ? "Managed bundled runtime" : "External runtime")}</span>
          </div>
          <dl className="facts">
            <div><dt>Desktop</dt><dd>{runtime?.desktopVersion ?? "—"}</dd></div>
            <div><dt>Daemon</dt><dd>{daemonServiceVersion ?? "—"}</dd></div>
            <div><dt>Build</dt><dd className="overview-mono">{buildCommit ?? "—"}</dd></div>
            <div><dt>Process</dt><dd>{daemon?.pid ? `PID ${daemon.pid}` : "—"}</dd></div>
          </dl>
          <div className="overview-actions">
            {(daemonState === "stopped" || daemonState === "crashed") ? (
              <button className="button" type="button" disabled={Boolean(busy) || daemonTransition} onClick={() => void daemonAction("start")}>Start</button>
            ) : null}
            {daemon?.managed && daemonState === "ready" ? (
              <>
                <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void daemonAction("restart")}>Restart</button>
                <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void daemonAction("stop")}>Stop</button>
              </>
            ) : null}
          </div>
        </Panel>

        <Panel title="Local Readiness" eyebrow="Health">
          <div className="metric-row">
            <StatusBadge label={readinessView.label} tone={readinessView.ready ? "ready" : readinessView.label === "Checking" ? "working" : "warning"} />
            <span>{readinessView.reason}</span>
          </div>
          <dl className="facts">
            <div><dt>Health</dt><dd>{health?.status ?? "Unavailable"}</dd></div>
            <div><dt>API</dt><dd className="overview-mono">{runtime?.endpoints?.localApiUrl ?? "—"}</dd></div>
            <div><dt>Local MCP</dt><dd className="overview-mono">{runtime?.endpoints?.localMcpUrl ?? "—"}</dd></div>
          </dl>
        </Panel>

        <Panel title="Public MCP" eyebrow="Cloudflare tunnel">
          <div className="metric-row">
            <StatusBadge label={publicMcpLabel(publicMcp)} tone={publicMcpTone(publicMcp)} />
            <span>{publicMcp.message ?? publicMcp.hostname ?? "Installation is not enrolled."}</span>
          </div>
          <dl className="facts">
            <div><dt>Hostname</dt><dd className="overview-mono">{publicMcp.hostname ?? "—"}</dd></div>
            <div><dt>Public MCP</dt><dd className="overview-mono">{publicMcp.publicMcpUrl ?? publicMcpUrl(publicMcp) ?? runtime?.endpoints?.publicMcpResource ?? "—"}</dd></div>
            <div><dt>Tunnel</dt><dd>{publicMcp.tunnelRunning ? "Running" : "Stopped"}</dd></div>
            <div><dt>Last check</dt><dd>{publicMcp.lastCheckedAt ? new Date(publicMcp.lastCheckedAt).toLocaleString() : "—"}</dd></div>
          </dl>
          <button className="button" type="button" disabled={Boolean(busy) || auth.status !== "authenticated"} onClick={() => void repairPublicMcp()}>
            {busy === "public-mcp:repair" ? "Repairing…" : "Retry / Repair"}
          </button>
        </Panel>
      </div>

      <Panel title="Workspace readiness" eyebrow={`${workspaces.length} registered`}>
        {workspaces.length === 0 ? (
          <div className="empty-state">
            <strong>No workspace registered</strong>
            <p>Open Workspaces to add a validated local Git checkout.</p>
          </div>
        ) : (
          <div className="overview-workspace-grid">
            {workspaces.map((workspace) => (
              <WorkspaceCard key={workspace.id} workspace={workspace} />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Live runtime logs" eyebrow={`${logs.length} retained${droppedLogs > 0 ? ` · ${droppedLogs} rotated from memory` : ""}`}>
        <div className="overview-log-toolbar">
          <label>
            <span>Level</span>
            <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as RuntimeLogLevelFilter)}>
              <option value="all">All</option>
              {LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <label>
            <span>Component</span>
            <select value={componentFilter} onChange={(event) => setComponentFilter(event.target.value as RuntimeComponentFilter)}>
              <option value="all">All</option>
              {LOG_COMPONENTS.map((component) => <option key={component} value={component}>{component}</option>)}
            </select>
          </label>
          <label className="overview-log-search">
            <span>Search</span>
            <input value={logQuery} maxLength={128} onChange={(event) => setLogQuery(event.target.value)} placeholder="message or component" />
          </label>
          <span className="muted">Showing {filteredLogs.length} / {logs.length}</span>
        </div>
        <div className="overview-log-view" role="log" aria-live="polite" aria-relevant="additions text">
          {filteredLogs.length === 0 ? (
            <div className="empty-state"><strong>No matching logs</strong><p>Change filters or wait for runtime activity.</p></div>
          ) : filteredLogs.map((entry) => <LogEntryView entry={entry} key={entry.sequence} />)}
        </div>
      </Panel>
    </section>
  );
}

function WorkspaceCard({ workspace }: { workspace: ManagedWorkspaceView }) {
  const ready = workspace.validation.state === "ready";
  const indexReady = workspace.index.state === "current";
  return (
    <article className="overview-workspace-card">
      <div className="overview-workspace-heading">
        <div><strong>{workspace.name}</strong><span className="overview-mono">{workspace.id}</span></div>
        <StatusBadge label={ready && indexReady ? "Ready" : "Needs attention"} tone={ready && indexReady ? "ready" : "warning"} />
      </div>
      <dl className="workspace-facts">
        <div><dt>Access</dt><dd>{workspace.access}</dd></div>
        <div><dt>Repository</dt><dd>{workspace.provider && workspace.repository ? `${workspace.provider}:${workspace.repository}` : "Local Git"}</dd></div>
        <div><dt>Git</dt><dd>{ready ? "Config ready" : workspace.validation.message ?? "Invalid"}</dd></div>
        <div><dt>Working tree</dt><dd>{workspace.dirty === undefined ? "Unknown" : workspace.dirty ? "Dirty" : "Clean"}</dd></div>
        <div><dt>HEAD</dt><dd className="overview-mono">{workspace.head ?? "—"}</dd></div>
        <div><dt>Branch</dt><dd>{workspace.branch ?? workspace.defaultBranch}</dd></div>
        <div><dt>Index</dt><dd>{workspace.index.state}</dd></div>
        <div><dt>Indexed HEAD</dt><dd className="overview-mono">{workspace.index.indexedHead ?? "—"}</dd></div>
        <div><dt>Graph version</dt><dd>{workspace.index.graphVersion ?? "—"}</dd></div>
        <div><dt>Graph files</dt><dd>{workspace.index.parsedFiles ?? "—"}</dd></div>
      </dl>
    </article>
  );
}

function LogEntryView({ entry }: { entry: RuntimeLogEntry }) {
  return (
    <div className={`overview-log-entry overview-log-entry--${entry.level}`}>
      <time dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
      <span className="overview-log-component">{entry.component}</span>
      <span className="overview-log-level">{entry.level}</span>
      <span className="overview-log-message">{entry.message}</span>
    </div>
  );
}

function openRoute(route: "connections" | "workspaces"): void {
  window.location.hash = routeHash(route);
}

function authLabel(auth: Auth0SessionView): string {
  if (auth.status === "authenticated") return "Signed in";
  if (auth.status === "signing-in") return "Signing in";
  if (auth.status === "expired") return "Expired";
  if (auth.status === "error") return "Needs attention";
  return "Signed out";
}
function authTone(auth: Auth0SessionView): StatusTone {
  if (auth.status === "authenticated") return "ready";
  if (auth.status === "signing-in") return "working";
  if (auth.status === "expired" || auth.status === "error") return "warning";
  return "neutral";
}
function daemonTone(state: DaemonSnapshot["state"] | "stopped"): StatusTone {
  if (state === "ready" || state === "external") return "ready";
  if (state === "starting" || state === "stopping") return "working";
  if (state === "crashed" || state === "incompatible") return "warning";
  return "offline";
}
function publicMcpLabel(view: PublicMcpView): string {
  if (view.state === "ready") return "Ready";
  if (view.state === "checking" || view.state === "enrolling") return "Checking";
  if (view.state === "degraded") return "Degraded";
  if (view.state === "offline") return "Offline";
  if (view.state === "revoked") return "Revoked";
  return "Not enrolled";
}
function publicMcpTone(view: PublicMcpView): StatusTone {
  if (view.state === "ready") return "ready";
  if (view.state === "checking" || view.state === "enrolling") return "working";
  if (view.state === "degraded" || view.state === "revoked") return "warning";
  if (view.state === "offline") return "offline";
  return "neutral";
}
function publicMcpUrl(view: PublicMcpView): string | undefined {
  return view.hostname ? `https://${view.hostname}/mcp` : undefined;
}
function formatLogTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}
