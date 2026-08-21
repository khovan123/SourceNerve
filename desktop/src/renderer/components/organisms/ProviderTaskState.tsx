import { RefreshCw } from "lucide-react";

import type { DesktopTaskListItem } from "../../../shared/task-api";
import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, providerLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { ProgressRail } from "../molecules/ProgressRail";
import { SurfaceCard } from "../molecules/SurfaceCard";

const selectClass = "h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

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
}: {
  tasks: DesktopTaskListItem[];
  selectedTaskId: string;
  selectedWorkspace?: string;
  state: ProviderWorkflowState | null;
  busy: string | null;
  onSelectTask(taskId: string): void;
  onRefresh(): void;
}) {
  const pull = state?.pull;
  const progressIndex = providerProgressIndex(state);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
      <SurfaceCard title="Durable task" eyebrow="Provider operations require task context" description="Select the pushed task whose recorded repository/head state should drive provider operations.">
        <div className="space-y-4">
          <label className="grid gap-1.5">
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
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton variant="secondary" size="sm" disabled={!selectedTaskId || busy === "state"} onClick={onRefresh}>
              <RefreshCw className={`size-3.5 ${busy === "state" ? "animate-spin" : ""}`} aria-hidden="true" />
              {busy === "state" ? "Refreshing…" : "Refresh task/provider state"}
            </ActionButton>
            {selectedWorkspace ? <StatusPill tone="neutral">Workspace: {selectedWorkspace}</StatusPill> : null}
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard title="Provider lifecycle" eyebrow="Task state + fresh provider observation" description="Create, merge and sync are separate explicit phases. Provider checks and exact-head validation remain authoritative.">
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
          </div>
        ) : <p className="text-sm leading-6 text-muted-foreground">Select a durable task with explicit provider configuration.</p>}
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
