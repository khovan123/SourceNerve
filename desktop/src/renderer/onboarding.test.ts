import { describe, expect, it } from "vitest";

import {
  DEFAULT_ONBOARDING_PROGRESS,
  ONBOARDING_LAYERS,
  applyRuntimeEventToSignals,
  emptyOnboardingSignals,
  onboardingLayerViews,
  onboardingStepViews,
  recommendedOnboardingStep,
  sanitizeOnboardingProgress,
  type OnboardingSignals,
} from "./onboarding";

function signals(overrides: Partial<OnboardingSignals> = {}): OnboardingSignals {
  return {
    ...emptyOnboardingSignals(),
    ...overrides,
  };
}

function fullyBootstrapped(overrides: Partial<OnboardingSignals> = {}): OnboardingSignals {
  return signals({
    welcomeAcknowledged: true,
    productProfileReady: true,
    localBearerReady: true,
    accountConnected: true,
    enrollmentReady: true,
    cloudflareReady: true,
    ...overrides,
  });
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
    expect(recommendedOnboardingStep(fullyBootstrapped())).toBe("git");
    expect(recommendedOnboardingStep(fullyBootstrapped({ gitConnected: true }))).toBe(
      "repository",
    );
    expect(
      recommendedOnboardingStep(
        fullyBootstrapped({ gitConnected: true, repositorySelected: true }),
      ),
    ).toBe("workspace");
    expect(
      recommendedOnboardingStep(
        fullyBootstrapped({
          gitConnected: true,
          repositorySelected: true,
          workspaceReady: true,
        }),
      ),
    ).toBe("indexing");
    expect(
      recommendedOnboardingStep(
        fullyBootstrapped({
          gitConnected: true,
          repositorySelected: true,
          workspaceReady: true,
          daemonReady: true,
          indexReady: true,
        }),
      ),
    ).toBe("ready");
  });

  it("does not skip authenticated enrollment or Cloudflare provisioning", () => {
    const base = signals({
      welcomeAcknowledged: true,
      productProfileReady: true,
      localBearerReady: true,
      accountConnected: true,
    });

    expect(recommendedOnboardingStep(base)).toBe("bootstrap");
    expect(recommendedOnboardingStep({ ...base, enrollmentReady: true })).toBe("bootstrap");
    expect(
      recommendedOnboardingStep({
        ...base,
        enrollmentReady: true,
        cloudflareReady: true,
      }),
    ).toBe("git");
  });

  it("keeps later steps blocked when a required prior capability is missing", () => {
    const views = onboardingStepViews(
      signals({
        welcomeAcknowledged: true,
        productProfileReady: true,
        localBearerReady: true,
        enrollmentReady: true,
        cloudflareReady: true,
        gitConnected: true,
        repositorySelected: true,
        workspaceReady: true,
        daemonReady: true,
        indexReady: true,
      }),
    );

    expect(views.find((view) => view.id === "account")?.state).toBe("current");
    expect(views.find((view) => view.id === "git")?.state).toBe("blocked");
    expect(views.find((view) => view.id === "ready")?.state).toBe("blocked");
  });

  it("names every required setup/runtime layer and points to the first incomplete layer", () => {
    expect(ONBOARDING_LAYERS).toEqual([
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
    ]);

    const views = onboardingLayerViews(
      signals({ productProfileReady: true, localBearerReady: true }),
    );
    expect(views.find((view) => view.id === "product-profile")?.state).toBe("complete");
    expect(views.find((view) => view.id === "local-bearer")?.state).toBe("complete");
    expect(views.find((view) => view.id === "auth0")?.state).toBe("current");
    expect(views.find((view) => view.id === "enrollment")?.state).toBe("blocked");
  });

  it("consumes only semantic runtime events without transporting secrets", () => {
    let current = signals();
    current = applyRuntimeEventToSignals(current, {
      type: "state",
      component: "auth",
      state: "authenticated",
    });
    current = applyRuntimeEventToSignals(current, {
      type: "state",
      component: "public-mcp",
      state: "ready",
    });
    current = applyRuntimeEventToSignals(current, {
      type: "state",
      component: "git",
      state: "connected",
    });
    current = applyRuntimeEventToSignals(current, {
      type: "state",
      component: "workspace",
      state: "workspace-ready",
    });
    current = applyRuntimeEventToSignals(current, {
      type: "state",
      component: "daemon",
      state: "ready",
    });
    current = applyRuntimeEventToSignals(current, {
      type: "progress",
      operationId: "workspace-index",
      stage: "index-complete",
    });

    expect(current).toMatchObject({
      accountConnected: true,
      enrollmentReady: true,
      cloudflareReady: true,
      gitConnected: true,
      repositorySelected: true,
      workspaceReady: true,
      daemonReady: true,
      indexReady: true,
    });
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
