import { CheckCircle2, RefreshCw } from "lucide-react";

import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function ProviderCompletionCard({
  state,
  busy,
  onSync,
}: {
  state: ProviderWorkflowState;
  busy: string | null;
  onSync(): void;
}) {
  if (state.defaultSyncedHead) {
    return (
      <SurfaceCard title="Provider workflow complete" eyebrow="Phase 4 · merged + default branch synced" description="The provider merge is complete and the local default branch has been explicitly synchronized." actions={<StatusPill dot tone="ready">Complete</StatusPill>}>
        <InlineNotice tone="success" title="Default branch synchronized" role="status">
          <span className="inline-flex min-w-0 items-start gap-2"><CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Default branch <strong className="text-foreground">{state.defaultBranch}</strong> synced to <code className="select-all break-all font-mono text-[11px] text-foreground">{state.defaultSyncedHead}</code>.</span>
        </InlineNotice>
      </SurfaceCard>
    );
  }

  if (state.lifecyclePhase !== "merged" || !state.mergeSha) return null;
  return (
    <SurfaceCard title="Sync default branch" eyebrow="Phase 4 · separate explicit post-merge action" description="Provider merge does not silently move local default-branch state. Synchronization remains a distinct guarded action.">
      <div className="space-y-4">
        <InlineNotice tone="info" title="Provider merge is complete">
          Provider merge SHA: <code className="select-all break-all font-mono text-[11px] text-foreground">{state.mergeSha}</code>. Local default branch <strong className="text-foreground">{state.defaultBranch}</strong> has not been marked synced by this task yet.
        </InlineNotice>
        <div className="flex justify-end">
          <ActionButton disabled={busy === "sync"} onClick={onSync}>
            <RefreshCw className={`size-4 ${busy === "sync" ? "animate-spin" : ""}`} aria-hidden="true" />
            {busy === "sync" ? "Syncing…" : `Sync ${state.defaultBranch}`}
          </ActionButton>
        </div>
      </div>
    </SurfaceCard>
  );
}
