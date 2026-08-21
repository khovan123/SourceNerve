import { CheckCircle2, RefreshCw } from "lucide-react";

import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
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
      <SurfaceCard title="Provider workflow complete" eyebrow="Merged + default branch synced" actions={<StatusPill dot tone="ready">Complete</StatusPill>}>
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-success/20 bg-success/10 text-success">
            <CheckCircle2 className="size-4" aria-hidden="true" />
          </div>
          <p className="text-sm leading-6 text-muted-foreground">Default branch <strong className="text-foreground">{state.defaultBranch}</strong> synced to <code className="text-xs text-foreground">{state.defaultSyncedHead}</code>.</p>
        </div>
      </SurfaceCard>
    );
  }

  if (state.lifecyclePhase !== "merged" || !state.mergeSha) return null;
  return (
    <SurfaceCard title="Default branch sync" eyebrow="Separate explicit post-merge action">
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Provider merge SHA: <code className="text-xs text-foreground">{state.mergeSha}</code>. Local default branch <strong className="text-foreground">{state.defaultBranch}</strong> has not been marked synced by this task yet.
        </p>
        <ActionButton size="sm" disabled={busy === "sync"} onClick={onSync}>
          <RefreshCw className={`size-3.5 ${busy === "sync" ? "animate-spin" : ""}`} aria-hidden="true" />
          {busy === "sync" ? "Syncing…" : `Sync ${state.defaultBranch}`}
        </ActionButton>
      </div>
    </SurfaceCard>
  );
}
