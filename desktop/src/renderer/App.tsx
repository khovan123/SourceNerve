import { useEffect, useMemo, useState } from "react";

import type {
  Auth0SessionView,
  DaemonSnapshot,
  ProviderAccountView,
  RuntimeInfo,
} from "../shared/desktop-api";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { Panel } from "./components/Panel";
import { StatusBadge, type StatusTone } from "./components/StatusBadge";
import { WorkspaceManager } from "./components/WorkspaceManager";
import {
  DEFAULT_ONBOARDING_PROGRESS,
  applyRuntimeEventToSignals,
  emptyOnboardingSignals,
  recommendedOnboardingStep,
  sanitizeOnboardingProgress,
  type OnboardingSignals,
  type OnboardingUiProgress,
} from "./onboarding";
import {
  NAVIGATION,
  navigationItem,
  routeFromHash,
  routeHash,
  type RouteId,
} from "./navigation";

type ThemePreference = "system" | "light" | "dark";
type DaemonAction = "start" | "stop" | "restart" | "attach";

const ONBOARDING_STORAGE_KEY = "sourcenerve.desktop.onboarding.v1";

const PLACEHOLDER_COPY: Record<RouteId, string[]> = {
  overview: [
    "SourceNerve Account",
    "Git Provider",
    "SourceNerve Daemon",
    "Public MCP",
    "Workspace Health",
  ],
  workspaces: [
    "Choose repositories and local checkouts",
    "Create SourceNerve workspaces without editing TOML",
    "See access, branch, HEAD and index state",
  ],
  intelligence: [
    "Search indexed memory and raw code",
    "Inspect symbols, callers, callees and references",
    "Explore architecture, impact and context packs",
  ],
  tasks: [
    "Task → Branch → Context → Proposal",
    "Apply → Review → Commit → Push",
    "Every mutation stays behind SourceNerve guards",
  ],
  "pull-requests": [
    "Track provider issue and pull-request state",
    "Verify expected head SHA before merge",
    "Sync the default branch explicitly after merge",
  ],
  connections: [
    "SourceNerve Account (Auth0)",
    "GitHub / GitLab",
    "ChatGPT Plugin",
    "Public MCP",
  ],
  diagnostics: [
    "Sanitized Desktop, daemon, auth and tunnel logs",
    "Readiness and version diagnostics",
    "Explicit recovery and support-bundle actions",
  ],
  settings: [
    "Appearance",
    "Startup & Background",
    "Updates",
    "Notifications",
    "Advanced Diagnostics",
  ],
};

function nextTheme(theme: ThemePreference): ThemePreference {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}

export function App() {
  const [route, setRoute] = useState<RouteId>(() => routeFromHash(window.location.hash));
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonSnapshot | null>(null);
  const [authSession, setAuthSession] = useState<Auth0SessionView>({ status: "signed-out" });
  const [providerStates, setProviderStates] = useState<ProviderAccountView[]>([]);
  const [daemonBusy, setDaemonBusy] = useState(false);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingRuntimeSignals, setOnboardingRuntimeSignals] = useState<OnboardingSignals>(() =>
    emptyOnboardingSignals(),
  );
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingUiProgress>(
    loadOnboardingProgress,
  );
  const [showOnboarding, setShowOnboarding] = useState(true);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = routeHash("overview");
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void refreshRuntimeState();
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      setOnboardingRuntimeSignals((current) => applyRuntimeEventToSignals(current, event));
      if (
        event.type === "state" &&
        ["daemon", "workspace", "auth", "git", "provider"].includes(event.component)
      ) {
        void refreshRuntimeState();
      }
    });
  }, []);

  const current = useMemo(() => navigationItem(route), [route]);
  const daemonConnected = daemon?.state === "ready" || daemon?.state === "external";
  const onboardingSignals: OnboardingSignals = {
    ...onboardingRuntimeSignals,
    welcomeAcknowledged: onboardingProgress.welcomeAcknowledged,
  };
  const onboardingStep = recommendedOnboardingStep(onboardingSignals);
  const onboardingActive = route === "overview" && showOnboarding && onboardingStep !== "ready";

  useEffect(() => {
    if (onboardingProgress.lastVisitedStep === onboardingStep) return;
    const next = { ...onboardingProgress, lastVisitedStep: onboardingStep };
    setOnboardingProgress(next);
    saveOnboardingProgress(next);
  }, [onboardingProgress, onboardingStep]);

  async function refreshRuntimeState(): Promise<void> {
    setOnboardingError(null);
    const [runtimeResult, daemonResult, managedWorkspaceResult, authResult, providerResult] =
      await Promise.all([
        window.sourcenerveDesktop.getRuntimeInfo(),
        window.sourcenerveDesktop.getDaemonState(),
        window.sourcenerveDesktop.listManagedWorkspaces(),
        window.sourcenerveDesktop.getAuth0State(),
        window.sourcenerveDesktop.getProviderStates(),
      ]);

    if (runtimeResult.ok) {
      setRuntime(runtimeResult.value);
      setOnboardingRuntimeSignals((signals) => ({
        ...signals,
        productProfileReady: runtimeResult.value.bootstrap.ready,
        localBearerReady: runtimeResult.value.bootstrap.ready,
      }));
      if (!runtimeResult.value.bootstrap.ready && runtimeResult.value.bootstrap.error) {
        setOnboardingError(`Product Profile: ${runtimeResult.value.bootstrap.error}`);
      }
    } else {
      setRuntime(null);
      setOnboardingRuntimeSignals((signals) => ({
        ...signals,
        productProfileReady: false,
        localBearerReady: false,
      }));
      setOnboardingError(`Product Profile: ${runtimeResult.error.message}`);
    }

    const activeDaemon = daemonResult.ok ? daemonResult.value : null;
    if (activeDaemon) setDaemon(activeDaemon);
    setOnboardingRuntimeSignals((signals) => ({
      ...signals,
      daemonReady: activeDaemon?.state === "ready" || activeDaemon?.state === "external",
    }));

    if (authResult.ok) {
      setAuthSession(authResult.value);
      setOnboardingRuntimeSignals((signals) => ({
        ...signals,
        accountConnected: authResult.value.status === "authenticated",
      }));
      if (authResult.value.status === "error" && authResult.value.error) {
        setOnboardingError(`Auth0: ${authResult.value.error}`);
      }
    } else {
      setAuthSession({ status: "error", error: authResult.error.message });
      setOnboardingRuntimeSignals((signals) => ({ ...signals, accountConnected: false }));
      setOnboardingError(`Auth0: ${authResult.error.message}`);
    }

    if (providerResult.ok) {
      setProviderStates(providerResult.value);
      const connected = providerResult.value.some((provider) => provider.status === "connected");
      setOnboardingRuntimeSignals((signals) => ({ ...signals, gitConnected: connected }));
      const providerError = providerResult.value.find((provider) => provider.status === "error")?.error;
      if (providerError) setOnboardingError(`Git Provider: ${providerError}`);
    } else {
      setProviderStates([]);
      setOnboardingRuntimeSignals((signals) => ({ ...signals, gitConnected: false }));
      setOnboardingError(`Git Provider: ${providerResult.error.message}`);
    }

    if (managedWorkspaceResult.ok) {
      const configured = managedWorkspaceResult.value.length > 0;
      const ready = managedWorkspaceResult.value.some((workspace) => workspace.validation.valid);
      const indexed = managedWorkspaceResult.value.some(
        (workspace) => workspace.validation.valid && workspace.indexed,
      );
      setWorkspaceCount(managedWorkspaceResult.value.length);
      setOnboardingRuntimeSignals((signals) => ({
        ...signals,
        repositorySelected: configured,
        workspaceReady: ready,
        indexReady: indexed,
      }));
    } else {
      setWorkspaceCount(0);
      setOnboardingRuntimeSignals((signals) => ({
        ...signals,
        repositorySelected: false,
        workspaceReady: false,
        indexReady: false,
      }));
      setOnboardingError(`Workspace: ${managedWorkspaceResult.error.message}`);
    }
  }

  async function runDaemonAction(action: DaemonAction): Promise<void> {
    setDaemonBusy(true);
    setDaemonError(null);
    try {
      const result =
        action === "start"
          ? await window.sourcenerveDesktop.startDaemon()
          : action === "stop"
            ? await window.sourcenerveDesktop.stopDaemon()
            : action === "restart"
              ? await window.sourcenerveDesktop.restartDaemon()
              : await window.sourcenerveDesktop.attachExternalDaemon();
      if (result.ok) {
        setDaemon(result.value);
        void refreshRuntimeState();
      } else setDaemonError(result.error.message);
    } finally {
      setDaemonBusy(false);
    }
  }

  function acknowledgeWelcome(): void {
    const next: OnboardingUiProgress = {
      schemaVersion: 1,
      welcomeAcknowledged: true,
      lastVisitedStep: "account",
    };
    setOnboardingProgress(next);
    saveOnboardingProgress(next);
  }

  function useExistingSetup(): void {
    acknowledgeWelcome();
    openRoute("workspaces");
  }

  function openRoute(nextRoute: RouteId): void {
    setShowOnboarding(false);
    window.location.hash = routeHash(nextRoute);
  }

  function retryCurrentOnboardingLayer(): void {
    setOnboardingError(null);
    void refreshRuntimeState();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">SN</div>
          <div className="brand__copy"><strong>SourceNerve</strong><span>Repository intelligence</span></div>
        </div>
        <nav className="nav-list">
          {NAVIGATION.map((item) => (
            <a
              key={item.id}
              className={`nav-item ${route === item.id ? "nav-item--active" : ""}`}
              href={routeHash(item.id)}
              aria-current={route === item.id ? "page" : undefined}
              title={item.description}
            >
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar__footer"><StatusBadge label="Development" tone="working" /><span>Desktop MVP</span></div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div><p className="eyebrow">Workspace</p><strong>{workspaceCount > 0 ? `${workspaceCount} configured` : "No workspace selected"}</strong></div>
          <div className="topbar__actions">
            {route === "overview" && !onboardingActive && onboardingStep !== "ready" ? (
              <button className="button button--quiet" type="button" onClick={() => setShowOnboarding(true)}>Continue setup</button>
            ) : null}
            <button className="button button--quiet" type="button" onClick={() => setTheme((value) => nextTheme(value))} aria-label={`Theme: ${theme}. Change theme`}>Theme: {theme}</button>
            <StatusBadge label={runtime?.bootstrap.ready ? "Local bootstrap ready" : "Local bootstrap needs attention"} tone={runtime?.bootstrap.ready ? "ready" : "warning"} />
          </div>
        </header>

        <main className="content">
          {onboardingActive ? (
            <OnboardingWizard
              runtime={runtime}
              signals={onboardingSignals}
              error={onboardingError}
              onAcknowledgeWelcome={acknowledgeWelcome}
              onUseExistingSetup={useExistingSetup}
              onOpenConnections={() => openRoute("connections")}
              onOpenWorkspaces={() => openRoute("workspaces")}
              onRetryCurrent={retryCurrentOnboardingLayer}
            />
          ) : route === "workspaces" ? (
            <WorkspaceManager />
          ) : route === "connections" ? (
            <ConnectionsScreen />
          ) : (
            <>
              <div className="page-heading">
                <div><p className="eyebrow">SourceNerve Desktop</p><h1>{current.label}</h1><p>{current.description}</p></div>
                {route === "overview" && onboardingStep !== "ready" ? (
                  <button className="button" type="button" onClick={() => setShowOnboarding(true)}>Continue setup</button>
                ) : <button className="button" type="button" disabled>Coming in next issue</button>}
              </div>
              {route === "overview" ? (
                <Overview
                  runtime={runtime}
                  daemon={daemon}
                  authSession={authSession}
                  providerStates={providerStates}
                  daemonBusy={daemonBusy}
                  daemonError={daemonError}
                  workspaceCount={workspaceCount}
                  runDaemonAction={runDaemonAction}
                />
              ) : <PlaceholderScreen route={route} />}
            </>
          )}
        </main>

        <footer className="status-strip" aria-label="Runtime status">
          <span><i className="status-dot status-dot--ready" aria-hidden="true" />Desktop API: {runtime ? `v${runtime.apiVersion}` : "Unavailable"}</span>
          <span><i className={`status-dot ${daemonConnected ? "status-dot--ready" : ""}`} aria-hidden="true" />Daemon: {daemon?.state ?? "Unavailable"}</span>
          <span><i className={`status-dot ${authSession.status === "authenticated" ? "status-dot--ready" : ""}`} aria-hidden="true" />Account: {authSession.status}</span>
          <span><i className={`status-dot ${providerStates.some((provider) => provider.status === "connected") ? "status-dot--ready" : ""}`} aria-hidden="true" />Git: {connectedProviderLabel(providerStates)}</span>
          <span>{runtime ? `${runtime.platform}/${runtime.arch}` : "Runtime info unavailable"}</span>
        </footer>
      </div>
    </div>
  );
}

function Overview({
  runtime,
  daemon,
  authSession,
  providerStates,
  daemonBusy,
  daemonError,
  workspaceCount,
  runDaemonAction,
}: {
  runtime: RuntimeInfo | null;
  daemon: DaemonSnapshot | null;
  authSession: Auth0SessionView;
  providerStates: ProviderAccountView[];
  daemonBusy: boolean;
  daemonError: string | null;
  workspaceCount: number;
  runDaemonAction(action: DaemonAction): Promise<void>;
}) {
  const state = daemon?.state ?? "stopped";
  const transitionBusy = daemonBusy || state === "starting" || state === "stopping";
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "ready" && daemon?.managed === true;
  const canRestart = state === "ready" && daemon?.managed === true;
  const canAttach = state === "external";
  const connectedProviders = providerStates.filter((provider) => provider.status === "connected");

  return (
    <div className="dashboard-grid">
      <Panel title="SourceNerve Account" eyebrow="Identity">
        <div className="metric-row">
          <StatusBadge label={authSession.status === "authenticated" ? "Signed in" : authSession.status} tone={authSession.status === "authenticated" ? "ready" : authSession.status === "error" || authSession.status === "expired" ? "warning" : "neutral"} />
          <span>{authSession.identity?.name ?? authSession.identity?.email ?? "Use Connections to sign in with an operator-issued SourceNerve account."}</span>
        </div>
      </Panel>

      <Panel title="Git Provider" eyebrow="Repository access">
        <div className="metric-row">
          <StatusBadge label={connectedProviders.length > 0 ? `${connectedProviders.length} connected` : "Not connected"} tone={connectedProviders.length > 0 ? "ready" : "neutral"} />
          <span>{connectedProviders.length > 0 ? connectedProviders.map((provider) => `${provider.provider === "github" ? "GitHub" : "GitLab"}: ${provider.login}`).join(" · ") : "Connect GitHub or GitLab through Device Authorization in Connections."}</span>
        </div>
      </Panel>

      <Panel title="SourceNerve Daemon" eyebrow="Local runtime">
        <div className="metric-row"><StatusBadge label={state} tone={daemonTone(state)} /><span>{daemon?.message ?? "Desktop owns the bundled SourceNerve runtime."}</span></div>
        <dl className="facts">
          <div><dt>Version</dt><dd>{daemon?.version ?? "—"}</dd></div>
          <div><dt>Process</dt><dd>{daemon?.pid ? `PID ${daemon.pid}` : daemon?.managed ? "Managed" : "External / idle"}</dd></div>
          <div><dt>Desktop</dt><dd>{runtime?.desktopVersion ?? "—"}</dd></div>
        </dl>
        <div className="topbar__actions">
          {canStart ? <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("start")}>Start daemon</button> : null}
          {canRestart ? <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("restart")}>Restart</button> : null}
          {canStop ? <button className="button button--quiet" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("stop")}>Stop</button> : null}
          {canAttach ? <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("attach")}>Attach external</button> : null}
        </div>
        {daemonError ? <p className="muted" role="alert">{daemonError}</p> : null}
      </Panel>

      <Panel title="Public MCP" eyebrow="Plugin connectivity">
        <div className="metric-row"><StatusBadge label="Not enrolled" tone="neutral" /><span>Public MCP enrollment remains a trusted-main lifecycle, not a token-entry form.</span></div>
      </Panel>

      <Panel title="Workspaces" eyebrow="Repository health">
        <div className="metric-row"><StatusBadge label={workspaceCount > 0 ? `${workspaceCount} configured` : "Not configured"} tone={workspaceCount > 0 ? "ready" : "neutral"} /><span>Workspace roots, HEAD state and index lifecycle are managed locally by Desktop.</span></div>
      </Panel>
    </div>
  );
}

function connectedProviderLabel(states: ProviderAccountView[]): string {
  const connected = states.filter((provider) => provider.status === "connected");
  if (connected.length === 0) return "Not connected";
  return connected.map((provider) => (provider.provider === "github" ? "GitHub" : "GitLab")).join(" + ");
}

function daemonTone(state: DaemonSnapshot["state"]): StatusTone {
  if (state === "ready" || state === "external") return "ready";
  if (state === "starting" || state === "stopping") return "working";
  if (state === "crashed" || state === "incompatible") return "warning";
  return "offline";
}

function PlaceholderScreen({ route }: { route: RouteId }) {
  return (
    <Panel title="Planned surface" eyebrow="Desktop MVP">
      <ul className="feature-list">{PLACEHOLDER_COPY[route].map((item) => <li key={item}>{item}</li>)}</ul>
      <p className="muted">The shell keeps feature ownership separated so account, provider, repository, and mutation behavior can be added without weakening the Desktop security boundary.</p>
    </Panel>
  );
}

function loadOnboardingProgress(): OnboardingUiProgress {
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw || raw.length > 2048) return { ...DEFAULT_ONBOARDING_PROGRESS };
    return sanitizeOnboardingProgress(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_ONBOARDING_PROGRESS };
  }
}

function saveOnboardingProgress(progress: OnboardingUiProgress): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // UI progress is optional and never authoritative for authentication or access.
  }
}
