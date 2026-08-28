import { GitPullRequest, ListChecks, RefreshCw } from "lucide-react";

import type { DesktopTaskListItem } from "../../../shared/task-api";
import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, providerLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { EmptyState } from "../molecules/EmptyState";
import { ProgressRail } from "../molecules/ProgressRail";
import { SurfaceCard } from "../molecules/SurfaceCard";

const selectClass = "h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";
const PROVIDER_READY_PHASES = new Set(["pushed", "pr_open", "merged", "completed"]);

const PROVIDER_STEPS = [
  { id: "pushed", label: "Task pushed", description: "Exact task commit is remote" },
  { id: "pr_open", label: "PR / MR", description: "Change request created" },
  { id: "merged", label: "Merged", description: "Exact provider head merged" },
  { id: "completed", label: "Synced", description: "Default branch synced locally" },
];

export function ProviderTaskState({
  tasks,
  selectedTaskId,
  selectedWorkspace,
  state,
  busy,
  onSelectTask,
  onRefresh,
  onReloadTasks,
  onOpenTasks,
}: {
  tasks: DesktopTaskListItem[];
  selectedTaskId: string;
  selectedWorkspace?: string;
  state: ProviderWorkflowState | null;
  busy: string | null;
  onSelectTask(taskId: string): void;
  onRefresh(): void;
  onReloadTasks(): void;
  onOpenTasks(): void;
}) {
  const pull = state?.pull;
  const progressIndex = providerProgressIndex(state);
  const selectedItem = tasks.find((item) => item.taskId === selectedTaskId);
  const selectedPhase = selectedItem?.snapshot?.lifecycle.phase;
  const providerReady = Boolean(selectedPhase && PROVIDER_READY_PHASES.has(selectedPhase));

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
      <SurfaceCard title="Durable task" description="Select the pushed task whose recorded repository/head state should drive provider operations.">
        {tasks.length === 0 ? (
          <EmptyState
            compact
            icon={ListChecks}
            title="No durable task is available for Pull Requests yet."
            description="Start a guarded task, finish review/commit, and push the exact task commit before creating a provider change request."
            action={(
              <div className="flex flex-wrap justify-center gap-2">
                <ActionButton size="sm" onClick={onOpenTasks}>
                  <ListChecks className="size-3.5" aria-hidden="true" />
                  Open Tasks
                </ActionButton>
                <ActionButton variant="secondary" size="sm" disabled={busy === "tasks"} aria-busy={busy === "tasks"} onClick={onReloadTasks}>
                  <RefreshCw className={`size-3.5 ${busy === "tasks" ? "animate-spin" : ""}`} aria-hidden="true" />
                  {busy === "tasks" ? "Refreshing…" : "Refresh tasks"}
                </ActionButton>
              </div>
            )}
          />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="grid min-w-0 gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Task</span>
                <select className={selectClass} value={selectedTaskId} disabled={busy === "tasks"} onChange={(event) => onSelectTask(event.target.value)}>
                  <option value="">Select a task</option>
                  {tasks.map((item) => (
                    <option value={item.taskId} key={item.taskId}>
                      {item.snapshot?.task.contextQuery || item.taskId} · {item.snapshot?.lifecycle.phase ?? "unavailable"}
                    </option>
                  ))}
                </select>
              </label>
              <ActionButton variant="secondary" size="md" disabled={!selectedTaskId || busy === "state"} aria-busy={busy === "state"} onClick={onRefresh} className="sm:self-end">
                <RefreshCw className={`size-4 ${busy === "state" ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === "state" ? "Refreshing…" : "Refresh state"}
              </ActionButton>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
              <ActionButton variant="ghost" size="sm" disabled={busy === "tasks"} aria-busy={busy === "tasks"} onClick={onReloadTasks}>
                <RefreshCw className={`size-3.5 ${busy === "tasks" ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === "tasks" ? "Refreshing…" : "Refresh tasks"}
              </ActionButton>
              <ActionButton variant="ghost" size="sm" onClick={onOpenTasks}>
                <ListChecks className="size-3.5" aria-hidden="true" />
                Open Tasks
              </ActionButton>
              {selectedWorkspace ? <StatusPill tone="neutral">Workspace: {selectedWorkspace}</StatusPill> : null}
            </div>

            {selectedItem?.unavailableReason ? (
              <p className="text-xs leading-5 text-warning">{selectedItem.unavailableReason}</p>
            ) : selectedPhase && !providerReady ? (
              <div className="rounded-xl border border-warning/25 bg-warning/[0.055] px-3 py-3">
                <p className="text-xs font-semibold text-foreground">Task is not pushed yet.</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Current phase: {selectedPhase}. Continue this task through review, commit and push; Pull Requests will then use its exact pushed SHA.</p>
                <div className="mt-3">
                  <ActionButton size="sm" onClick={onOpenTasks}>
                    <ListChecks className="size-3.5" aria-hidden="true" />
                    Continue in Tasks
                  </ActionButton>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </SurfaceCard>

      <SurfaceCard title="Provider lifecycle" description="Create, merge and sync are separate explicit phases. Provider checks and exact-head validation remain authoritative.">
        {state ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusPill dot tone="ready">{providerLabel(state.provider)}</StatusPill>
              <StatusPill tone={state.lifecyclePhase === "merged" || state.lifecyclePhase === "completed" ? "ready" : "working"}>Task: {state.lifecyclePhase}</StatusPill>
              {pull ? <StatusPill tone={pull.state === "merged" ? "ready" : pull.state === "open" ? "working" : "warning"}>{providerChangeLabel(state.provider)}: {pull.state}{pull.draft ? " draft" : ""}</StatusPill> : null}
            </div>

            <ProgressRail ariaLabel="Provider lifecycle progress" compact currentIndex={progressIndex} steps={PROVIDER_STEPS} />

            <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              <Fact label="Repository" value={state.repository} />
              <Fact label="Default branch" value={state.defaultBranch} />
              <Fact label="Task branch" value={state.taskBranch ?? "—"} />
              <Fact label="Task push" value={state.taskPushSha ? shortProviderSha(state.taskPushSha) : "—"} mono />
              <Fact label="PR/MR" value={state.pullNumber ? `#${state.pullNumber}` : "—"} />
              <Fact label="Recorded head" value={state.pullHeadSha ? shortProviderSha(state.pullHeadSha) : "—"} mono />
            </dl>

            {!providerReady ? (
              <div className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning/[0.055] px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">Provider PR creation unlocks after the task is pushed.</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">SourceNerve will not invent a branch or SHA outside the durable task lifecycle.</p>
                </div>
                <ActionButton size="sm" onClick={onOpenTasks} className="shrink-0">
                  <ListChecks className="size-3.5" aria-hidden="true" />
                  Continue in Tasks
                </ActionButton>
              </div>
            ) : null}
          </div>
        ) : selectedItem?.snapshot && providerReady ? (
          <EmptyState
            compact
            icon={GitPullRequest}
            title={busy === "state" ? "Loading provider state…" : "Provider state is unavailable."}
            description={busy === "state" ? "SourceNerve is loading the durable task and provider observation." : "Retry the provider state. If it still fails, review the error above and provider connection in Connections."}
            action={busy === "state" ? undefined : (
              <ActionButton variant="secondary" size="sm" onClick={onRefresh}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Retry provider state
              </ActionButton>
            )}
          />
        ) : (
          <p className="text-sm leading-6 text-muted-foreground">Select a durable task. Pull Request actions become available only after the exact task commit is pushed.</p>
        )}
      </SurfaceCard>
    </div>
  );
}

function providerProgressIndex(state: ProviderWorkflowState | null): number {
  if (!state) return 0;
  if (state.defaultSyncedHead || state.lifecyclePhase === "completed") return 3;
  if (state.mergeSha || state.lifecyclePhase === "merged") return 2;
  if (state.pull || state.pullNumber || state.lifecyclePhase === "pr_open") return 1;
  return 0;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "select-all font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
