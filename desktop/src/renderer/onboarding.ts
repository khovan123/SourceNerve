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

export interface OnboardingSignals {
  welcomeAcknowledged: boolean;
  accountConnected: boolean;
  bootstrapReady: boolean;
  gitConnected: boolean;
  repositorySelected: boolean;
  workspaceReady: boolean;
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

export const DEFAULT_ONBOARDING_PROGRESS: OnboardingUiProgress = Object.freeze({
  schemaVersion: 1,
  welcomeAcknowledged: false,
  lastVisitedStep: "welcome",
});

export function recommendedOnboardingStep(signals: OnboardingSignals): OnboardingStep {
  if (!signals.welcomeAcknowledged) return "welcome";
  if (!signals.accountConnected) return "account";
  if (!signals.bootstrapReady) return "bootstrap";
  if (!signals.gitConnected) return "git";
  if (!signals.repositorySelected) return "repository";
  if (!signals.workspaceReady) return "workspace";
  if (!signals.indexReady) return "indexing";
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

export function prerequisiteSatisfied(step: OnboardingStep, signals: OnboardingSignals): boolean {
  switch (step) {
    case "welcome":
      return true;
    case "account":
      return signals.welcomeAcknowledged;
    case "bootstrap":
      return signals.welcomeAcknowledged && signals.accountConnected;
    case "git":
      return signals.welcomeAcknowledged && signals.accountConnected && signals.bootstrapReady;
    case "repository":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        signals.bootstrapReady &&
        signals.gitConnected
      );
    case "workspace":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        signals.bootstrapReady &&
        signals.gitConnected &&
        signals.repositorySelected
      );
    case "indexing":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        signals.bootstrapReady &&
        signals.gitConnected &&
        signals.repositorySelected &&
        signals.workspaceReady
      );
    case "ready":
      return (
        signals.welcomeAcknowledged &&
        signals.accountConnected &&
        signals.bootstrapReady &&
        signals.gitConnected &&
        signals.repositorySelected &&
        signals.workspaceReady &&
        signals.indexReady
      );
  }
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
