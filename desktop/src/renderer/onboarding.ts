import type { DesktopRuntimeEvent } from "../shared/desktop-api";

export const ONBOARDING_STEPS = [
  "welcome",
  "account",
  "bootstrap",
  "git",
  "repository",
  "workspace",
  "indexing",
  "ready",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const ONBOARDING_LAYERS = [
  "product-profile",
  "local-bearer",
  "auth0",
  "enrollment",
  "cloudflare",
  "git",
  "repository",
  "workspace",
  "daemon",
  "index",
] as const;

export type OnboardingLayer = (typeof ONBOARDING_LAYERS)[number];

export interface OnboardingSignals {
  welcomeAcknowledged: boolean;
  productProfileReady: boolean;
  localBearerReady: boolean;
  accountConnected: boolean;
  enrollmentReady: boolean;
  cloudflareReady: boolean;
  gitConnected: boolean;
  repositorySelected: boolean;
  workspaceReady: boolean;
  daemonReady: boolean;
  indexReady: boolean;
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
    accountConnected: false,
    enrollmentReady: false,
    cloudflareReady: false,
    gitConnected: false,
    repositorySelected: false,
    workspaceReady: false,
    daemonReady: false,
    indexReady: false,
  };
}

export function bootstrapLayersReady(signals: OnboardingSignals): boolean {
  return (
    signals.productProfileReady &&
    signals.localBearerReady &&
    signals.enrollmentReady &&
    signals.cloudflareReady
  );
}

export function indexingLayersReady(signals: OnboardingSignals): boolean {
  return signals.daemonReady && signals.indexReady;
}

export function recommendedOnboardingStep(signals: OnboardingSignals): OnboardingStep {
  if (!signals.welcomeAcknowledged) return "welcome";
  if (!signals.accountConnected) return "account";
  if (!bootstrapLayersReady(signals)) return "bootstrap";
  if (!signals.gitConnected) return "git";
  if (!signals.repositorySelected) return "repository";
  if (!signals.workspaceReady) return "workspace";
  if (!indexingLayersReady(signals)) return "indexing";
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
    case "account":
      return signals.welcomeAcknowledged;
    case "bootstrap":
      return signals.welcomeAcknowledged && signals.accountConnected;
    case "git":
      return signals.welcomeAcknowledged && signals.accountConnected && bootstrapLayersReady(signals);
    case "repository":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        bootstrapLayersReady(signals) &&
        signals.gitConnected
      );
    case "workspace":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        bootstrapLayersReady(signals) &&
        signals.gitConnected &&
        signals.repositorySelected
      );
    case "indexing":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        bootstrapLayersReady(signals) &&
        signals.gitConnected &&
        signals.repositorySelected &&
        signals.workspaceReady
      );
    case "ready":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        bootstrapLayersReady(signals) &&
        signals.gitConnected &&
        signals.repositorySelected &&
        signals.workspaceReady &&
        indexingLayersReady(signals)
      );
  }
}

export function applyRuntimeEventToSignals(
  signals: OnboardingSignals,
  event: DesktopRuntimeEvent,
): OnboardingSignals {
  const next = { ...signals };
  if (event.type === "progress") {
    const stage = event.stage.toLowerCase();
    if (stage === "index-ready" || stage === "indexed" || stage === "index-complete") {
      next.indexReady = true;
    }
    return next;
  }

  if (event.type !== "state") return next;
  const state = event.state.toLowerCase();

  if (event.component === "auth") {
    if (["ready", "connected", "authenticated"].includes(state)) next.accountConnected = true;
    if (["signed-out", "disconnected", "expired"].includes(state)) next.accountConnected = false;
  }

  if (event.component === "public-mcp") {
    if (state === "enrolled") next.enrollmentReady = true;
    if (state === "ready") {
      next.enrollmentReady = true;
      next.cloudflareReady = true;
    }
    if (["offline", "degraded"].includes(state)) next.cloudflareReady = false;
    if (state === "revoked") {
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
    if (["indexed", "index-ready"].includes(state)) {
      next.repositorySelected = true;
      next.workspaceReady = true;
      next.indexReady = true;
    }
    if (state === "removed") {
      next.repositorySelected = false;
      next.workspaceReady = false;
      next.indexReady = false;
    }
  }

  if (event.component === "daemon") {
    next.daemonReady = state === "ready" || state === "external";
  }

  return next;
}

export function sanitizeOnboardingProgress(value: unknown): OnboardingUiProgress {
  if (!value || typeof value !== "object") return { ...DEFAULT_ONBOARDING_PROGRESS };
  const candidate = value as Partial<OnboardingUiProgress>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.welcomeAcknowledged !== "boolean" ||
    !isOnboardingStep(candidate.lastVisitedStep)
  ) {
    return { ...DEFAULT_ONBOARDING_PROGRESS };
  }
  return {
    schemaVersion: 1,
    welcomeAcknowledged: candidate.welcomeAcknowledged,
    lastVisitedStep: candidate.lastVisitedStep,
  };
}

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

function layerReady(layer: OnboardingLayer, signals: OnboardingSignals): boolean {
  switch (layer) {
    case "product-profile":
      return signals.productProfileReady;
    case "local-bearer":
      return signals.localBearerReady;
    case "auth0":
      return signals.accountConnected;
    case "enrollment":
      return signals.enrollmentReady;
    case "cloudflare":
      return signals.cloudflareReady;
    case "git":
      return signals.gitConnected;
    case "repository":
      return signals.repositorySelected;
    case "workspace":
      return signals.workspaceReady;
    case "daemon":
      return signals.daemonReady;
    case "index":
      return signals.indexReady;
  }
}
