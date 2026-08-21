import { GitCommitHorizontal } from "lucide-react";

import type { DesktopTaskCommitResult, DesktopTaskReviewResult } from "../../../shared/task-api";
import { ActionButton } from "../atoms/ActionButton";
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
    <SurfaceCard title="4. Commit reviewed state" eyebrow="Exact reviewed diff SHA required">
      <div className="space-y-4">
        {!reviewed ? <p className="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-xs leading-5 text-warning">Reload the reviewed diff in this session before commit. The server keeps the SHA gate, but Desktop requires the user-visible diff too.</p> : null}
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Commit message</span>
          <textarea className="min-h-24 w-full rounded-xl border border-border bg-background/70 px-3 py-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={commitMessage} rows={3} maxLength={16 * 1024} onChange={(event) => onCommitMessage(event.target.value)} placeholder="feat: describe guarded change" />
        </label>
        <ActionButton size="sm" disabled={!reviewed || !commitMessage.trim() || busy === "commit"} onClick={onCommit}>
          <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
          {busy === "commit" ? "Committing…" : "Commit exact reviewed delta"}
        </ActionButton>
        {committed ? <p className="rounded-xl border border-success/20 bg-success/5 px-3 py-2 text-xs leading-5 text-success">Commit <code>{committed.commit.commit}</code> created on {committed.commit.branch}. Working tree clean: {String(committed.commit.clean)}.</p> : null}
      </div>
    </SurfaceCard>
  );
}
