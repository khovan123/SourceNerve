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
  return { ...emptyOnboardingSignals(), ...overrides };
}

describe("Desktop onboarding state", () => {
  it("follows SourceNerve -> Codex/ChatGPT -> workspace -> Harness chat", () => {
    expect(recommendedOnboardingStep(signals())).toBe("welcome");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true }))).toBe("codex");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true, codexInstalled: true }))).toBe("codex");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true, codexInstalled: true, codexAuthenticated: true }))).toBe("workspace");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true, codexInstalled: true, codexAuthenticated: true, workspaceReady: true }))).toBe("workspace");
    expect(recommendedOnboardingStep(signals({ welcomeAcknowledged: true, productProfileReady: true, localBearerReady: true, codexInstalled: true, codexAuthenticated: true, workspaceReady: true, daemonReady: true }))).toBe("ready");
  });

  it("does not gate local Harness chat on optional Auth0, Public MCP, or Git-provider connections", () => {
    const current = signals({
      welcomeAcknowledged: true,
      productProfileReady: true,
      localBearerReady: true,
      daemonReady: true,
      codexInstalled: true,
      codexAuthenticated: true,
      workspaceReady: true,
      accountConnected: false,
      enrollmentReady: false,
      cloudflareReady: false,
      gitConnected: false,
    });
    expect(recommendedOnboardingStep(current)).toBe("ready");
  });

  it("keeps workspace and ready blocked until ChatGPT Codex setup is complete", () => {
    const views = onboardingStepViews(signals({ welcomeAcknowledged: true, codexInstalled: true }));
    expect(views.find((view) => view.id === "codex")?.state).toBe("current");
    expect(views.find((view) => view.id === "workspace")?.state).toBe("blocked");
    expect(views.find((view) => view.id === "ready")?.state).toBe("blocked");
  });

  it("tracks only the local layers required by the first-run chat flow", () => {
    expect(ONBOARDING_LAYERS).toEqual([
      "product-profile",
      "local-bearer",
      "codex",
      "workspace",
      "daemon",
    ]);
    const views = onboardingLayerViews(signals({
      productProfileReady: true,
      localBearerReady: true,
      codexInstalled: true,
      codexAuthenticated: true,
    }));
    expect(views.find((view) => view.id === "product-profile")?.state).toBe("complete");
    expect(views.find((view) => view.id === "codex")?.state).toBe("complete");
    expect(views.find((view) => view.id === "workspace")?.state).toBe("current");
    expect(views.find((view) => view.id === "daemon")?.state).toBe("blocked");
  });

  it("still consumes optional integration runtime events without making them onboarding prerequisites", () => {
    let current = signals();
    current = applyRuntimeEventToSignals(current, { type: "state", component: "auth", state: "authenticated" });
    current = applyRuntimeEventToSignals(current, { type: "state", component: "public-mcp", state: "ready" });
    current = applyRuntimeEventToSignals(current, { type: "state", component: "git", state: "connected" });
    current = applyRuntimeEventToSignals(current, { type: "state", component: "workspace", state: "workspace-ready" });
    current = applyRuntimeEventToSignals(current, { type: "state", component: "daemon", state: "ready" });
    expect(current).toMatchObject({
      accountConnected: true,
      enrollmentReady: true,
      cloudflareReady: true,
      gitConnected: true,
      repositorySelected: true,
      workspaceReady: true,
      daemonReady: true,
    });
  });

  it("ignores progress events for runtime readiness", () => {
    const current = applyRuntimeEventToSignals(signals({ daemonReady: false }), {
      type: "progress",
      operationId: "task-analysis",
      stage: "complete",
    });
    expect(current.daemonReady).toBe(false);
  });

  it("clears dependent optional cloud readiness after auth loss", () => {
    const bootstrapped = signals({
      accountConnected: true,
      enrollmentReady: true,
      cloudflareReady: true,
    });
    const signedOut = applyRuntimeEventToSignals(bootstrapped, {
      type: "state",
      component: "auth",
      state: "signed-out",
    });
    expect(signedOut).toMatchObject({ accountConnected: false, enrollmentReady: false, cloudflareReady: false });
  });

  it("migrates legacy UI checkpoints into the simplified setup flow", () => {
    expect(sanitizeOnboardingProgress({
      schemaVersion: 1,
      welcomeAcknowledged: true,
      lastVisitedStep: "git",
    })).toEqual({ schemaVersion: 1, welcomeAcknowledged: true, lastVisitedStep: "codex" });
    expect(sanitizeOnboardingProgress({
      schemaVersion: 1,
      welcomeAcknowledged: true,
      lastVisitedStep: "repository",
    })).toEqual({ schemaVersion: 1, welcomeAcknowledged: true, lastVisitedStep: "workspace" });
    expect(sanitizeOnboardingProgress({
      schemaVersion: 99,
      welcomeAcknowledged: true,
      lastVisitedStep: "ready",
    })).toEqual(DEFAULT_ONBOARDING_PROGRESS);
    expect(sanitizeOnboardingProgress({
      schemaVersion: 1,
      welcomeAcknowledged: true,
      lastVisitedStep: "shell",
    })).toEqual(DEFAULT_ONBOARDING_PROGRESS);
  });
});
