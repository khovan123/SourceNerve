import { RefreshCw, Trash2 } from "lucide-react";

import type { DesktopTaskSnapshot } from "../../../shared/task-api";
import { shortTaskSha, TASK_PHASES } from "../../task-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { ProgressRail } from "../molecules/ProgressRail";
import { SurfaceCard } from "../molecules/SurfaceCard";

const PHASE_DESCRIPTIONS: Record<string, string> = {
  snapshot: "Base HEAD + graph locked",
  branched: "Task branch ready",
  patched: "Proposal applied",
  reviewed: "Complete diff reviewed",
  committed: "Exact review committed",
  pushed: "Exact commit pushed",
};

export function TaskSummaryCard({
  selected,
  writable,
  phaseIndex,
  busy,
  onRefresh,
  onCancel,
}: {
  selected: DesktopTaskSnapshot;
  writable: boolean;
  phaseIndex: number;
  busy: string | null;
  onRefresh(): void;
  onCancel(): void;
}) {
  return (
    <SurfaceCard
      title={`Task ${selected.task.id}`}
      eyebrow={`${selected.task.workspace} · durable lifecycle`}
      description="Every mutation advances an explicit durable stage; later actions stay gated by the exact state recorded in earlier stages."
      actions={(
        <div className="flex flex-wrap gap-2">
          <ActionButton variant="secondary" size="sm" onClick={onRefresh}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </ActionButton>
          {selected.task.status !== "cancelled" && selected.lifecycle.phase !== "pushed" ? (
            <ActionButton variant="ghost" size="sm" disabled={busy === "cancel"} onClick={onCancel} className="text-danger hover:text-danger">
              <Trash2 className="size-3.5" aria-hidden="true" />
              {busy === "cancel" ? "Cancelling…" : "Cancel task"}
            </ActionButton>
          ) : null}
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={selected.task.status === "active" || selected.task.status === "applied" ? "ready" : "warning"}>Task: {selected.task.status}</StatusPill>
          <StatusPill tone={selected.lifecycle.phase === "pushed" ? "ready" : "working"}>Phase: {selected.lifecycle.phase}</StatusPill>
          <StatusPill tone={writable ? "ready" : "warning"}>{writable ? "Read-write" : "Read-only — mutations hidden"}</StatusPill>
        </div>

        <ProgressRail
          ariaLabel="Task lifecycle progress"
          currentIndex={Math.max(0, phaseIndex)}
          steps={TASK_PHASES.map((phase) => ({ id: phase, label: phase, description: PHASE_DESCRIPTIONS[phase] }))}
        />

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Base HEAD" value={shortTaskSha(selected.task.baseHead)} mono />
          <Fact label="Branch" value={selected.lifecycle.branch ?? "Not created"} />
          <Fact label="Review SHA" value={selected.lifecycle.reviewedDiffSha256 ? shortTaskSha(selected.lifecycle.reviewedDiffSha256) : "Not reviewed"} mono />
          <Fact label="Commit" value={selected.lifecycle.commitSha ? shortTaskSha(selected.lifecycle.commitSha) : "Not committed"} mono />
          <Fact label="Push" value={selected.lifecycle.pushSha ? shortTaskSha(selected.lifecycle.pushSha) : "Not pushed"} mono />
        </dl>

        {selected.task.staleReason ? (
          <InlineNotice tone="danger" title="Task is stale" role="alert">
            {selected.task.staleReason}
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "select-all font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
