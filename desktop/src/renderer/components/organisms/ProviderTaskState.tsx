import { RefreshCw } from "lucide-react";

import type { DesktopTaskListItem } from "../../../shared/task-api";
import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, providerLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const selectClass = "h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

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
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <SurfaceCard title="Durable task" eyebrow="Provider operations require task context">
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

      <SurfaceCard title="Current provider state" eyebrow="Task lifecycle + fresh provider observation">
        {state ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusPill dot tone="ready">{providerLabel(state.provider)}</StatusPill>
              <StatusPill tone={state.lifecyclePhase === "merged" || state.lifecyclePhase === "completed" ? "ready" : "working"}>Task: {state.lifecyclePhase}</StatusPill>
              {pull ? <StatusPill tone={pull.state === "merged" ? "ready" : pull.state === "open" ? "working" : "warning"}>{providerChangeLabel(state.provider)}: {pull.state}{pull.draft ? " draft" : ""}</StatusPill> : null}
            </div>
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

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
