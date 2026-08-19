import type { RuntimeInfo } from "../../shared/desktop-api";
import {
  ONBOARDING_STEPS,
  onboardingStepViews,
  recommendedOnboardingStep,
  type OnboardingSignals,
  type OnboardingStep,
} from "../onboarding";
import { Panel } from "./Panel";
import { StatusBadge, type StatusTone } from "./StatusBadge";

const STEP_COPY: Record<OnboardingStep, { label: string; description: string }> = {
  welcome: {
    label: "Welcome",
    description: "Start SourceNerve without terminal-driven infrastructure setup.",
  },
  account: {
    label: "SourceNerve account",
    description: "Sign in with the SourceNerve account provided by your operator.",
  },
  bootstrap: {
    label: "Secure bootstrap",
    description: "Prepare the local installation identity, secure storage, and product profile.",
  },
  git: {
    label: "Git provider",
    description: "Connect GitHub or GitLab without exposing provider credentials to the renderer.",
  },
  repository: {
    label: "Repository",
    description: "Choose a provider repository or an existing local Git checkout.",
  },
  workspace: {
    label: "Workspace",
    description: "Create a SourceNerve workspace and validate repository access.",
  },
  indexing: {
    label: "Indexing",
    description: "Start the managed daemon and build repository intelligence.",
  },
  ready: {
    label: "Ready",
    description: "Open the workspace when every required runtime layer is healthy.",
  },
};

export function OnboardingWizard({
  runtime,
  signals,
  onAcknowledgeWelcome,
  onUseExistingSetup,
  onOpenConnections,
  onOpenWorkspaces,
}: {
  runtime: RuntimeInfo | null;
  signals: OnboardingSignals;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenConnections(): void;
  onOpenWorkspaces(): void;
}) {
  const current = recommendedOnboardingStep(signals);
  const views = onboardingStepViews(signals);

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding__header">
        <div>
          <p className="eyebrow">First-run setup</p>
          <h1 id="onboarding-title">Set up SourceNerve</h1>
          <p>
            Normal setup is account → Git provider → repository → workspace. Product
            profile, local bearer, and infrastructure credentials stay outside the renderer.
          </p>
        </div>
        <StatusBadge
          label={current === "ready" ? "Ready" : `Step ${ONBOARDING_STEPS.indexOf(current) + 1} of ${ONBOARDING_STEPS.length}`}
          tone={current === "ready" ? "ready" : "working"}
        />
      </div>

      <div className="onboarding__layout">
        <ol className="onboarding-steps" aria-label="Setup progress">
          {views.map((view, index) => (
            <li
              key={view.id}
              className={`onboarding-step onboarding-step--${view.state}`}
              aria-current={view.state === "current" ? "step" : undefined}
            >
              <span className="onboarding-step__number" aria-hidden="true">
                {view.state === "complete" ? "✓" : index + 1}
              </span>
              <span>
                <strong>{STEP_COPY[view.id].label}</strong>
                <small>{stepStateLabel(view.state)}</small>
              </span>
            </li>
          ))}
        </ol>

        <Panel title={STEP_COPY[current].label} eyebrow="Setup">
          <p className="onboarding__lead">{STEP_COPY[current].description}</p>
          <CurrentStep
            step={current}
            runtime={runtime}
            signals={signals}
            onAcknowledgeWelcome={onAcknowledgeWelcome}
            onUseExistingSetup={onUseExistingSetup}
            onOpenConnections={onOpenConnections}
            onOpenWorkspaces={onOpenWorkspaces}
          />
        </Panel>
      </div>
    </section>
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
}: {
  step: OnboardingStep;
  runtime: RuntimeInfo | null;
  signals: OnboardingSignals;
  onAcknowledgeWelcome(): void;
  onUseExistingSetup(): void;
  onOpenConnections(): void;
  onOpenWorkspaces(): void;
}) {
  if (step === "welcome") {
    return (
      <>
        <div className="setup-callout">
          <strong>No infrastructure fields in the normal setup.</strong>
          <p>
            You will not be asked for local bearer values, Cloudflare credentials,
            environment variables, or a SourceNerve TOML file.
          </p>
        </div>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onAcknowledgeWelcome}>
            Get started
          </button>
          <button className="button button--quiet" type="button" onClick={onUseExistingSetup}>
            Use existing setup
          </button>
        </div>
      </>
    );
  }

  if (step === "account") {
    return (
      <>
        <StatusLine label="SourceNerve account" ready={signals.accountConnected} />
        <p className="muted">
          Native Auth0 sign-in is intentionally a dedicated trusted-main integration. This
          onboarding surface never accepts or displays access or refresh token strings.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenConnections}>
            Open account connection
          </button>
        </div>
      </>
    );
  }

  if (step === "bootstrap") {
    return (
      <div className="setup-checklist">
        <StatusLine label="Product profile" ready={Boolean(runtime?.bootstrap.ready)} />
        <StatusLine label="Installation identity" ready={Boolean(runtime?.bootstrap.ready)} />
        <StatusLine label="Local bearer prepared" ready={Boolean(runtime?.bootstrap.ready)} />
        <StatusLine
          label={runtime?.bootstrap.secureStorageBackend ? `Secure storage · ${runtime.bootstrap.secureStorageBackend}` : "Secure storage"}
          ready={Boolean(runtime?.bootstrap.ready)}
        />
        {runtime?.bootstrap.error ? <p className="muted" role="alert">{runtime.bootstrap.error}</p> : null}
      </div>
    );
  }

  if (step === "git") {
    return (
      <>
        <StatusLine label="Git provider" ready={signals.gitConnected} />
        <p className="muted">
          Provider sessions remain independent from the SourceNerve account and are stored
          behind the desktop secure-storage boundary.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenConnections}>
            Open Git connection
          </button>
        </div>
      </>
    );
  }

  if (step === "repository" || step === "workspace") {
    return (
      <>
        <StatusLine
          label={step === "repository" ? "Repository selected" : "Workspace validated"}
          ready={step === "repository" ? signals.repositorySelected : signals.workspaceReady}
        />
        <p className="muted">
          Repository paths and workspace configuration stay local. Removing a workspace must
          never delete repository files.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenWorkspaces}>
            Open workspace setup
          </button>
        </div>
      </>
    );
  }

  if (step === "indexing") {
    return (
      <>
        <StatusLine label="Repository index" ready={signals.indexReady} />
        <p className="muted">
          Index progress comes from the SourceNerve runtime. Closing or reopening the desktop
          must not manufacture a successful index state.
        </p>
      </>
    );
  }

  return (
    <div className="setup-callout">
      <strong>SourceNerve is ready.</strong>
      <p>Account, bootstrap, Git, repository, workspace, and index checks are complete.</p>
    </div>
  );
}

function StatusLine({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="setup-status-line">
      <StatusBadge label={ready ? "Ready" : "Needs attention"} tone={ready ? "ready" : "warning"} />
      <span>{label}</span>
    </div>
  );
}

function stepStateLabel(state: "complete" | "current" | "blocked" | "pending"): string {
  if (state === "complete") return "Complete";
  if (state === "current") return "Current";
  if (state === "pending") return "Pending";
  return "Blocked by prior step";
}
