import { GitCommitHorizontal } from "lucide-react";

import type { DesktopTaskCommitResult, DesktopTaskReviewResult } from "../../../shared/task-api";
import { ActionButton } from "../atoms/ActionButton";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskCommitStage({
  reviewed,
  commitMessage,
  committed,
  busy,
  onCommitMessage,
  onCommit,
}: {
  reviewed: DesktopTaskReviewResult | null;
  commitMessage: string;
  committed: DesktopTaskCommitResult | null;
  busy: string | null;
  onCommitMessage(value: string): void;
  onCommit(): void;
}) {
  return (
    <SurfaceCard title="4. Commit reviewed state" eyebrow="Exact reviewed diff SHA required" description="Commit is enabled only when the complete reviewed diff is loaded in this session and still matches the durable SHA gate.">
      <div className="space-y-4">
        {!reviewed ? (
          <InlineNotice tone="warning" title="Review required before commit">
            Reload the reviewed diff in this session. The server keeps the SHA gate, but Desktop also requires the user-visible diff before enabling commit.
          </InlineNotice>
        ) : (
          <InlineNotice tone="success" title="Reviewed diff loaded">
            Commit will target the exact reviewed delta and fail closed if the review state changes.
          </InlineNotice>
        )}
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Commit message</span>
          <textarea className="min-h-24 w-full rounded-xl border border-border bg-background/70 px-3 py-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={commitMessage} rows={3} maxLength={16 * 1024} onChange={(event) => onCommitMessage(event.target.value)} placeholder="feat: describe guarded change" />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="text-[11px] leading-5 text-muted-foreground">This action commits only the exact reviewed delta; no arbitrary staging or direct Git command is exposed.</p>
          <ActionButton disabled={!reviewed || !commitMessage.trim() || busy === "commit"} onClick={onCommit}>
            <GitCommitHorizontal className="size-4" aria-hidden="true" />
            {busy === "commit" ? "Committing…" : "Commit exact reviewed delta"}
          </ActionButton>
        </div>
        {committed ? (
          <InlineNotice tone="success" title="Commit created" role="status">
            Commit <code className="select-all break-all font-mono text-[11px] text-foreground">{committed.commit.commit}</code> created on {committed.commit.branch}. Working tree clean: {String(committed.commit.clean)}.
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}
