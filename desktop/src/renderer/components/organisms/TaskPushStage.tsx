import { UploadCloud } from "lucide-react";

import type { DesktopTaskPushResult, DesktopTaskSnapshot } from "../../../shared/task-api";
import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskPushStage({
  selected,
  workspace,
  pushed,
  busy,
  onPush,
}: {
  selected: DesktopTaskSnapshot;
  workspace: ManagedWorkspaceView | null;
  pushed: DesktopTaskPushResult | null;
  busy: string | null;
  onPush(): void;
}) {
  return (
    <SurfaceCard title="5. Push exact task commit" eyebrow="Externally visible action · explicit confirmation required">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone="neutral">Remote: {workspace?.remote ?? "—"}</StatusPill>
          <StatusPill tone="neutral">Branch: {selected.lifecycle.branch ?? "—"}</StatusPill>
        </div>
        <div className="rounded-xl border border-border bg-muted/25 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">Commit {selected.lifecycle.commitSha ?? "—"}</div>
        <p className="text-xs leading-5 text-muted-foreground">SourceNerve pushes only the persisted task commit. Desktop provides no force flag and no custom refspec.</p>
        <ActionButton size="sm" disabled={busy === "push"} onClick={onPush}>
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {busy === "push" ? "Pushing…" : "Push exact commit"}
        </ActionButton>
        {pushed ? <p className="rounded-xl border border-success/20 bg-success/5 px-3 py-2 text-xs leading-5 text-success">Pushed {pushed.push.head} to {pushed.push.remote}/{pushed.push.branch}.</p> : null}
      </div>
    </SurfaceCard>
  );
}

export function TaskPushedCard({ selected }: { selected: DesktopTaskSnapshot }) {
  return (
    <SurfaceCard title="Task pushed" eyebrow="Provider lifecycle remains separate" actions={<StatusPill dot tone="ready">Ready for provider workflow</StatusPill>}>
      <p className="text-sm leading-6 text-muted-foreground">Exact commit <code className="text-xs text-foreground">{selected.lifecycle.pushSha}</code> is pushed on <strong className="text-foreground">{selected.lifecycle.branch}</strong>. Issue / PR creation and merge remain a separate guarded provider step.</p>
    </SurfaceCard>
  );
}
