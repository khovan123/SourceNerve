import { useEffect, useMemo, useState } from "react";

import type {
  DaemonSnapshot,
  PublicMcpView,
  RuntimeInfo,
} from "../shared/desktop-api";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { DesktopSettingsScreen } from "./components/DesktopSettings";
import { DiagnosticsScreen } from "./components/DiagnosticsScreen";
import { IntelligenceExplorer } from "./components/IntelligenceExplorer";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { Panel } from "./components/Panel";
import { PluginVerificationPanel } from "./components/PluginVerificationPanel";
import { ProviderWorkflowScreen } from "./components/ProviderWorkflowScreen";
import { StatusBadge } from "./components/StatusBadge";
import { TaskWorkflowScreen } from "./components/TaskWorkflowScreen";
import { WorkspaceManagerScreen } from "./components/WorkspaceManager";
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

const ONBOARDING_STORAGE_KEY = "sourcenerve.desktop.onboarding.v1";
const EMPTY_PUBLIC_MCP: PublicMcpView = {
  state: "not-enrolled",
  tunnelRunning: false,
};

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
  const [publicMcp, setPublicMcp] = useState<PublicMcpView>(EMPTY_PUBLIC_MCP);
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
        (event.component === "daemon" ||
          event.component === "workspace" ||
          event.component === "auth" ||
          event.component === "git" ||
          event.component === "provider" ||
          event.component === "public-mcp")
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
    const [runtimeResult, daemonResult, managedWorkspaceResult, auth0Result, providerResult, publicMcpResult] = await Promise.all([
      window.sourcenerveDesktop.getRuntimeInfo(),
      window.sourcenerveDesktop.getDaemonState(),
      window.sourcenerveDesktop.listManagedWorkspaces(),
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
      window.sourcenerveDesktop.getPublicMcpState(),
    ]);

    if (runtimeResult.ok) {
      setRuntime(runtimeResult.value);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, productProfileReady: runtimeResult.value.bootstrap.ready, localBearerReady: runtimeResult.value.bootstrap.ready }));
      if (!runtimeResult.value.bootstrap.ready && runtimeResult.value.bootstrap.error) setOnboardingError(`Product Profile: ${runtimeResult.value.bootstrap.error}`);
    } else {
      setRuntime(null);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, productProfileReady: false, localBearerReady: false }));
      setOnboardingError(`Product Profile: ${runtimeResult.error.message}`);
    }

    if (auth0Result.ok) {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, accountConnected: auth0Result.value.status === "authenticated" }));
    } else {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, accountConnected: false }));
      setOnboardingError((currentError) => currentError ?? `Account: ${auth0Result.error.message}`);
    }

    if (publicMcpResult.ok) {
      setPublicMcp(publicMcpResult.value);
      const enrolled = Boolean(publicMcpResult.value.hostname) && publicMcpResult.value.state !== "not-enrolled" && publicMcpResult.value.state !== "revoked";
      const tunnelReady = enrolled && publicMcpResult.value.tunnelRunning && publicMcpResult.value.state !== "offline";
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, enrollmentReady: enrolled, cloudflareReady: tunnelReady }));
    } else {
      setPublicMcp(EMPTY_PUBLIC_MCP);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, enrollmentReady: false, cloudflareReady: false }));
      setOnboardingError((currentError) => currentError ?? `Cloudflare: ${publicMcpResult.error.message}`);
    }

    if (providerResult.ok) {
      const connected = providerResult.value.some((provider) => provider.status === "connected");
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, gitConnected: connected }));
    } else {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, gitConnected: false }));
      setOnboardingError((currentError) => currentError ?? `Git Provider: ${providerResult.error.message}`);
    }

    const activeDaemon = daemonResult.ok ? daemonResult.value : null;
    setDaemon(activeDaemon);
    setOnboardingRuntimeSignals((currentSignals) => ({
      ...currentSignals,
      daemonReady: activeDaemon?.state === "ready" || activeDaemon?.state === "external",
      ...(!activeDaemon || (activeDaemon.state !== "ready" && activeDaemon.state !== "external") ? { indexReady: false } : {}),
    }));

    if (managedWorkspaceResult.ok) {
      const readyWorkspaces = managedWorkspaceResult.value.filter((workspace) => workspace.validation.state === "ready");
      const configured = readyWorkspaces.length > 0;
      const indexed = readyWorkspaces.some((workspace) => workspace.index.state === "current");
      setWorkspaceCount(managedWorkspaceResult.value.length);
      setOnboardingRuntimeSignals((currentSignals) => ({
        ...currentSignals,
        repositorySelected: configured,
        workspaceReady: configured,
        indexReady: (activeDaemon?.state === "ready" || activeDaemon?.state === "external") && indexed,
      }));
    } else {
      setWorkspaceCount(0);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, repositorySelected: false, workspaceReady: false, indexReady: false }));
      setOnboardingError((currentError) => currentError ?? `Workspace: ${managedWorkspaceResult.error.message}`);
    }
  }

  function acknowledgeWelcome(): void {
    const next: OnboardingUiProgress = { schemaVersion: 1, welcomeAcknowledged: true, lastVisitedStep: "account" };
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
    if (onboardingStep === "bootstrap" && onboardingSignals.accountConnected) {
      void window.sourcenerveDesktop.retryPublicMcp().finally(() => void refreshRuntimeState());
      return;
    }
    void refreshRuntimeState();
  }

  const implementedRoute = route === "workspaces" || route === "connections" || route === "settings" || route === "diagnostics" || route === "intelligence" || route === "tasks" || route === "pull-requests";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand"><div className="brand__mark" aria-hidden="true">SN</div><div className="brand__copy"><strong>SourceNerve</strong><span>Repository intelligence</span></div></div>
        <nav className="nav-list">
          {NAVIGATION.map((item) => <a key={item.id} className={`nav-item ${route === item.id ? "nav-item--active" : ""}`} href={routeHash(item.id)} aria-current={route === item.id ? "page" : undefined} title={item.description}><span>{item.label}</span></a>)}
        </nav>
        <div className="sidebar__footer"><StatusBadge label="Development" tone="working" /><span>Desktop MVP</span></div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div><p className="eyebrow">Workspace</p><strong>{workspaceCount > 0 ? `${workspaceCount} registered` : "No workspace selected"}</strong></div>
          <div className="topbar__actions">
            {route === "overview" && !onboardingActive && onboardingStep !== "ready" ? <button className="button button--quiet" type="button" onClick={() => setShowOnboarding(true)}>Continue setup</button> : null}
            <button className="button button--quiet" type="button" onClick={() => setTheme((value) => nextTheme(value))} aria-label={`Theme: ${theme}. Change theme`}>Theme: {theme}</button>
            <StatusBadge label={runtime?.bootstrap.ready ? "Local bootstrap ready" : "Local bootstrap needs attention"} tone={runtime?.bootstrap.ready ? "ready" : "warning"} />
          </div>
        </header>

        <main className="content">
          {onboardingActive ? (
            <OnboardingWizard runtime={runtime} signals={onboardingSignals} error={onboardingError} onAcknowledgeWelcome={acknowledgeWelcome} onUseExistingSetup={useExistingSetup} onOpenConnections={() => openRoute("connections")} onOpenWorkspaces={() => openRoute("workspaces")} onRetryCurrent={retryCurrentOnboardingLayer} />
          ) : (
            <>
              <div className="page-heading">
                <div><p className="eyebrow">SourceNerve Desktop</p><h1>{current.label}</h1><p>{current.description}</p></div>
                {route === "overview" && onboardingStep !== "ready" ? <button className="button" type="button" onClick={() => setShowOnboarding(true)}>Continue setup</button> : implementedRoute ? null : <button className="button" type="button" disabled>Coming in next issue</button>}
              </div>

              {route === "overview" ? <OverviewDashboard />
                : route === "workspaces" ? <WorkspaceManagerScreen onWorkspaceStateChanged={() => void refreshRuntimeState()} />
                : route === "intelligence" ? <IntelligenceExplorer />
                : route === "tasks" ? <TaskWorkflowScreen />
                : route === "pull-requests" ? <ProviderWorkflowScreen />
                : route === "connections" ? <><ConnectionsScreen /><PluginVerificationPanel /></>
                : route === "diagnostics" ? <DiagnosticsScreen />
                : route === "settings" ? <DesktopSettingsScreen />
                : <PlaceholderScreen route={route} />}
            </>
          )}
        </main>

        <footer className="status-strip" aria-label="Runtime status">
          <span><i className="status-dot status-dot--ready" aria-hidden="true" />Desktop API: {runtime ? `v${runtime.apiVersion}` : "Unavailable"}</span>
          <span><i className={`status-dot ${daemonConnected ? "status-dot--ready" : ""}`} aria-hidden="true" />Daemon: {daemon?.state ?? "Unavailable"}</span>
          <span><i className={`status-dot ${publicMcp.state === "ready" ? "status-dot--ready" : ""}`} aria-hidden="true" />Public MCP: {publicMcp.state}</span>
          <span><i className="status-dot" aria-hidden="true" />Setup: {onboardingStep}</span>
          <span>{runtime ? `${runtime.platform}/${runtime.arch}` : "Runtime info unavailable"}</span>
        </footer>
      </div>
    </div>
  );
}

function PlaceholderScreen({ route }: { route: RouteId }) {
  return <Panel title="Planned surface" eyebrow="Desktop MVP"><ul className="feature-list">{PLACEHOLDER_COPY[route].map((item) => <li key={item}>{item}</li>)}</ul><p className="muted">The shell keeps feature ownership separated so account, provider, repository, and mutation behavior can be added without weakening the Desktop security boundary.</p></Panel>;
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
