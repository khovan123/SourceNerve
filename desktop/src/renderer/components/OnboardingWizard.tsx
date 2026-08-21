import { ShieldCheck } from "lucide-react";

import type { RuntimeInfo } from "../../shared/desktop-api";
import {
  ONBOARDING_STEPS,
  onboardingLayerViews,
  onboardingStepViews,
  recommendedOnboardingStep,
  type OnboardingSignals,
} from "../onboarding";
import { StatusPill } from "./atoms/StatusPill";
import { OnboardingCurrentStepCard } from "./organisms/OnboardingCurrentStepCard";
import { OnboardingHealthCard } from "./organisms/OnboardingHealthCard";
import { OnboardingProgressRail } from "./organisms/OnboardingProgressRail";

export function OnboardingWizard({
  runtime,
  signals,
  error,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenConnections,
  onOpenWorkspaces,
  onRetryCurrent,
}: {
  runtime: RuntimeInfo | null;
  signals: OnboardingSignals;
  error: string | null;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenConnections(): void;
  onOpenWorkspaces(): void;
  onRetryCurrent(): void;
}) {
  const current = recommendedOnboardingStep(signals);
  const views = onboardingStepViews(signals);
  const layers = onboardingLayerViews(signals);
  const blockingLayer = layers.find((layer) => layer.state === "current")?.id;

  return (
    <section className="space-y-5" aria-labelledby="onboarding-title">
      <header className="rounded-2xl border border-border bg-card/75 p-5 shadow-[0_18px_45px_rgba(40,34,26,0.05)] backdrop-blur-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              First-run setup
            </div>
            <h1 id="onboarding-title" className="text-2xl font-semibold tracking-[-0.025em] text-foreground sm:text-3xl">Set up SourceNerve</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Normal setup is Auth0 → automatic enrollment → Git provider → repository → workspace → Ready. Product secrets and infrastructure credentials stay outside the renderer.
            </p>
          </div>
          <StatusPill tone={current === "ready" ? "ready" : "working"} dot className="shrink-0">
            {current === "ready" ? "Ready" : `Step ${ONBOARDING_STEPS.indexOf(current) + 1} of ${ONBOARDING_STEPS.length}`}
          </StatusPill>
        </div>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <OnboardingProgressRail views={views} />
        <div className="min-w-0 space-y-4">
          <OnboardingCurrentStepCard
            step={current}
            runtime={runtime}
            signals={signals}
            blockingLayer={blockingLayer}
            error={error}
            onAcknowledgeWelcome={onAcknowledgeWelcome}
            onUseExistingSetup={onUseExistingSetup}
            onOpenConnections={onOpenConnections}
            onOpenWorkspaces={onOpenWorkspaces}
            onRetryCurrent={onRetryCurrent}
          />
          <OnboardingHealthCard layers={layers} />
        </div>
      </div>
    </section>
  );
}
