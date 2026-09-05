import type { DesktopRuntimeEvent } from "../shared/desktop-api";

export const ONBOARDING_STEPS = [
  "welcome",
  "codex",
  "workspace",
  "ready",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_LAYERS = [
  "product-profile",
  "local-bearer",
  "codex",
  "workspace",
  "daemon",
] as const;

export type OnboardingLayer = (typeof ONBOARDING_LAYERS)[number];

export interface OnboardingSignals {
  welcomeAcknowledged: boolean;
  productProfileReady: boolean;
  localBearerReady: boolean;
  codexInstalled: boolean;
  codexAuthenticated: boolean;
  workspaceReady: boolean;
  daemonReady: boolean;

  // Optional service/integration health. These no longer gate the local Codex chat path.
  accountConnected: boolean;
  enrollmentReady: boolean;
  cloudflareReady: boolean;
  gitConnected: boolean;
  repositorySelected: boolean;
}

export interface OnboardingUiProgress {
  schemaVersion: 1;
  welcomeAcknowledged: boolean;
  lastVisitedStep: OnboardingStep;
}

export type OnboardingStepState = "complete" | "current" | "blocked" | "pending";

export interface OnboardingStepView {
  id: OnboardingStep;
  state: OnboardingStepState;
}

export interface OnboardingLayerView {
  id: OnboardingLayer;
  state: "complete" | "current" | "blocked";
}

export const DEFAULT_ONBOARDING_PROGRESS: OnboardingUiProgress = Object.freeze({
  schemaVersion: 1,
  welcomeAcknowledged: false,
  lastVisitedStep: "welcome",
});

export function emptyOnboardingSignals(welcomeAcknowledged = false): OnboardingSignals {
  return {
    welcomeAcknowledged,
    productProfileReady: false,
    localBearerReady: false,
    codexInstalled: false,
    codexAuthenticated: false,
    workspaceReady: false,
    daemonReady: false,
    accountConnected: false,
    enrollmentReady: false,
    cloudflareReady: false,
    gitConnected: false,
    repositorySelected: false,
  };
}

/** Local product bootstrap health; cloud/public integrations are optional for native Codex chat. */
export function bootstrapLayersReady(signals: OnboardingSignals): boolean {
  return signals.productProfileReady && signals.localBearerReady;
}

export function recommendedOnboardingStep(signals: OnboardingSignals): OnboardingStep {
  if (!signals.welcomeAcknowledged) return "welcome";
  if (!signals.codexInstalled || !signals.codexAuthenticated) return "codex";
  if (!bootstrapLayersReady(signals) || !signals.workspaceReady || !signals.daemonReady) return "workspace";
  return "ready";
}

export function onboardingStepViews(signals: OnboardingSignals): OnboardingStepView[] {
  const current = recommendedOnboardingStep(signals);
  const currentIndex = ONBOARDING_STEPS.indexOf(current);

  return ONBOARDING_STEPS.map((id, index) => ({
    id,
    state:
      current === "ready"
        ? index < currentIndex
          ? "complete"
          : "current"
        : index < currentIndex
          ? "complete"
          : index === currentIndex
            ? "current"
            : prerequisiteSatisfied(id, signals)
              ? "pending"
              : "blocked",
  }));
}

export function onboardingLayerViews(signals: OnboardingSignals): OnboardingLayerView[] {
  let blocked = false;
  return ONBOARDING_LAYERS.map((id) => {
    const complete = layerReady(id, signals);
    if (complete) return { id, state: "complete" };
    if (!blocked) {
      blocked = true;
      return { id, state: "current" };
    }
    return { id, state: "blocked" };
  });
}

export function prerequisiteSatisfied(step: OnboardingStep, signals: OnboardingSignals): boolean {
  switch (step) {
    case "welcome":
      return true;
    case "codex":
      return signals.welcomeAcknowledged;
    case "workspace":
      return signals.welcomeAcknowledged && signals.codexInstalled && signals.codexAuthenticated;
    case "ready":
      return signals.welcomeAcknowledged
        && signals.codexInstalled
        && signals.codexAuthenticated
        && bootstrapLayersReady(signals)
        && signals.workspaceReady
        && signals.daemonReady;
  }
}

export function applyRuntimeEventToSignals(
  signals: OnboardingSignals,
  event: DesktopRuntimeEvent,
): OnboardingSignals {
  const next = { ...signals };
  if (event.type !== "state") return next;
  const state = event.state.toLowerCase();

  if (event.component === "auth") {
    if (["ready", "connected", "authenticated"].includes(state)) next.accountConnected = true;
    if (["signed-out", "disconnected", "expired"].includes(state)) {
      next.accountConnected = false;
      next.enrollmentReady = false;
      next.cloudflareReady = false;
    }
  }

  if (event.component === "public-mcp") {
    if (["enrolled", "checking", "ready"].includes(state)) {
      next.enrollmentReady = true;
      next.cloudflareReady = true;
    }
    if (["offline", "stopped", "crashed"].includes(state)) next.cloudflareReady = false;
    if (["revoked", "not-enrolled"].includes(state)) {
      next.enrollmentReady = false;
      next.cloudflareReady = false;
    }
  }

  if (event.component === "git" || event.component === "provider") {
    if (["ready", "connected"].includes(state)) next.gitConnected = true;
    if (["signed-out", "disconnected"].includes(state)) next.gitConnected = false;
  }

  if (event.component === "workspace") {
    if (state === "repository-selected") next.repositorySelected = true;
    if (["workspace-ready", "ready"].includes(state)) {
      next.repositorySelected = true;
      next.workspaceReady = true;
    }
    if (state === "removed") {
      next.repositorySelected = false;
      next.workspaceReady = false;
    }
  }

  if (event.component === "daemon") {
    next.daemonReady = state === "ready" || state === "external";
  }

  return next;
}

export function sanitizeOnboardingProgress(value: unknown): OnboardingUiProgress {
  if (!value || typeof value !== "object") return { ...DEFAULT_ONBOARDING_PROGRESS };
  const candidate = value as { schemaVersion?: unknown; welcomeAcknowledged?: unknown; lastVisitedStep?: unknown };
  if (candidate.schemaVersion !== 1 || typeof candidate.welcomeAcknowledged !== "boolean") {
    return { ...DEFAULT_ONBOARDING_PROGRESS };
  }

  const migrated = migrateLegacyStep(candidate.lastVisitedStep);
  if (!migrated) return { ...DEFAULT_ONBOARDING_PROGRESS };
  return {
    schemaVersion: 1,
    welcomeAcknowledged: candidate.welcomeAcknowledged,
    lastVisitedStep: migrated,
  };
}

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

function migrateLegacyStep(value: unknown): OnboardingStep | null {
  if (isOnboardingStep(value)) return value;
  if (["account", "bootstrap", "git", "runtime", "indexing"].includes(String(value))) return "codex";
  if (String(value) === "repository") return "workspace";
  return null;
}

function layerReady(layer: OnboardingLayer, signals: OnboardingSignals): boolean {
  switch (layer) {
    case "product-profile":
      return signals.productProfileReady;
    case "local-bearer":
      return signals.localBearerReady;
    case "codex":
      return signals.codexInstalled && signals.codexAuthenticated;
    case "workspace":
      return signals.workspaceReady;
    case "daemon":
      return signals.daemonReady;
  }
}
