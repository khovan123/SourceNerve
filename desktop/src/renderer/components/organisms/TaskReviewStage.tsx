import { ScanSearch } from "lucide-react";

import type { DesktopTaskApplyResult, DesktopTaskReviewResult } from "../../../shared/task-api";
import { shortTaskSha } from "../../task-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { CodeSurface } from "../molecules/CodeSurface";
import { InlineNotice } from "../molecules/InlineNotice";
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
    <SurfaceCard title="3. Review applied delta" eyebrow="Complete diff + SHA gate before commit" description="The current working-tree delta must be visible in this session before its exact SHA can unlock commit.">
      <div className="space-y-4">
        {!applied ? (
          <InlineNotice tone="neutral" title="Applied diff is not persisted in Desktop">
            Run Review to load the complete current delta and record its SHA gate before commit.
          </InlineNotice>
        ) : <DiffBlock title="Applied result" diff={applied.diff} />}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/15 p-3">
          <p className="text-[11px] leading-5 text-muted-foreground">Review re-reads the complete delta from the authoritative task/workspace state. It does not trust a previously displayed patch.</p>
          <ActionButton size="sm" disabled={busy === "review"} onClick={onReview}>
            <ScanSearch className="size-3.5" aria-hidden="true" />
            {busy === "review" ? "Reviewing…" : phase === "reviewed" ? "Reload reviewed diff" : "Review complete delta"}
          </ActionButton>
        </div>

        {reviewed ? <DiffBlock title={`Reviewed ${reviewed.review.branch} @ ${shortTaskSha(reviewed.review.head)}`} diff={reviewed.review.diff} sha={reviewed.review.diffSha256} /> : null}
      </div>
    </SurfaceCard>
  );
}

function DiffBlock({ title, diff, sha }: { title: string; diff: string; sha?: string }) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card/55 p-3">
      <CodeSurface title={title} meta={sha ? `SHA-256 ${sha}` : undefined} maxHeightClass="max-h-[38rem]">{diff || "(empty diff)"}</CodeSurface>
    </div>
  );
}
