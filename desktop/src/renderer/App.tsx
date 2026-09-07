import { useEffect, useRef, useState } from "react";

import type { Auth0SessionView, ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopHarnessCodexAccountView, DesktopHarnessCodexSetupView } from "../shared/harness-api";
import { HarnessScreen } from "./components/HarnessScreen";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { Panel } from "./components/Panel";
import { ProviderWorkflowScreen } from "./components/ProviderWorkflowScreen";
import { SettingsModal } from "./components/SettingsModal";
import { ActionButton } from "./components/atoms/ActionButton";
import { DesktopShell } from "./components/templates/DesktopShell";
import {
  DEFAULT_ONBOARDING_PROGRESS,
  applyRuntimeEventToSignals,
  codexChatgptReady,
  emptyOnboardingSignals,
  recommendedOnboardingStep,
  sanitizeOnboardingProgress,
  type OnboardingSignals,
  type OnboardingUiProgress,
} from "./onboarding";
import {
  routeFromHash,
  routeHash,
  settingsSectionForRoute,
  type RouteId,
  type SettingsSectionId,
} from "./navigation";

type ThemePreference = "system" | "light" | "dark";

const ONBOARDING_STORAGE_KEY = "sourcenerve.desktop.onboarding.v1";
const PLACEHOLDER_COPY: Record<RouteId, string[]> = {
  mcp: ["Explore the Official MCP Registry", "Install and govern downstream MCP extensions", "Expose approved tools through the SourceNerve gateway"],
  plugins: ["Explore declarative plugin packages", "Install skills and bundled MCP components", "Manage plugin lifecycle independently from MCP"],
  harness: ["Inspect durable runs and recovery state", "Review ordered safe events and jobs", "Resolve exact one-shot approvals"],
  "pull-requests": ["Browse pull requests across managed repositories", "Filter open, closed, or all provider state", "Open a pull request in GitHub or GitLab"],
  connections: ["SourceNerve Account (Auth0)", "GitHub / GitLab", "ChatGPT Plugin", "Public MCP"],
  settings: ["Appearance", "Startup & Background", "Updates", "Notifications"],
};

export function App() {
  const [route, setRoute] = useState<RouteId>(() => {
    const requested = routeFromHash(window.location.hash);
    return settingsSectionForRoute(requested) ? "harness" : requested;
  });
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [auth, setAuth] = useState<Auth0SessionView>({ status: "signed-out" });
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(() => Boolean(settingsSectionForRoute(routeFromHash(window.location.hash))));
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(() => settingsSectionForRoute(routeFromHash(window.location.hash)) ?? "general");
  const [codexSetup, setCodexSetup] = useState<DesktopHarnessCodexSetupView | null>(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingRuntimeSignals, setOnboardingRuntimeSignals] = useState<OnboardingSignals>(() => emptyOnboardingSignals());
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingUiProgress>(loadOnboardingProgress);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const runtimeRefreshGeneration = useRef(0);

  useEffect(() => {
    const onHashChange = () => {
      const requested = routeFromHash(window.location.hash);
      const modalSection = settingsSectionForRoute(requested);
      if (modalSection) {
        setSettingsSection(modalSection);
        setSettingsOpen(true);
        return;
      }
      setSettingsOpen(false);
      setRoute(requested);
    };
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = routeHash("harness");
    else onHashChange();
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
  const onboardingActive = route === "harness" && showOnboarding && onboardingStep !== "ready";

  useEffect(() => {
    if (onboardingProgress.lastVisitedStep === onboardingStep) return;
    const next = { ...onboardingProgress, lastVisitedStep: onboardingStep };
    setOnboardingProgress(next);
    saveOnboardingProgress(next);
  }, [onboardingProgress, onboardingStep]);

  async function refreshRuntimeState(): Promise<void> {
    const generation = ++runtimeRefreshGeneration.current;
    const [runtimeResult, daemonResult, managedWorkspaceResult, auth0Result, providerResult, publicMcpResult, codexSetupResult] = await Promise.all([
      window.sourcenerveDesktop.getRuntimeInfo(),
      window.sourcenerveDesktop.getDaemonState(),
      window.sourcenerveDesktop.listManagedWorkspaces(),
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
      window.sourcenerveDesktop.getPublicMcpState(),
      window.sourcenerveDesktop.getHarnessCodexSetup(),
    ]);
    if (generation !== runtimeRefreshGeneration.current) return;
    setOnboardingError(null);

    const readyWorkspaces = managedWorkspaceResult.ok
      ? managedWorkspaceResult.value.filter((workspace) => workspace.validation.state === "ready" && workspace.access === "read-write" && workspace.localWritable)
      : [];
    const setupConfirmsChatgpt = codexSetupResult.ok && codexChatgptReady(codexSetupResult.value);
    let nativeCodexAccount: DesktopHarnessCodexAccountView | null = null;

    if (!setupConfirmsChatgpt && readyWorkspaces[0]) {
      const nativeAccountResult = await window.sourcenerveDesktop.getHarnessCodexAccount({ workspace: readyWorkspaces[0].id });
      if (generation !== runtimeRefreshGeneration.current) return;
      if (nativeAccountResult.ok) nativeCodexAccount = nativeAccountResult.value;
    }

    const nativeConfirmsChatgpt = codexChatgptReady(nativeCodexAccount);
    const codexAuthenticated = codexChatgptReady(codexSetupResult.ok ? codexSetupResult.value : null, nativeCodexAccount);

    if (codexSetupResult.ok) {
      const resolvedSetup: DesktopHarnessCodexSetupView = nativeConfirmsChatgpt && !setupConfirmsChatgpt
        ? { ...codexSetupResult.value, installed: true, authenticated: true, accountType: "chatgpt" }
        : codexSetupResult.value;
      setCodexSetup(resolvedSetup);
      setOnboardingRuntimeSignals((currentSignals) => ({
        ...currentSignals,
        codexInstalled: resolvedSetup.installed || nativeConfirmsChatgpt,
        codexAuthenticated,
      }));
    } else if (nativeConfirmsChatgpt) {
      setCodexSetup({ installed: true, authenticated: true, accountType: "chatgpt", canInstall: false });
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, codexInstalled: true, codexAuthenticated: true }));
    } else {
      setCodexSetup(null);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, codexInstalled: false, codexAuthenticated: false }));
      setOnboardingError(`Codex: ${codexSetupResult.error.message}`);
    }

    if (runtimeResult.ok) {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, productProfileReady: runtimeResult.value.bootstrap.ready, localBearerReady: runtimeResult.value.bootstrap.ready }));
      if (!runtimeResult.value.bootstrap.ready && runtimeResult.value.bootstrap.error) setOnboardingError(`Product Profile: ${runtimeResult.value.bootstrap.error}`);
    } else {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, productProfileReady: false, localBearerReady: false }));
      setOnboardingError(`Product Profile: ${runtimeResult.error.message}`);
    }

    if (auth0Result.ok) {
      setAuth(auth0Result.value);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, accountConnected: auth0Result.value.status === "authenticated" }));
    } else {
      setAuth({ status: "signed-out" });
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, accountConnected: false }));
    }

    if (publicMcpResult.ok) {
      const enrolled = Boolean(publicMcpResult.value.hostname) && publicMcpResult.value.state !== "not-enrolled" && publicMcpResult.value.state !== "revoked";
      const tunnelReady = enrolled && publicMcpResult.value.tunnelRunning && publicMcpResult.value.state !== "offline";
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, enrollmentReady: enrolled, cloudflareReady: tunnelReady }));
    } else {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, enrollmentReady: false, cloudflareReady: false }));
    }

    if (providerResult.ok) {
      const connected = providerResult.value.some((provider) => provider.status === "connected");
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, gitConnected: connected }));
    } else {
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, gitConnected: false }));
    }

    const activeDaemon = daemonResult.ok ? daemonResult.value : null;
    setOnboardingRuntimeSignals((currentSignals) => ({
      ...currentSignals,
      daemonReady: activeDaemon?.state === "ready" || activeDaemon?.state === "external",
    }));

    if (managedWorkspaceResult.ok) {
      setWorkspaces(managedWorkspaceResult.value);
      const configured = readyWorkspaces.length > 0;
      setSelectedWorkspaceId((current) => {
        if (current && managedWorkspaceResult.value.some((workspace) => workspace.id === current)) return current;
        return readyWorkspaces[0]?.id ?? managedWorkspaceResult.value[0]?.id ?? null;
      });
      setOnboardingRuntimeSignals((currentSignals) => ({
        ...currentSignals,
        repositorySelected: configured,
        workspaceReady: configured,
      }));
    } else {
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setOnboardingRuntimeSignals((currentSignals) => ({ ...currentSignals, repositorySelected: false, workspaceReady: false }));
      setOnboardingError((currentError) => currentError ?? `Workspace: ${managedWorkspaceResult.error.message}`);
    }
  }

  function acknowledgeWelcome(): void {
    const next: OnboardingUiProgress = { schemaVersion: 1, welcomeAcknowledged: true, lastVisitedStep: "codex" };
    setOnboardingProgress(next);
    saveOnboardingProgress(next);
  }

  function useExistingSetup(): void {
    acknowledgeWelcome();
    void refreshRuntimeState();
  }

  function openRoute(nextRoute: RouteId): void {
    setShowOnboarding(false);
    window.location.hash = routeHash(nextRoute);
  }

  function selectWorkspace(workspaceId: string): void {
    setSelectedWorkspaceId(workspaceId);
    openRoute("harness");
  }

  async function installCodex(): Promise<void> {
    setOnboardingError(null);
    const result = await window.sourcenerveDesktop.installHarnessCodex();
    if (!result.ok) {
      setOnboardingError(`Codex: ${result.error.message}`);
      return;
    }
    setCodexSetup(result.value);
    setOnboardingRuntimeSignals((current) => ({
      ...current,
      codexInstalled: result.value.installed,
      codexAuthenticated: result.value.authenticated && result.value.accountType === "chatgpt",
    }));
  }

  async function loginCodex(): Promise<void> {
    setOnboardingError(null);
    const result = await window.sourcenerveDesktop.loginHarnessCodex();
    if (!result.ok) {
      setOnboardingError(`Codex: ${result.error.message}`);
      return;
    }
    setCodexSetup(result.value);
    setOnboardingRuntimeSignals((current) => ({
      ...current,
      codexInstalled: result.value.installed,
      codexAuthenticated: result.value.authenticated && result.value.accountType === "chatgpt",
    }));
  }

  async function retryCurrentOnboardingLayer(): Promise<void> {
    setOnboardingError(null);
    if (onboardingStep === "workspace" && !onboardingSignals.daemonReady) {
      const daemonResult = await window.sourcenerveDesktop.getDaemonState();
      if (daemonResult.ok && (daemonResult.value.state === "stopped" || daemonResult.value.state === "crashed")) {
        const startResult = await window.sourcenerveDesktop.startDaemon();
        if (!startResult.ok) setOnboardingError(`Runtime: ${startResult.error.message}`);
      }
    }
    await refreshRuntimeState();
  }

  const showContinueSetup = route === "harness" && onboardingStep !== "ready" && !showOnboarding;

  function openSettings(section: SettingsSectionId = "general"): void {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  function closeSettings(): void {
    setSettingsOpen(false);
    if (settingsSectionForRoute(routeFromHash(window.location.hash))) {
      window.location.hash = routeHash(route);
    }
  }

  async function logoutAccount(): Promise<void> {
    const result = await window.sourcenerveDesktop.logoutAuth0();
    if (!result.ok) {
      setOnboardingError(`Account: ${result.error.message}`);
      return;
    }
    setAuth(result.value);
    await refreshRuntimeState();
  }

  return (
    <>
      <DesktopShell
        route={route}
        auth={auth}
        workspaces={workspaces}
        selectedWorkspaceId={selectedWorkspaceId}
        onWorkspaceSelect={selectWorkspace}
        onOpenSettings={openSettings}
        onLogout={() => void logoutAccount()}
      >
      {onboardingActive ? (
        <OnboardingWizard
          signals={onboardingSignals}
          codexSetup={codexSetup}
          error={onboardingError}
          onAcknowledgeWelcome={acknowledgeWelcome}
          onUseExistingSetup={useExistingSetup}
          onOpenWorkspaces={() => openRoute("harness")}
          onOpenHarness={() => openRoute("harness")}
          onInstallCodex={installCodex}
          onLoginCodex={loginCodex}
          onRetryCurrent={retryCurrentOnboardingLayer}
        />
      ) : (
        <>
          {showContinueSetup ? (
            <div className="mb-4 flex justify-end">
              <ActionButton onClick={() => setShowOnboarding(true)}>Continue setup</ActionButton>
            </div>
          ) : null}
          {route === "harness" ? (
              <HarnessScreen
                workspaces={workspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onWorkspaceSelected={setSelectedWorkspaceId}
                onWorkspacesChanged={refreshRuntimeState}
              />
            )
            : route === "pull-requests" ? <ProviderWorkflowScreen />
            : <PlaceholderScreen route={route} />}
        </>
      )}
      </DesktopShell>
      <SettingsModal
        open={settingsOpen}
        section={settingsSection}
        theme={theme}
        onThemeChange={setTheme}
        onSectionChange={setSettingsSection}
        onClose={closeSettings}
      />
    </>
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
