import { useEffect, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
  HarnessPolicyDecision,
  HarnessSandboxMode,
} from "../../shared/harness-api";
import { AgentOpsPanel } from "./AgentOpsPanel";
import { HarnessConversationPanel } from "./CodexChatPanel";
import { HarnessContextGatePanel } from "./HarnessContextGatePanel";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

interface PolicyPreset {
  id: string;
  label: string;
  profile: string;
  sandbox: HarnessSandboxMode;
  summary: string;
  detail: string;
  danger?: boolean;
}

const POLICY_PRESETS: PolicyPreset[] = [
  {
    id: "read-only",
    label: "Read only",
    profile: "read-only-analysis",
    sandbox: "read-only",
    summary: "Inspect and analyze",
    detail: "No workspace writes, commands, Git mutations, or provider mutations.",
  },
  {
    id: "workspace-write",
    label: "Workspace write",
    profile: "interactive-local",
    sandbox: "workspace-write",
    summary: "Normal local development",
    detail: "Local writes and commands are allowed. Git and provider mutations still require approval.",
  },
  {
    id: "guarded",
    label: "Guarded",
    profile: "guarded-durable",
    sandbox: "workspace-write",
    summary: "Ask before side effects",
    detail: "Workspace writes are allowed, while commands, Git, and provider side effects require approval.",
  },
  {
    id: "danger-full-access",
    label: "Danger full access",
    profile: "interactive-local",
    sandbox: "danger-full-access",
    summary: "Run outside workspace sandbox",
    detail: "Each full-access workspace_exec still requires an exact one-shot human approval.",
    danger: true,
  },
];

export function HarnessScreen({ onOpenWorkspaces }: { onOpenWorkspaces(): void }) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [runs, setRuns] = useState<DesktopHarnessRunView[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DesktopHarnessRunView | null>(null);
  const [events, setEvents] = useState<DesktopHarnessEventView[]>([]);
  const [jobs, setJobs] = useState<DesktopHarnessJobView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    const timer = window.setInterval(() => { void refreshRun(selectedRunId, true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);

  async function refreshAll(): Promise<void> {
    setBusy("runs");
    setError(null);
    await refreshRuns(undefined, true);
    await refreshWorkspaces();
    setBusy(null);
  }

  async function refreshWorkspaces(): Promise<void> {
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (!result.ok) {
      setError((current) => current ?? result.error.message);
      return;
    }
    setWorkspaces(result.value);
  }

  async function refreshRuns(preferredRunId?: string, silent = false): Promise<void> {
    if (!silent) setBusy("runs");
    setError(null);
    const result = await window.sourcenerveDesktop.listHarnessRuns({ limit: 50 });
    if (!result.ok) {
      setError(result.error.message);
      if (!silent) setBusy(null);
      return;
    }
    setRuns(result.value);
    const preferred = preferredRunId ?? selectedRunId;
    const next = preferred && result.value.some((run) => run.id === preferred)
      ? preferred
      : result.value[0]?.id ?? null;
    setSelectedRunId(next);
    if (next) {
      await refreshRun(next, silent);
    }
    else {
      setSelected(null);
      setEvents([]);
      setJobs([]);
    }
    if (!silent) setBusy(null);
  }

  async function refreshRun(runId: string, silent = false): Promise<void> {
    if (!silent) setBusy(`run:${runId}`);
    setError(null);
    const [runResult, eventResult, jobResult] = await Promise.all([
      window.sourcenerveDesktop.getHarnessRun({ runId }),
      window.sourcenerveDesktop.listHarnessEvents({ runId, afterSeq: -1, limit: 200 }),
      window.sourcenerveDesktop.listHarnessJobs({ runId, limit: 50 }),
    ]);
    if (!runResult.ok) setError(runResult.error.message);
    else setSelected(runResult.value);
    if (!eventResult.ok) setError((current) => current ?? eventResult.error.message);
    else setEvents(eventResult.value);
    if (!jobResult.ok) setError((current) => current ?? jobResult.error.message);
    else setJobs(jobResult.value);
    if (!silent) setBusy(null);
  }

  async function selectRun(runId: string): Promise<void> {
    setSelectedRunId(runId);
    setNotice(null);
    await refreshRun(runId);
  }

  async function switchPolicy(workspace: ManagedWorkspaceView, preset: PolicyPreset): Promise<void> {
    const currentRun = runs.find((run) => run.workspace === workspace.id) ?? null;
    if (currentRun && isPresetActive(currentRun, preset)) {
      await selectRun(currentRun.id);
      return;
    }
    if (preset.danger && !window.confirm(
      "Switch the current Harness policy to danger-full-access?\n\n"
      + "This makes full-access the default workspace_exec sandbox for the new current run. Subsequent workspace operations will pick it up automatically. "
      + "Every full-access command still requires an exact one-shot approval.",
    )) return;

    setBusy(`policy:${workspace.id}:${preset.id}`);
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspace.id,
      profile: preset.profile,
      sandbox: preset.sandbox,
    });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }

    setSelectedRunId(result.value.id);
    setSelected(result.value);
    setNotice(`Policy for ${workspace.name} switched to ${preset.label}. A new auditable Harness run was created; the previous run was not modified.`);
    await refreshRuns(result.value.id, true);
    setBusy(null);
  }

  async function cancelRun(): Promise<void> {
    if (!selected || selected.status !== "running") return;
    if (!window.confirm(`Cancel Harness run ${selected.id}?\n\nThis does not automatically undo already completed side effects.`)) return;
    setBusy("cancel-run");
    const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId: selected.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRuns(selected.id, true);
    setBusy(null);
  }

  async function cancelJob(job: DesktopHarnessJobView): Promise<void> {
    if (job.status !== "active" && job.status !== "pending") return;
    if (!window.confirm(`Cancel Harness job ${job.id}?`)) return;
    setBusy(`job:${job.id}`);
    const result = await window.sourcenerveDesktop.cancelHarnessJob({ runId: job.runId, jobId: job.id });
    if (!result.ok) setError(result.error.message);
    else await refreshRun(job.runId, true);
    setBusy(null);
  }

  return (
    <div className="space-y-4">
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {notice ? <p className="success-banner">{notice}</p> : null}

      <HarnessConversationPanel
        workspaces={workspaces}
        runs={runs}
        selectedRunId={selectedRunId}
        selectedRun={selected}
        onRunSelected={selectRun}
        onChanged={async () => { await refreshRuns(selectedRunId ?? undefined, true); }}
        onOpenWorkspaces={onOpenWorkspaces}
      />

      <Panel
        title="Execution policy"
        eyebrow="Automatic Harness"
        actions={<ActionButton variant="secondary" size="sm" onClick={() => void refreshAll()} disabled={busy !== null}>{busy === "runs" ? "Refreshing…" : "Refresh"}</ActionButton>}
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm text-foreground">Harness starts automatically whenever SourceNerve handles workspace-scoped work.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              No Start Run action or prompt-injected run ID is required. These policy presets are optional overrides; switching creates a new current run and subsequent workspace operations pick it up automatically.
            </p>
          </div>

          {workspaces.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">Add a managed workspace before Harness can attach automatically.</p>
          ) : (
            <div className="space-y-4" aria-label="Harness workspace policies">
              {workspaces.map((workspace) => {
                const currentRun = runs.find((run) => run.workspace === workspace.id) ?? null;
                const workspaceReady = workspace.validation.state === "ready";
                return (
                  <section key={workspace.id} className="rounded-2xl border border-border bg-card/55 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-foreground">{workspace.name}</h3>
                          <span className="status-pill">{workspaceReady ? "Ready" : workspace.validation.state}</span>
                          {currentRun ? <span className="status-pill">{currentRun.status}</span> : <span className="status-pill">No run yet</span>}
                        </div>
                        <p className="mt-1 break-all text-[11px] text-muted-foreground">{workspace.id}{workspace.repository ? ` · ${workspace.repository}` : ""}</p>
                        {!workspaceReady && workspace.validation.message ? (
                          <p className="mt-2 text-xs leading-5 text-warning">{workspace.validation.message}</p>
                        ) : null}
                      </div>
                      {currentRun ? (
                        <ActionButton variant="secondary" size="sm" onClick={() => void selectRun(currentRun.id)} disabled={busy !== null || selectedRunId === currentRun.id}>
                          {selectedRunId === currentRun.id ? "Current run open" : "Open current run"}
                        </ActionButton>
                      ) : null}
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      {POLICY_PRESETS.map((preset) => {
                        const active = Boolean(currentRun && isPresetActive(currentRun, preset));
                        const changing = busy === `policy:${workspace.id}:${preset.id}`;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            disabled={busy !== null || active || !workspaceReady}
                            onClick={() => void switchPolicy(workspace, preset)}
                            className={[
                              "min-h-36 rounded-2xl border p-4 text-left transition",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35",
                              active
                                ? "border-primary/45 bg-primary/8 shadow-sm"
                                : preset.danger
                                  ? "border-danger/35 bg-danger/5 hover:border-danger/55 hover:bg-danger/8"
                                  : "border-border bg-background/55 hover:border-primary/30 hover:bg-muted/35",
                              "disabled:cursor-default disabled:opacity-80",
                            ].join(" ")}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-foreground">{preset.label}</p>
                                <p className="mt-1 text-xs font-medium text-muted-foreground">{preset.summary}</p>
                              </div>
                              {active ? <span className="status-pill">Current</span> : null}
                            </div>
                            <p className="mt-4 text-xs leading-5 text-muted-foreground">{preset.detail}</p>
                            <p className="mt-3 text-[11px] font-medium text-foreground/75">{changing ? "Creating run…" : preset.sandbox}</p>
                          </button>
                        );
                      })}
                    </div>

                    {currentRun?.sandbox === "danger-full-access" ? (
                      <div className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3">
                        <p className="text-sm font-semibold text-foreground">Danger full access is active for this workspace.</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          It does not auto-approve commands. Every full-access <code>workspace_exec</code> is converted to an ASK decision and must be approved once below.
                        </p>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {selected ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
            <Panel
              title="Current run"
              eyebrow={`${selected.workspace} · ${selected.profile}`}
              actions={(
                <div className="flex flex-wrap gap-2">
                  <ActionButton variant="secondary" size="sm" onClick={() => void refreshRun(selected.id)} disabled={busy !== null}>Refresh</ActionButton>
                  {selected.status === "running" ? <ActionButton variant="destructive" size="sm" onClick={() => void cancelRun()} disabled={busy !== null}>Cancel run</ActionButton> : null}
                </div>
              )}
            >
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatePill label={selected.status} />
                  <StatePill label={`origin: ${selected.origin}`} />
                  <StatePill label={`freshness: ${selected.freshnessState}`} />
                  <StatePill label={`recovery: ${selected.recoveryState}`} />
                  <StatePill label={`sandbox: ${selected.sandbox}`} emphasize={selected.sandbox === "danger-full-access"} />
                </div>

                <div>
                  <p className="text-sm leading-6 text-foreground">{selected.profileDescription}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Run <code>{selected.id}</code> · updated {new Date(selected.updatedAt * 1000).toLocaleString()}</p>
                </div>

                <ClosedLoop loop={selected.closedLoop} repositoryContext={selected.repositoryContext} />

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Metric label="Pending approvals" value={selected.pendingApprovals} hint={selected.pendingApprovals > 0 ? "Action required" : "Nothing waiting"} />
                  <Metric label="Active jobs" value={selected.activeJobs} hint="Durable work running" />
                  <Metric label="Uncertain mutations" value={selected.uncertainMutations} hint={selected.uncertainMutations > 0 ? "Review before retry" : "No uncertainty"} />
                  <Metric label="Safe read retries" value={selected.retryableReadExecutions} hint="Can be retried" />
                  <Metric label="Pre-dispatch retries" value={selected.retryablePreDispatchExecutions} hint="No side effect started" />
                  <Metric label="Blocked requests" value={selected.blockedPreDispatchExecutions} hint="Stopped before dispatch" />
                </div>

                <div className="rounded-xl border border-border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Capability policy</p>
                      <p className="mt-1 text-xs text-muted-foreground">Recovery: {humanize(selected.recoveryReason)}{selected.freshnessReason ? ` · ${humanize(selected.freshnessReason)}` : ""}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(selected.policies).map(([name, decision]) => (
                        <PolicyPill key={name} name={name} decision={decision} />
                      ))}
                    </div>
                  </div>
                </div>

                {selected.parentRunId ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                    <p className="text-xs text-muted-foreground">Parent run <code>{selected.parentRunId}</code></p>
                    <ActionButton variant="ghost" size="sm" onClick={() => void selectRun(selected.parentRunId!)} disabled={busy !== null}>Open parent</ActionButton>
                  </div>
                ) : null}

                {selected.children.length > 0 ? (
                  <details className="rounded-xl border border-border p-3">
                    <summary className="cursor-pointer text-xs font-semibold text-foreground">Related child runs ({selected.children.length}{selected.childrenTruncated ? "+" : ""})</summary>
                    <div className="mt-3 space-y-2">
                      {selected.children.map((child) => (
                        <button key={child.id} type="button" onClick={() => void selectRun(child.id)} disabled={busy !== null} className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left hover:bg-muted/40 disabled:opacity-60">
                          <span className="min-w-0"><span className="block truncate text-xs font-medium text-foreground">{child.profile}</span><code className="text-[11px] text-muted-foreground">{child.id}</code></span>
                          <span className="status-pill">{child.status}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}

                {selected.checkpoint ? <p className="text-xs text-muted-foreground">Checkpoint #{selected.checkpoint.eventSeq}: {humanize(selected.checkpoint.state)} · {humanize(selected.checkpoint.reason)}</p> : null}
              </div>
            </Panel>

            <Panel title="Recent runs" eyebrow="Same control plane">
              {runs.length === 0 ? <p className="muted">No Harness runs yet.</p> : (
                <div className="max-h-[520px] space-y-2 overflow-auto pr-1">
                  {runs.slice(0, 12).map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => void selectRun(run.id)}
                      disabled={busy !== null}
                      className={[
                        "w-full rounded-xl border px-3 py-3 text-left transition disabled:opacity-60",
                        selectedRunId === run.id ? "border-primary/40 bg-primary/7" : "border-border hover:bg-muted/35",
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-foreground">{run.workspace}</p>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground">{run.profile} · {run.sandbox}</p>
                        </div>
                        <span className="status-pill">{run.status}</span>
                      </div>
                      <code className="mt-2 block truncate text-[10px] text-muted-foreground">{run.id}</code>
                    </button>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <HarnessContextGatePanel
            runId={selected.id}
            workspace={selected.workspace}
            onRouted={() => void refreshRun(selected.id, true)}
          />

          <AgentOpsPanel
            runId={selected.id}
            runStatus={selected.status}
            onChanged={() => void refreshRun(selected.id, true)}
          />

          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Jobs" eyebrow="Durable work">
              {jobs.length === 0 ? <p className="muted">No jobs for this run.</p> : (
                <div className="max-h-80 space-y-2 overflow-auto pr-1">
                  {jobs.map((job) => (
                    <article className="rounded-xl border border-border p-3" key={job.id}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-foreground">{humanize(job.kind)}</p>
                          <p className="mt-1 truncate text-[11px] text-muted-foreground"><code>{job.id}</code>{job.taskId ? ` · task ${job.taskId}` : ""}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="status-pill">{job.status}</span>
                          {job.status === "active" || job.status === "pending" ? <ActionButton variant="secondary" size="sm" onClick={() => void cancelJob(job)} disabled={busy !== null}>Cancel</ActionButton> : null}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Timeline" eyebrow="Safe execution metadata">
              {events.length === 0 ? <p className="muted">No events recorded.</p> : (
                <ol className="max-h-80 space-y-2 overflow-auto pr-1">
                  {events.map((event) => (
                    <li key={event.seq} className="rounded-xl border border-border px-3 py-2.5">
                      <div className="flex items-start gap-3">
                        <code className="shrink-0 text-[11px] text-muted-foreground">#{event.seq}</code>
                        <div className="min-w-0">
                          <p className="break-words text-xs leading-5 text-foreground">{event.summary}</p>
                          <p className="mt-1 text-[10px] text-muted-foreground">{new Date(event.createdAt * 1000).toLocaleTimeString()}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>
        </>
      ) : (
        <Panel title="No Harness run selected" eyebrow="Getting started">
          <p className="text-sm text-muted-foreground">Start a Harness-backed task or job first. Runs will appear here automatically and can then be opened, inspected, or switched to a different policy.</p>
        </Panel>
      )}
    </div>
  );
}

function isPresetActive(run: DesktopHarnessRunView, preset: PolicyPreset): boolean {
  return run.profile === preset.profile && run.sandbox === preset.sandbox;
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function StatePill({ label, emphasize = false }: { label: string; emphasize?: boolean }) {
  return <span className={emphasize ? "rounded-full border border-danger/30 bg-danger/8 px-2.5 py-1 text-[11px] font-medium text-danger" : "status-pill"}>{humanize(label)}</span>;
}

function PolicyPill({ name, decision }: { name: string; decision: HarnessPolicyDecision }) {
  const classes = decision === "allow"
    ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
    : decision === "ask"
      ? "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300"
      : "border-border bg-muted/45 text-muted-foreground";
  return <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${classes}`}>{name}: {decision}</span>;
}


function ClosedLoop({ loop, repositoryContext }: { loop: DesktopHarnessRunView["closedLoop"]; repositoryContext: DesktopHarnessRunView["repositoryContext"] }) {
  const steps = [
    { id: "context", label: "Context", value: `${loop.contextReads} reads` },
    { id: "execute", label: "Execute", value: `${loop.executions} actions` },
    { id: "verify", label: "Verify", value: loop.verificationRequired ? "required" : loop.verificationStatus },
    { id: "recover", label: "Recover", value: loop.recoveryStatus },
    { id: "learn", label: "Learn", value: `${loop.learningCount} learned` },
  ] as const;

  return (
    <div className="rounded-xl border border-border bg-muted/15 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Closed loop</p>
          <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[10px] font-semibold text-foreground">Work shape: {humanize(loop.workShape)}</span>
          {loop.selectedProofType ? (
            <span className="rounded-full border border-primary/25 bg-primary/8 px-2.5 py-1 text-[10px] font-semibold text-primary">Proof: {humanize(loop.selectedProofType)}</span>
          ) : null}
        </div>
        {loop.lastFailureTool ? (
          <span className="text-[11px] text-muted-foreground">
            Last failure: <code>{loop.lastFailureTool}</code>{loop.lastFailureCategory ? ` · ${humanize(loop.lastFailureCategory)}` : ""}
          </span>
        ) : null}
      </div>
      {(loop.workScope || loop.selectedProofSource || loop.selectedProofCommand) ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-border bg-card/60 px-3 py-2.5 text-[11px] leading-5 text-muted-foreground md:grid-cols-2">
          <div>
            <span className="font-medium text-foreground">Scope:</span> {loop.workScope ?? "repository"}
            <br />
            <span className="font-medium text-foreground">Proof owner:</span> {loop.selectedProofSource ?? "repository semantics"}
          </div>
          <div>
            <span className="font-medium text-foreground">Recommended proof:</span> {loop.selectedProofCommand ? <code>{loop.selectedProofCommand}</code> : loop.selectedProofType ? humanize(loop.selectedProofType) : "none"}
            <br />
            <span className="font-medium text-foreground">Satisfied:</span> {loop.satisfiedProofs.length > 0 ? loop.satisfiedProofs.map(humanize).join(", ") : "none"}
          </div>
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-5">
        {steps.map((step) => {
          const active = loop.phase === step.id;
          return (
            <div
              key={step.id}
              className={active
                ? "rounded-lg border border-primary/40 bg-primary/8 px-3 py-2.5"
                : "rounded-lg border border-border bg-card/70 px-3 py-2.5"}
            >
              <p className="text-[11px] font-semibold text-foreground">{step.label}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{humanize(step.value)}</p>
            </div>
          );
        })}
      </div>
      {(repositoryContext.entrypoints.length > 0 || repositoryContext.guidance.length > 0 || repositoryContext.activePlans.length > 0 || repositoryContext.validationOwners.length > 0) ? (
        <details className="mt-3 rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-foreground">Repository context{repositoryContext.truncated ? " (bounded)" : ""}</summary>
          <div className="mt-2 space-y-2 text-[11px] leading-5 text-muted-foreground">
            {repositoryContext.entrypoints.length > 0 ? <p><span className="font-medium text-foreground">Entrypoints:</span> {repositoryContext.entrypoints.join(", ")}</p> : null}
            {repositoryContext.guidance.length > 0 ? <p><span className="font-medium text-foreground">Guidance:</span> {repositoryContext.guidance.join(", ")}</p> : null}
            {repositoryContext.activePlans.length > 0 ? <p><span className="font-medium text-foreground">Active plans:</span> {repositoryContext.activePlans.join(", ")}</p> : null}
            {repositoryContext.validationOwners.length > 0 ? <p><span className="font-medium text-foreground">Validation owners:</span> {repositoryContext.validationOwners.join(", ")}</p> : null}
            {repositoryContext.proofCandidates.length > 0 ? (
              <div>
                <p className="font-medium text-foreground">Proof catalog:</p>
                <div className="mt-1 space-y-1">
                  {repositoryContext.proofCandidates.slice(0, 8).map((candidate) => (
                    <p key={`${candidate.proofType}:${candidate.source}:${candidate.command}`}>
                      <span className="font-medium">{humanize(candidate.proofType)}</span> · <code>{candidate.command}</code> · {candidate.source}
                    </p>
                  ))}
                  {repositoryContext.proofCandidates.length > 8 ? <p>+{repositoryContext.proofCandidates.length - 8} more proof candidates</p> : null}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
      {loop.learningHints.length > 0 ? (
        <details className="mt-3 rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-foreground">Learned patterns ({loop.learningHints.length})</summary>
          <div className="mt-2 space-y-2">
            {loop.learningHints.map((hint) => (
              <div key={`${hint.tool}:${hint.errorCategory}`} className="rounded-md border border-border/70 px-2.5 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="text-[10px] text-foreground">{hint.tool} · {humanize(hint.errorCategory)}</code>
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {hint.state === "fresh-run-validated" ? `${hint.confirmations} fresh rerun${hint.confirmations === 1 ? "" : "s"}` : "Fresh rerun pending"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{hint.suggestion}</p>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-3">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}
