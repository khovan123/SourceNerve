import { ScanSearch } from "lucide-react";

import type { DesktopTaskApplyResult, DesktopTaskReviewResult } from "../../../shared/task-api";
import { shortTaskSha } from "../../task-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskReviewStage({
  phase,
  applied,
  reviewed,
  busy,
  onReview,
}: {
  phase: string;
  applied: DesktopTaskApplyResult | null;
  reviewed: DesktopTaskReviewResult | null;
  busy: string | null;
  onReview(): void;
}) {
  return (
    <SurfaceCard title="3. Review applied delta" eyebrow="Complete diff + SHA gate before commit">
      <div className="space-y-4">
        {applied ? <DiffBlock title="Applied result" diff={applied.diff} /> : <p className="text-sm leading-6 text-muted-foreground">Applied diff is not persisted in Desktop. Run Review to load the complete current delta and record its SHA gate.</p>}
        <ActionButton size="sm" disabled={busy === "review"} onClick={onReview}>
          <ScanSearch className="size-3.5" aria-hidden="true" />
          {busy === "review" ? "Reviewing…" : phase === "reviewed" ? "Reload reviewed diff" : "Review complete delta"}
        </ActionButton>
        {reviewed ? <DiffBlock title={`Reviewed ${reviewed.review.branch} @ ${shortTaskSha(reviewed.review.head)}`} diff={reviewed.review.diff} sha={reviewed.review.diffSha256} /> : null}
      </div>
    </SurfaceCard>
  );
}

function DiffBlock({ title, diff, sha }: { title: string; diff: string; sha?: string }) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-xs text-foreground">{title}</strong>
        {sha ? <code className="break-all text-[10px] text-muted-foreground">SHA-256 {sha}</code> : null}
      </div>
      <pre className="max-h-[34rem] overflow-auto rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#f2eadf] dark:bg-black/40"><code>{diff || "(empty diff)"}</code></pre>
    </div>
  );
}
