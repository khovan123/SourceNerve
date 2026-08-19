import { useEffect, useMemo, useState } from "react";

import type { DaemonSnapshot, ReadinessPayload, RuntimeInfo } from "../shared/desktop-api";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { Panel } from "./components/Panel";
import { StatusBadge, type StatusTone } from "./components/StatusBadge";
import {
  DEFAULT_ONBOARDING_PROGRESS,
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
  const [daemonBusy, setDaemonBusy] = useState(false);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [workspaceCount, setWorkspaceCount] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingUiProgress>(loadOnboardingProgress);
  const [showOnboarding, setShowOnboarding] = useState(true);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) {
      window.location.hash = routeHash("overview");
    }
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    void refreshRuntimeState();

    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type !== "state") return;
      if (event.component === "daemon" || event.component === "workspace") {
        void refreshRuntimeState();
      }
    });
  }, []);

  const current = useMemo(() => navigationItem(route), [route]);
  const daemonConnected = daemon?.state === "ready" || daemon?.state === "external";
  const onboardingSignals: OnboardingSignals = {
    welcomeAcknowledged: onboardingProgress.welcomeAcknowledged,
    accountConnected: false,
    bootstrapReady: runtime?.bootstrap.ready === true,
    gitConnected: false,
    repositorySelected: workspaceCount > 0,
    workspaceReady: workspaceCount > 0,
    indexReady,
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
    const [runtimeResult, daemonResult, workspaceResult] = await Promise.all([
      window.sourcenerveDesktop.getRuntimeInfo(),
      window.sourcenerveDesktop.getDaemonState(),
      window.sourcenerveDesktop.listWorkspaces(),
    ]);
    setRuntime(runtimeResult.ok ? runtimeResult.value : null);
    if (daemonResult.ok) setDaemon(daemonResult.value);
    if (workspaceResult.ok) setWorkspaceCount(workspaceResult.value.length);

    const activeDaemon = daemonResult.ok ? daemonResult.value : null;
    if (activeDaemon?.state === "ready" || activeDaemon?.state === "external") {
      const readiness = await window.sourcenerveDesktop.getReadiness();
      setIndexReady(readiness.ok && readinessIsReady(readiness.value));
    } else {
      setIndexReady(false);
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
      } else {
        setDaemonError(result.error.message);
      }
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

  function openRoute(nextRoute: RouteId): void {
    setShowOnboarding(false);
    window.location.hash = routeHash(nextRoute);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            SN
          </div>
          <div className="brand__copy">
            <strong>SourceNerve</strong>
            <span>Repository intelligence</span>
          </div>
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

        <div className="sidebar__footer">
          <StatusBadge label="Development" tone="working" />
          <span>Desktop MVP</span>
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <strong>{workspaceCount > 0 ? `${workspaceCount} configured` : "No workspace selected"}</strong>
          </div>
          <div className="topbar__actions">
            {route === "overview" && !onboardingActive && onboardingStep !== "ready" ? (
              <button className="button button--quiet" type="button" onClick={() => setShowOnboarding(true)}>
                Continue setup
              </button>
            ) : null}
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setTheme((value) => nextTheme(value))}
              aria-label={`Theme: ${theme}. Change theme`}
            >
              Theme: {theme}
            </button>
            <StatusBadge
              label={runtime?.bootstrap.ready ? "Bootstrap ready" : "Bootstrap needs attention"}
              tone={runtime?.bootstrap.ready ? "ready" : "warning"}
            />
          </div>
        </header>

        <main className="content">
          {onboardingActive ? (
            <OnboardingWizard
              runtime={runtime}
              signals={onboardingSignals}
              onAcknowledgeWelcome={acknowledgeWelcome}
              onUseExistingSetup={() => openRoute("workspaces")}
              onOpenConnections={() => openRoute("connections")}
              onOpenWorkspaces={() => openRoute("workspaces")}
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">SourceNerve Desktop</p>
                  <h1>{current.label}</h1>
                  <p>{current.description}</p>
                </div>
                {route === "overview" && onboardingStep !== "ready" ? (
                  <button className="button" type="button" onClick={() => setShowOnboarding(true)}>
                    Continue setup
                  </button>
                ) : (
                  <button className="button" type="button" disabled>
                    Coming in next issue
                  </button>
                )}
              </div>

              {route === "overview" ? (
                <Overview
                  runtime={runtime}
                  daemon={daemon}
                  daemonBusy={daemonBusy}
                  daemonError={daemonError}
                  runDaemonAction={runDaemonAction}
                />
              ) : (
                <PlaceholderScreen route={route} />
              )}
            </>
          )}
        </main>

        <footer className="status-strip" aria-label="Runtime status">
          <span>
            <i className="status-dot status-dot--ready" aria-hidden="true" />
            Desktop API: {runtime ? `v${runtime.apiVersion}` : "Unavailable"}
          </span>
          <span>
            <i
              className={`status-dot ${daemonConnected ? "status-dot--ready" : ""}`}
              aria-hidden="true"
            />
            Daemon: {daemon?.state ?? "Unavailable"}
          </span>
          <span>
            <i className="status-dot" aria-hidden="true" />
            Setup: {onboardingStep}
          </span>
          <span>{runtime ? `${runtime.platform}/${runtime.arch}` : "Runtime info unavailable"}</span>
        </footer>
      </div>
    </div>
  );
}

function Overview({
  runtime,
  daemon,
  daemonBusy,
  daemonError,
  runDaemonAction,
}: {
  runtime: RuntimeInfo | null;
  daemon: DaemonSnapshot | null;
  daemonBusy: boolean;
  daemonError: string | null;
  runDaemonAction(action: DaemonAction): Promise<void>;
}) {
  const state = daemon?.state ?? "stopped";
  const transitionBusy = daemonBusy || state === "starting" || state === "stopping";
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "ready" && daemon?.managed === true;
  const canRestart = state === "ready" && daemon?.managed === true;
  const canAttach = state === "external";

  return (
    <div className="dashboard-grid">
      <Panel title="SourceNerve Account" eyebrow="Identity">
        <div className="metric-row">
          <StatusBadge label="Not signed in" tone="neutral" />
          <span>Native SourceNerve account sign-in is not enabled in this build yet.</span>
        </div>
      </Panel>

      <Panel title="Git Provider" eyebrow="Repository access">
        <div className="metric-row">
          <StatusBadge label="Not connected" tone="neutral" />
          <span>GitHub/GitLab login remains isolated from SourceNerve account identity.</span>
        </div>
      </Panel>

      <Panel title="SourceNerve Daemon" eyebrow="Local runtime">
        <div className="metric-row">
          <StatusBadge label={state} tone={daemonTone(state)} />
          <span>{daemon?.message ?? "Desktop owns the bundled SourceNerve runtime."}</span>
        </div>
        <dl className="facts">
          <div>
            <dt>Version</dt>
            <dd>{daemon?.version ?? "—"}</dd>
          </div>
          <div>
            <dt>Process</dt>
            <dd>{daemon?.pid ? `PID ${daemon.pid}` : daemon?.managed ? "Managed" : "External / idle"}</dd>
          </div>
          <div>
            <dt>Desktop</dt>
            <dd>{runtime?.desktopVersion ?? "—"}</dd>
          </div>
        </dl>
        <div className="topbar__actions">
          {canStart ? (
            <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("start")}>
              Start daemon
            </button>
          ) : null}
          {canRestart ? (
            <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("restart")}>
              Restart
            </button>
          ) : null}
          {canStop ? (
            <button className="button button--quiet" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("stop")}>
              Stop
            </button>
          ) : null}
          {canAttach ? (
            <button className="button" type="button" disabled={transitionBusy} onClick={() => void runDaemonAction("attach")}>
              Attach external
            </button>
          ) : null}
        </div>
        {daemonError ? <p className="muted" role="alert">{daemonError}</p> : null}
      </Panel>

      <Panel title="Public MCP" eyebrow="Plugin connectivity">
        <div className="metric-row">
          <StatusBadge label="Not enrolled" tone="neutral" />
          <span>Public MCP enrollment remains a trusted-main lifecycle, not a token-entry form.</span>
        </div>
      </Panel>

      <Panel title="Workspaces" eyebrow="Repository health">
        <div className="empty-state">
          <strong>No workspace selected</strong>
          <p>
            Workspace creation and repository validation are handled by the dedicated workspace flow.
            The managed daemon becomes launch-ready after a valid runtime profile exists.
          </p>
        </div>
      </Panel>
    </div>
  );
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
      <ul className="feature-list">
        {PLACEHOLDER_COPY[route].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="muted">
        The shell keeps feature ownership separated so account, provider, repository, and mutation
        behavior can be added without weakening the Desktop security boundary.
      </p>
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

function readinessIsReady(payload: ReadinessPayload): boolean {
  return payload.ready === true;
}
