import { useEffect, useRef, useState } from "react";

import type {
  DaemonSnapshot,
  PublicMcpView,
  RuntimeInfo,
} from "../shared/desktop-api";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { DesktopSettingsScreen } from "./components/DesktopSettings";
import { DiagnosticsScreen } from "./components/DiagnosticsScreen";
import { HarnessScreen } from "./components/HarnessScreen";
import { McpScreen } from "./components/McpScreen";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { OverviewDashboard } from "./components/OverviewDashboard";
import { Panel } from "./components/Panel";
import { PluginHubScreen } from "./components/PluginHubScreen";
import { PluginVerificationPanel } from "./components/PluginVerificationPanel";
import { ProviderWorkflowScreen } from "./components/ProviderWorkflowScreen";
import { WorkspaceManagerScreen } from "./components/WorkspaceManager";
import { ActionButton } from "./components/atoms/ActionButton";
import { DesktopShell } from "./components/templates/DesktopShell";
import type { ThemePreference } from "./components/organisms/AppTopbar";
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
  routeFromHash,
  routeHash,
  type RouteId,
} from "./navigation";

const ONBOARDING_STORAGE_KEY = "sourcenerve.desktop.onboarding.v1";
const EMPTY_PUBLIC_MCP: PublicMcpView = {
  state: "not-enrolled",
  tunnelRunning: false,
};

const PLACEHOLDER_COPY: Record<RouteId, string[]> = {
  overview: ["SourceNerve Account", "Git Provider", "SourceNerve Daemon", "Public MCP", "Workspace Health"],
  workspaces: ["Choose repositories and local checkouts", "Create SourceNerve workspaces without editing TOML", "See access, branch and HEAD state"],
  mcp: ["Explore the Official MCP Registry", "Install and govern downstream MCP extensions", "Expose approved tools through the SourceNerve gateway"],
  plugins: ["Explore declarative plugin packages", "Install skills and bundled MCP components", "Manage plugin lifecycle independently from MCP"],
  harness: ["Inspect durable runs and recovery state", "Review ordered safe events and jobs", "Resolve exact one-shot approvals"],
  "pull-requests": ["Browse pull requests across managed repositories", "Filter open, closed, or all provider state", "Open a pull request in GitHub or GitLab"],
  connections: ["SourceNerve Account (Auth0)", "GitHub / GitLab", "ChatGPT Plugin", "Public MCP"],
  diagnostics: ["Sanitized Desktop, daemon, auth and tunnel logs", "Readiness and version diagnostics", "Explicit recovery and support-bundle actions"],
  settings: ["Appearance", "Startup & Background", "Updates", "Notifications", "Advanced Diagnostics"],
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
  const [onboardingRuntimeSignals, setOnboardingRuntimeSignals] = useState<OnboardingSignals>(() => emptyOnboardingSignals());
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingUiProgress>(loadOnboardingProgress);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const runtimeRefreshGeneration = useRef(0);

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
    const unsubscribe = window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      setOnboardingRuntimeSignals((current) => applyRuntimeEventToSignals(current, event));
      if (event.type === "state" && (event.component === "daemon" || event.component === "workspace" || event.component === "auth" || event.component === "git" || event.component === "provider" || event.component === "public-mcp")) {
        void refreshRuntimeState();
      }
    });
    return () => unsubscribe();
  }, []);

  const onboardingSignals: OnboardingSignals = { ...onboardingRuntimeSignals, welcomeAcknowledged: onboardingProgress.welcomeAcknowledged };
  const onboardingStep = recommendedOnboardingStep(onboardingSignals);
  const onboardingActive = route === "overview" && showOnboarding && onboardingStep !== "ready";

  useEffect(() => {
    if (onboardingProgress.lastVisitedStep === onboardingStep) return;
    const next = { ...onboardingProgress, lastVisitedStep: onboardingStep };
    setOnboardingProgress(next);
    saveOnboardingProgress(next);
  }, [onboardingProgress, onboardingStep]);

  async function refreshRuntimeState(): Promise<void> {
    const generation = ++runtimeRefreshGeneration.current;
    const [runtimeResult, daemonResult, managedWorkspaceResult, auth0Result, providerResult, publicMcpResult] = await Promise.all([
      window.sourcenerveDesktop.getRuntimeInfo(),
      window.sourcenerveDesktop.getDaemonState(),
      window.sourcenerveDesktop.listManagedWorkspaces(),
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
      window.sourcenerveDesktop.getPublicMcpState(),
    ]);
    if (generation !== runtimeRefreshGeneration.current) return;
    setOnboardingError(null);

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
    }));

    if (managedWorkspaceResult.ok) {
      const readyWorkspaces = managedWorkspaceResult.value.filter((workspace) => workspace.validation.state === "ready");
      const configured = readyWorkspaces.length > 0;
      setWorkspaceCount(managedWorkspaceResult.value.length);
      setOnboardingRuntimeSignals((currentSignals) => ({
        ...currentSignals,
        repositorySelected: configured,
        workspaceReady: configured,
      }));
    } else {
      setWorkspaceCount(0);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, repositorySelected: false, workspaceReady: false }));
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

  async function finishRetry(error?: string): Promise<void> {
    await refreshRuntimeState();
    if (error) setOnboardingError(error);
  }

  async function retryCurrentOnboardingLayer(): Promise<void> {
    setOnboardingError(null);

    if (onboardingStep === "bootstrap" && onboardingSignals.accountConnected) {
      const result = await window.sourcenerveDesktop.retryPublicMcp();
      await finishRetry(result.ok ? undefined : result.error.message);
      return;
    }

    if (onboardingStep === "runtime") {
      const daemonResult = await window.sourcenerveDesktop.getDaemonState();
      if (!daemonResult.ok) {
        await finishRetry(daemonResult.error.message);
        return;
      }
      if (daemonResult.value.state === "stopped" || daemonResult.value.state === "crashed") {
        const startResult = await window.sourcenerveDesktop.startDaemon();
        await finishRetry(startResult.ok ? undefined : startResult.error.message);
        return;
      }
      await finishRetry(
        daemonResult.value.state === "ready" || daemonResult.value.state === "external"
          ? undefined
          : daemonResult.value.message ?? `SourceNerve daemon is ${daemonResult.value.state}.`,
      );
      return;
    }

    await refreshRuntimeState();
  }

  const showContinueSetup = route === "overview" && onboardingStep !== "ready" && !showOnboarding;

  return (
    <DesktopShell
      route={route}
      workspaceCount={workspaceCount}
      theme={theme}
      runtime={runtime}
      daemon={daemon}
      publicMcp={publicMcp}
      setupStep={onboardingStep}
      onCycleTheme={() => setTheme((value) => nextTheme(value))}
    >
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
      ) : (
        <>
          {showContinueSetup ? (
            <div className="mb-4 flex justify-end">
              <ActionButton onClick={() => setShowOnboarding(true)}>Continue setup</ActionButton>
            </div>
          ) : null}
          {route === "overview" ? <OverviewDashboard />
            : route === "workspaces" ? (
              <WorkspaceManagerScreen
                onWorkspaceStateChanged={() => void refreshRuntimeState()}
              />
            )
            : route === "mcp" ? <McpScreen />
            : route === "plugins" ? <PluginHubScreen />
            : route === "harness" ? <HarnessScreen />
            : route === "pull-requests" ? <ProviderWorkflowScreen />
            : route === "connections" ? <><ConnectionsScreen /><PluginVerificationPanel /></>
            : route === "diagnostics" ? <DiagnosticsScreen />
            : route === "settings" ? <DesktopSettingsScreen />
            : <PlaceholderScreen route={route} />}
        </>
      )}
    </DesktopShell>
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
