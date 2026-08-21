import type { ReactNode } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";

import type { RuntimeInfo } from "../../../shared/desktop-api";
import type { OnboardingLayer, OnboardingSignals, OnboardingStep } from "../../onboarding";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";
import { OnboardingStatusLine } from "./OnboardingHealthCard";

const STEP_COPY: Record<OnboardingStep, { label: string; description: string }> = {
  welcome: { label: "Welcome", description: "Start SourceNerve without terminal-driven infrastructure setup." },
  account: { label: "SourceNerve account", description: "Sign in with the SourceNerve account provided by your operator." },
  bootstrap: { label: "Secure bootstrap", description: "Enroll this installation and prepare its managed public MCP route automatically." },
  git: { label: "Git provider", description: "Connect GitHub or GitLab without exposing provider credentials to the renderer." },
  repository: { label: "Repository", description: "Choose a provider repository or an existing local Git checkout." },
  workspace: { label: "Workspace", description: "Create a SourceNerve workspace and validate repository access." },
  indexing: { label: "Runtime & indexing", description: "Start the managed daemon and build repository intelligence." },
  ready: { label: "Ready", description: "Open the workspace when every required runtime layer is healthy." },
};

const LAYER_COPY: Record<OnboardingLayer, string> = {
  "product-profile": "Product Profile",
  "local-bearer": "Local Bearer",
  auth0: "Auth0",
  enrollment: "Enrollment",
  cloudflare: "Cloudflare",
  git: "Git",
  repository: "Repository",
  workspace: "Workspace",
  daemon: "Daemon",
  index: "Index",
};

export function OnboardingCurrentStepCard({
  step,
  runtime,
  signals,
  blockingLayer,
  error,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenConnections,
  onOpenWorkspaces,
  onRetryCurrent,
}: {
  step: OnboardingStep;
  runtime: RuntimeInfo | null;
  signals: OnboardingSignals;
  blockingLayer?: OnboardingLayer;
  error: string | null;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenConnections(): void;
  onOpenWorkspaces(): void;
  onRetryCurrent(): void;
}) {
  return (
    <SurfaceCard title={STEP_COPY[step].label} eyebrow="Current setup step">
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">{STEP_COPY[step].description}</p>
        {blockingLayer && step !== "welcome" ? (
          <div className="rounded-xl border border-warning/20 bg-warning/8 px-3 py-3">
            <p className="text-xs font-semibold text-warning">Current layer: {LAYER_COPY[blockingLayer]}</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Retry and recovery target this layer without resetting completed setup.</p>
          </div>
        ) : null}
        {error ? <div className="rounded-xl border border-danger/20 bg-danger/8 px-3 py-2 text-xs leading-5 text-danger" role="alert">{error}</div> : null}
        <CurrentStep
          step={step}
          runtime={runtime}
          signals={signals}
          onAcknowledgeWelcome={onAcknowledgeWelcome}
          onUseExistingSetup={onUseExistingSetup}
          onOpenConnections={onOpenConnections}
          onOpenWorkspaces={onOpenWorkspaces}
          onRetryCurrent={onRetryCurrent}
        />
      </div>
    </SurfaceCard>
  );
}

function CurrentStep({
  step,
  runtime,
  signals,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenConnections,
  onOpenWorkspaces,
  onRetryCurrent,
}: {
  step: OnboardingStep;
  runtime: RuntimeInfo | null;
  signals: OnboardingSignals;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenConnections(): void;
  onOpenWorkspaces(): void;
  onRetryCurrent(): void;
}) {
  if (step === "welcome") {
    return (
      <div className="space-y-4">
        <InfoCallout title="No infrastructure fields in the normal setup.">
          You will not be asked for local bearer values, Cloudflare credentials, environment variables, or a SourceNerve TOML file.
        </InfoCallout>
        <ActionRow>
          <ActionButton onClick={onAcknowledgeWelcome}>Get started <ArrowRight className="size-4" aria-hidden="true" /></ActionButton>
          <ActionButton variant="secondary" onClick={onUseExistingSetup}>Use existing setup</ActionButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "account") {
    return (
      <div className="space-y-4">
        <OnboardingStatusLine label="Auth0" state={signals.accountConnected ? "complete" : "current"} />
        <p className="text-xs leading-5 text-muted-foreground">Native Auth0 sign-in is owned by trusted Electron Main. This surface never accepts or displays access or refresh token strings.</p>
        <ActionRow>
          <ActionButton onClick={onOpenConnections}>Open account connection</ActionButton>
          <RetryButton onClick={onRetryCurrent}>Retry account status</RetryButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "bootstrap") {
    return (
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <OnboardingStatusLine label="Product Profile" state={signals.productProfileReady ? "complete" : "current"} />
          <OnboardingStatusLine label="Local Bearer" state={signals.localBearerReady ? "complete" : "current"} />
          <OnboardingStatusLine label="Enrollment" state={signals.enrollmentReady ? "complete" : "current"} />
          <OnboardingStatusLine label="Cloudflare" state={signals.cloudflareReady ? "complete" : "current"} />
        </div>
        {runtime?.bootstrap.secureStorageBackend ? <p className="text-xs text-muted-foreground">Secure storage: <span className="font-medium text-foreground">{runtime.bootstrap.secureStorageBackend}</span></p> : null}
        {runtime?.bootstrap.error ? <div className="rounded-xl border border-danger/20 bg-danger/8 px-3 py-2 text-xs text-danger" role="alert">{runtime.bootstrap.error}</div> : null}
        <ActionRow><RetryButton onClick={onRetryCurrent}>Retry bootstrap layer</RetryButton></ActionRow>
      </div>
    );
  }

  if (step === "git") {
    return (
      <div className="space-y-4">
        <OnboardingStatusLine label="Git" state={signals.gitConnected ? "complete" : "current"} />
        <p className="text-xs leading-5 text-muted-foreground">GitHub/GitLab sessions remain independent from the SourceNerve account and stay behind the secure-storage boundary.</p>
        <ActionRow>
          <ActionButton onClick={onOpenConnections}>Open Git connection</ActionButton>
          <RetryButton onClick={onRetryCurrent}>Retry Git status</RetryButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "repository" || step === "workspace") {
    const ready = step === "repository" ? signals.repositorySelected : signals.workspaceReady;
    return (
      <div className="space-y-4">
        <OnboardingStatusLine label={step === "repository" ? "Repository" : "Workspace"} state={ready ? "complete" : "current"} />
        <p className="text-xs leading-5 text-muted-foreground">Repository paths and workspace configuration stay local. Removing a workspace never deletes repository files.</p>
        <ActionRow>
          <ActionButton onClick={onOpenWorkspaces}>Open workspace setup</ActionButton>
          <RetryButton onClick={onRetryCurrent}>Retry workspace status</RetryButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "indexing") {
    return (
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <OnboardingStatusLine label="Daemon" state={signals.daemonReady ? "complete" : "current"} />
          <OnboardingStatusLine label="Index" state={signals.indexReady ? "complete" : "current"} />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">Daemon and index state come from trusted runtime checks. Restarting the renderer cannot manufacture a successful state.</p>
        <ActionRow><RetryButton onClick={onRetryCurrent}>Retry runtime check</RetryButton></ActionRow>
      </div>
    );
  }

  return <InfoCallout title="SourceNerve is ready.">All account, bootstrap, provider, workspace, daemon, and index checks are complete.</InfoCallout>;
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

function RetryButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <ActionButton variant="secondary" onClick={onClick}><RefreshCw className="size-3.5" aria-hidden="true" />{children}</ActionButton>;
}

function InfoCallout({ title, children }: { title: string; children: ReactNode }) {
  return <div className="rounded-xl border border-border bg-muted/25 px-3 py-3"><p className="text-xs font-semibold text-foreground">{title}</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{children}</p></div>;
}
