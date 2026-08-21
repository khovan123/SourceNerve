import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2, FolderOpen, GitBranch, PlugZap, RefreshCw } from "lucide-react";

import type { RuntimeInfo } from "../../../shared/desktop-api";
import type { OnboardingLayer, OnboardingSignals, OnboardingStep } from "../../onboarding";
import { ActionButton } from "../atoms/ActionButton";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";
import { OnboardingStatusLine } from "./OnboardingHealthCard";

const STEP_COPY: Record<OnboardingStep, { label: string; description: string }> = {
  welcome: { label: "Welcome", description: "Start SourceNerve without terminal-driven infrastructure setup." },
  account: { label: "SourceNerve account", description: "Sign in with the SourceNerve account provided by your operator." },
  bootstrap: { label: "Secure bootstrap", description: "Prepare this installation and its managed Public MCP route." },
  git: { label: "Git provider", description: "Connect the GitHub or GitLab CLI session already on this computer." },
  repository: { label: "Repository", description: "Choose an existing local Git checkout." },
  workspace: { label: "Workspace", description: "Create a SourceNerve workspace and validate repository access." },
  indexing: { label: "Runtime & indexing", description: "Start the managed daemon and build repository intelligence." },
  ready: { label: "Ready", description: "All required setup checks are complete." },
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
    <SurfaceCard title={STEP_COPY[step].label} eyebrow="Current setup step" description={STEP_COPY[step].description}>
      <div className="space-y-4">
        {blockingLayer && step !== "welcome" ? (
          <InlineNotice tone="warning" title={`Current layer: ${LAYER_COPY[blockingLayer]}`}>
            Retry this layer without resetting completed setup.
          </InlineNotice>
        ) : null}
        {error ? <InlineNotice tone="danger" title="Setup needs attention" role="alert">{error}</InlineNotice> : null}
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
        <div className="border-l-2 border-primary/25 pl-3">
          <p className="text-xs font-semibold text-foreground">No infrastructure fields in the normal setup.</p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">No local bearer, Cloudflare credentials, environment variables, or SourceNerve TOML are required here.</p>
        </div>
        <ActionRow>
          <ActionButton onClick={onAcknowledgeWelcome}>Get started <ArrowRight className="size-4" aria-hidden="true" /></ActionButton>
          <ActionButton variant="secondary" onClick={onUseExistingSetup}><FolderOpen className="size-4" aria-hidden="true" />Use existing setup</ActionButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "account") {
    return (
      <div className="space-y-4">
        <OnboardingStatusLine label="Auth0" state={signals.accountConnected ? "complete" : "current"} />
        <ActionRow>
          <ActionButton onClick={onOpenConnections}><PlugZap className="size-4" aria-hidden="true" />Open account connection</ActionButton>
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
        {runtime?.bootstrap.error ? <InlineNotice tone="danger" title="Bootstrap runtime error" role="alert">{runtime.bootstrap.error}</InlineNotice> : null}
        <ActionRow><RetryButton onClick={onRetryCurrent}>Retry bootstrap</RetryButton></ActionRow>
      </div>
    );
  }

  if (step === "git") {
    return (
      <div className="space-y-4">
        <OnboardingStatusLine label="Git" state={signals.gitConnected ? "complete" : "current"} />
        <ActionRow>
          <ActionButton onClick={onOpenConnections}><GitBranch className="size-4" aria-hidden="true" />Open Git connection</ActionButton>
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
        <p className="text-xs leading-5 text-muted-foreground">Removing a workspace never deletes repository files.</p>
        <ActionRow>
          <ActionButton onClick={onOpenWorkspaces}><FolderOpen className="size-4" aria-hidden="true" />Open workspace setup</ActionButton>
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
        <ActionRow><RetryButton onClick={onRetryCurrent}>Retry runtime check</RetryButton></ActionRow>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="status">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <span><strong className="font-semibold text-foreground">SourceNerve is ready.</strong> Account, provider, workspace, daemon and index checks are complete.</span>
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{children}</div>;
}

function RetryButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return <ActionButton variant="secondary" onClick={onClick}><RefreshCw className="size-3.5" aria-hidden="true" />{children}</ActionButton>;
}
