import { describe, expect, it } from "vitest";

import {
  DEFAULT_ONBOARDING_PROGRESS,
  onboardingStepViews,
  recommendedOnboardingStep,
  sanitizeOnboardingProgress,
  type OnboardingSignals,
} from "./onboarding";

function signals(overrides: Partial<OnboardingSignals> = {}): OnboardingSignals {
  return {
    welcomeAcknowledged: false,
    accountConnected: false,
    bootstrapReady: false,
    gitConnected: false,
    repositorySelected: false,
    workspaceReady: false,
    indexReady: false,
    ...overrides,
  };
}

describe("Desktop onboarding state", () => {
  it("advances only through the ordered zero-config flow", () => {
    expect(recommendedOnboardingStep(signals())).toBe("welcome");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true }))).toBe("account");
    expect(
      recommendedOnboardingStep(
        signals({ welcomeAcknowledged: true, accountConnected: true }),
      ),
    ).toBe("bootstrap");
    expect(
      recommendedOnboardingStep(
        signals({
          welcomeAcknowledged: true,
          accountConnected: true,
          bootstrapReady: true,
        }),
      ),
    ).toBe("git");
    expect(
      recommendedOnboardingStep(
        signals({
          welcomeAcknowledged: true,
          accountConnected: true,
          bootstrapReady: true,
          gitConnected: true,
        }),
      ),
    ).toBe("repository");
    expect(
      recommendedOnboardingStep(
        signals({
          welcomeAcknowledged: true,
          accountConnected: true,
          bootstrapReady: true,
          gitConnected: true,
          repositorySelected: true,
        }),
      ),
    ).toBe("workspace");
    expect(
      recommendedOnboardingStep(
        signals({
          welcomeAcknowledged: true,
          accountConnected: true,
          bootstrapReady: true,
          gitConnected: true,
          repositorySelected: true,
          workspaceReady: true,
        }),
      ),
    ).toBe("indexing");
    expect(
      recommendedOnboardingStep(
        signals({
          welcomeAcknowledged: true,
          accountConnected: true,
          bootstrapReady: true,
          gitConnected: true,
          repositorySelected: true,
          workspaceReady: true,
          indexReady: true,
        }),
      ),
    ).toBe("ready");
  });

  it("keeps later steps blocked when a required prior capability is missing", () => {
    const views = onboardingStepViews(
      signals({
        welcomeAcknowledged: true,
        bootstrapReady: true,
        gitConnected: true,
        repositorySelected: true,
        workspaceReady: true,
        indexReady: true,
      }),
    );

    expect(views.find((view) => view.id === "account")?.state).toBe("current");
    expect(views.find((view) => view.id === "git")?.state).toBe("blocked");
    expect(views.find((view) => view.id === "ready")?.state).toBe("blocked");
  });

  it("accepts only the bounded non-secret UI checkpoint schema", () => {
    expect(
      sanitizeOnboardingProgress({
        schemaVersion: 1,
        welcomeAcknowledged: true,
        lastVisitedStep: "git",
        token: "must-not-be-consumed",
      }),
    ).toEqual({
      schemaVersion: 1,
      welcomeAcknowledged: true,
      lastVisitedStep: "git",
    });

    expect(
      sanitizeOnboardingProgress({
        schemaVersion: 99,
        welcomeAcknowledged: true,
        lastVisitedStep: "ready",
      }),
    ).toEqual(DEFAULT_ONBOARDING_PROGRESS);

    expect(
      sanitizeOnboardingProgress({
        schemaVersion: 1,
        welcomeAcknowledged: true,
        lastVisitedStep: "shell",
      }),
    ).toEqual(DEFAULT_ONBOARDING_PROGRESS);
  });
});
