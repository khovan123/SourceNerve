import type { RuntimeInfo } from "../../shared/desktop-api";
import {
  ONBOARDING_STEPS,
  onboardingLayerViews,
  onboardingStepViews,
  recommendedOnboardingStep,
  type OnboardingLayer,
  type OnboardingSignals,
  type OnboardingStep,
} from "../onboarding";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

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
    description: "Enroll this installation and prepare its managed public MCP route automatically.",
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
    label: "Runtime & indexing",
    description: "Start the managed daemon and build repository intelligence.",
  },
  ready: {
    label: "Ready",
    description: "Open the workspace when every required runtime layer is healthy.",
  },
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
  const blockingLayer = layers.find((layer) => layer.state === "current");

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding__header">
        <div>
          <p className="eyebrow">First-run setup</p>
          <h1 id="onboarding-title">Set up SourceNerve</h1>
          <p>
            Normal setup is Auth0 → automatic enrollment → Git provider → repository →
            workspace → Ready. Product secrets and infrastructure credentials stay outside the
            renderer.
          </p>
        </div>
        <StatusBadge
          label={
            current === "ready"
              ? "Ready"
              : `Step ${ONBOARDING_STEPS.indexOf(current) + 1} of ${ONBOARDING_STEPS.length}`
          }
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

        <div className="onboarding__content">
          <Panel title={STEP_COPY[current].label} eyebrow="Setup">
            <p className="onboarding__lead">{STEP_COPY[current].description}</p>
            {blockingLayer && current !== "welcome" ? (
              <div className="setup-callout">
                <strong>Current layer: {LAYER_COPY[blockingLayer.id]}</strong>
                <p>Retry and recovery target this layer without resetting completed setup.</p>
              </div>
            ) : null}
            {error ? <p className="muted" role="alert">{error}</p> : null}
            <CurrentStep
              step={current}
              runtime={runtime}
              signals={signals}
              onAcknowledgeWelcome={onAcknowledgeWelcome}
              onUseExistingSetup={onUseExistingSetup}
              onOpenConnections={onOpenConnections}
              onOpenWorkspaces={onOpenWorkspaces}
              onRetryCurrent={onRetryCurrent}
            />
          </Panel>

          <Panel title="Setup health" eyebrow="Layers">
            <div className="setup-checklist">
              {layers.map((layer) => (
                <StatusLine key={layer.id} label={LAYER_COPY[layer.id]} state={layer.state} />
              ))}
            </div>
          </Panel>
        </div>
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
      <>
        <div className="setup-callout">
          <strong>No infrastructure fields in the normal setup.</strong>
          <p>
            You will not be asked for local bearer values, Cloudflare credentials, environment
            variables, or a SourceNerve TOML file.
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
        <StatusLine label="Auth0" state={signals.accountConnected ? "complete" : "current"} />
        <p className="muted">
          Native Auth0 sign-in is owned by trusted Electron Main. This surface never accepts or
          displays access or refresh token strings.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenConnections}>
            Open account connection
          </button>
          <button className="button button--quiet" type="button" onClick={onRetryCurrent}>
            Retry account status
          </button>
        </div>
      </>
    );
  }

  if (step === "bootstrap") {
    return (
      <>
        <div className="setup-checklist">
          <StatusLine
            label="Product Profile"
            state={signals.productProfileReady ? "complete" : "current"}
          />
          <StatusLine
            label="Local Bearer"
            state={signals.localBearerReady ? "complete" : "current"}
          />
          <StatusLine
            label="Enrollment"
            state={signals.enrollmentReady ? "complete" : "current"}
          />
          <StatusLine
            label="Cloudflare"
            state={signals.cloudflareReady ? "complete" : "current"}
          />
        </div>
        {runtime?.bootstrap.secureStorageBackend ? (
          <p className="muted">Secure storage: {runtime.bootstrap.secureStorageBackend}</p>
        ) : null}
        {runtime?.bootstrap.error ? <p className="muted" role="alert">{runtime.bootstrap.error}</p> : null}
        <div className="onboarding-actions">
          <button className="button button--quiet" type="button" onClick={onRetryCurrent}>
            Retry bootstrap layer
          </button>
        </div>
      </>
    );
  }

  if (step === "git") {
    return (
      <>
        <StatusLine label="Git" state={signals.gitConnected ? "complete" : "current"} />
        <p className="muted">
          GitHub/GitLab sessions remain independent from the SourceNerve account and stay behind
          the secure-storage boundary.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenConnections}>
            Open Git connection
          </button>
          <button className="button button--quiet" type="button" onClick={onRetryCurrent}>
            Retry Git status
          </button>
        </div>
      </>
    );
  }

  if (step === "repository" || step === "workspace") {
    const ready = step === "repository" ? signals.repositorySelected : signals.workspaceReady;
    return (
      <>
        <StatusLine
          label={step === "repository" ? "Repository" : "Workspace"}
          state={ready ? "complete" : "current"}
        />
        <p className="muted">
          Repository paths and workspace configuration stay local. Removing a workspace never
          deletes repository files.
        </p>
        <div className="onboarding-actions">
          <button className="button" type="button" onClick={onOpenWorkspaces}>
            Open workspace setup
          </button>
          <button className="button button--quiet" type="button" onClick={onRetryCurrent}>
            Retry workspace status
          </button>
        </div>
      </>
    );
  }

  if (step === "indexing") {
    return (
      <>
        <div className="setup-checklist">
          <StatusLine label="Daemon" state={signals.daemonReady ? "complete" : "current"} />
          <StatusLine label="Index" state={signals.indexReady ? "complete" : "current"} />
        </div>
        <p className="muted">
          Daemon and index state come from trusted runtime checks. Restarting the renderer cannot
          manufacture a successful state.
        </p>
        <div className="onboarding-actions">
          <button className="button button--quiet" type="button" onClick={onRetryCurrent}>
            Retry runtime check
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="setup-callout">
      <strong>SourceNerve is ready.</strong>
      <p>All account, bootstrap, provider, workspace, daemon, and index checks are complete.</p>
    </div>
  );
}

function StatusLine({
  label,
  state,
}: {
  label: string;
  state: "complete" | "current" | "blocked";
}) {
  const badge =
    state === "complete"
      ? { label: "Ready", tone: "ready" as const }
      : state === "current"
        ? { label: "Needs attention", tone: "warning" as const }
        : { label: "Blocked", tone: "neutral" as const };
  return (
    <div className="setup-status-line">
      <StatusBadge label={badge.label} tone={badge.tone} />
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
