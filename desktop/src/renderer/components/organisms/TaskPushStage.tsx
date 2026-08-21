import { UploadCloud } from "lucide-react";

import type { DesktopTaskPushResult, DesktopTaskSnapshot } from "../../../shared/task-api";
import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
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
    <SurfaceCard title="5. Push exact task commit" eyebrow="Externally visible action · explicit confirmation required" description="Push publishes only the persisted task commit to its recorded task branch. No force flag or custom refspec is exposed.">
      <div className="space-y-4">
        <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
          <Fact label="Remote" value={workspace?.remote ?? "—"} />
          <Fact label="Branch" value={selected.lifecycle.branch ?? "—"} />
          <Fact label="Commit" value={selected.lifecycle.commitSha ?? "—"} mono />
        </div>

        <InlineNotice tone="warning" title="Push is externally visible">
          SourceNerve will push the exact persisted task commit only after explicit confirmation. Default-branch writes, force push and custom refspecs remain unavailable.
        </InlineNotice>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <div className="flex flex-wrap gap-2">
            <StatusPill tone="neutral">Remote: {workspace?.remote ?? "—"}</StatusPill>
            <StatusPill tone="neutral">Branch: {selected.lifecycle.branch ?? "—"}</StatusPill>
          </div>
          <ActionButton disabled={busy === "push"} onClick={onPush}>
            <UploadCloud className="size-4" aria-hidden="true" />
            {busy === "push" ? "Pushing…" : "Push exact commit"}
          </ActionButton>
        </div>
        {pushed ? (
          <InlineNotice tone="success" title="Task commit pushed" role="status">
            Pushed <code className="select-all break-all font-mono text-[11px] text-foreground">{pushed.push.head}</code> to {pushed.push.remote}/{pushed.push.branch}.
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

export function TaskPushedCard({ selected }: { selected: DesktopTaskSnapshot }) {
  return (
    <SurfaceCard title="Task pushed" eyebrow="Provider lifecycle remains separate" description="The repository mutation workflow is complete; issue/PR/MR creation and merge remain a separate guarded provider lifecycle." actions={<StatusPill dot tone="ready">Ready for provider workflow</StatusPill>}>
      <InlineNotice tone="success" title="Exact task commit is remote">
        Commit <code className="select-all break-all font-mono text-[11px] text-foreground">{selected.lifecycle.pushSha}</code> is pushed on <strong className="text-foreground">{selected.lifecycle.branch}</strong>.
      </InlineNotice>
    </SurfaceCard>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs leading-5 text-foreground ${mono ? "select-all font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
