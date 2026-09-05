import { useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, FolderOpen, RefreshCw } from "lucide-react";

import type { DesktopHarnessCodexSetupView } from "../../../shared/harness-api";
import type { OnboardingSignals, OnboardingStep } from "../../onboarding";
import { ActionButton } from "../atoms/ActionButton";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";
import { OnboardingStatusLine } from "./OnboardingHealthCard";

const STEP_COPY: Record<OnboardingStep, { label: string; description: string }> = {
  welcome: { label: "Welcome", description: "Install SourceNerve, connect Codex to ChatGPT, add a workspace, then chat from Harness." },
  codex: { label: "Codex + ChatGPT", description: "Install the official Codex CLI and sign in with the ChatGPT account you want SourceNerve to use." },
  workspace: { label: "Workspace", description: "Add a local read-write repository. SourceNerve keeps the workspace boundary authoritative." },
  ready: { label: "Open Harness", description: "Your local chat path is ready. Open Harness and send a prompt directly to native Codex." },
};

export function OnboardingCurrentStepCard({
  step,
  signals,
  codexSetup,
  error,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenWorkspaces,
  onOpenHarness,
  onInstallCodex,
  onLoginCodex,
  onRetryCurrent,
}: {
  step: OnboardingStep;
  signals: OnboardingSignals;
  codexSetup: DesktopHarnessCodexSetupView | null;
  error: string | null;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenWorkspaces(): void;
  onOpenHarness(): void;
  onInstallCodex(): Promise<void>;
  onLoginCodex(): Promise<void>;
  onRetryCurrent(): Promise<void>;
}) {
  const [busy, setBusy] = useState<"retry" | "install" | "login" | null>(null);

  async function run(kind: "retry" | "install" | "login", action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(kind);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  return (
    <SurfaceCard title={STEP_COPY[step].label} eyebrow="Current setup step" description={STEP_COPY[step].description}>
      <div className="space-y-4">
        {error ? <InlineNotice tone="danger" title="Setup needs attention" role="alert">{error}</InlineNotice> : null}
        <CurrentStep
          step={step}
          signals={signals}
          codexSetup={codexSetup}
          busy={busy}
          onAcknowledgeWelcome={onAcknowledgeWelcome}
          onUseExistingSetup={onUseExistingSetup}
          onOpenWorkspaces={onOpenWorkspaces}
          onOpenHarness={onOpenHarness}
          onInstallCodex={() => void run("install", onInstallCodex)}
          onLoginCodex={() => void run("login", onLoginCodex)}
          onRetryCurrent={() => void run("retry", onRetryCurrent)}
        />
      </div>
    </SurfaceCard>
  );
}

function CurrentStep({
  step,
  signals,
  codexSetup,
  busy,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenWorkspaces,
  onOpenHarness,
  onInstallCodex,
  onLoginCodex,
  onRetryCurrent,
}: {
  step: OnboardingStep;
  signals: OnboardingSignals;
  codexSetup: DesktopHarnessCodexSetupView | null;
  busy: "retry" | "install" | "login" | null;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenWorkspaces(): void;
  onOpenHarness(): void;
  onInstallCodex(): void;
  onLoginCodex(): void;
  onRetryCurrent(): void;
}) {
  if (step === "welcome") {
    return (
      <div className="space-y-4">
        <div className="border-l-2 border-primary/25 pl-3">
          <p className="text-xs font-semibold text-foreground">Normal local flow</p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">SourceNerve → Codex CLI → ChatGPT login → workspace → Harness chat. Auth0, Public MCP, and Git-provider connections are optional integrations, not prerequisites for local chat.</p>
        </div>
        <ActionRow>
          <ActionButton onClick={onAcknowledgeWelcome}>Get started <ArrowRight className="size-4" aria-hidden="true" /></ActionButton>
          <ActionButton variant="secondary" onClick={onUseExistingSetup}><FolderOpen className="size-4" aria-hidden="true" />Check existing setup</ActionButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "codex") {
    const installed = signals.codexInstalled;
    const authenticated = signals.codexAuthenticated;
    return (
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <OnboardingStatusLine label={codexSetup?.version ? `Codex ${codexSetup.version}` : "Codex CLI"} state={installed ? "complete" : "current"} />
          <OnboardingStatusLine label="ChatGPT login" state={authenticated ? "complete" : installed ? "current" : "blocked"} />
        </div>
        {codexSetup?.accountType === "apiKey" ? (
          <InlineNotice tone="warning" title="API-key login detected">SourceNerve native chat requires the ChatGPT login lane for this setup. Sign in with ChatGPT instead.</InlineNotice>
        ) : null}
        {!installed && codexSetup?.canInstall === false ? (
          <InlineNotice tone="warning" title="npm not found"><code>npm install -g @openai/codex</code>, then return here and retry the Codex check.</InlineNotice>
        ) : null}
        <ActionRow>
          {!installed ? <ActionButton onClick={onInstallCodex} disabled={busy !== null || codexSetup?.canInstall === false}>{busy === "install" ? "Installing Codex…" : "Install Codex"}</ActionButton> : null}
          {installed && !authenticated ? <ActionButton onClick={onLoginCodex} disabled={busy !== null}>{busy === "login" ? "Waiting for ChatGPT login…" : "Sign in with ChatGPT"}</ActionButton> : null}
          <RetryButton busy={busy === "retry"} busyLabel="Checking Codex…" onClick={onRetryCurrent}>Check Codex</RetryButton>
        </ActionRow>
      </div>
    );
  }

  if (step === "workspace") {
    return (
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <OnboardingStatusLine label="Read-write workspace" state={signals.workspaceReady ? "complete" : "current"} />
          <OnboardingStatusLine label="SourceNerve runtime" state={signals.productProfileReady && signals.localBearerReady && signals.daemonReady ? "complete" : "current"} />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">Choose a local Git checkout. SourceNerve will verify its local runtime before opening Harness. Removing the workspace never deletes repository files.</p>
        <ActionRow>
          <ActionButton onClick={onOpenWorkspaces}><FolderOpen className="size-4" aria-hidden="true" />Add workspace</ActionButton>
          <RetryButton busy={busy === "retry"} busyLabel="Checking workspace…" onClick={onRetryCurrent}>Check workspace</RetryButton>
        </ActionRow>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="status">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <span><strong className="font-semibold text-foreground">Ready to chat.</strong> Codex is signed in with ChatGPT and at least one read-write workspace is ready.</span>
      </div>
      <ActionButton onClick={onOpenHarness}>Open Harness &amp; chat <ArrowRight className="size-4" aria-hidden="true" /></ActionButton>
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">{children}</div>;
}

function RetryButton({ children, onClick, busy, busyLabel }: { children: ReactNode; onClick(): void; busy: boolean; busyLabel: string }) {
  return (
    <ActionButton variant="secondary" disabled={busy} aria-busy={busy} onClick={onClick}>
      <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
      {busy ? busyLabel : children}
    </ActionButton>
  );
}
