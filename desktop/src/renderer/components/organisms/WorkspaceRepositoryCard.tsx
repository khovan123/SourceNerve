import { DatabaseZap, Pencil, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";

import type { GitTransportValidation, ManagedWorkspaceView } from "../../../shared/desktop-api";
import { workspaceIndexTone } from "../../workspace-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function WorkspaceRepositoryCard({
  workspace,
  busy,
  indexing,
  checkingTransport,
  transportCheck,
  confirmingRemove,
  onEdit,
  onIndex,
  onCheckTransport,
  onCancelIndex,
  onRemove,
  onCancelRemove,
}: {
  workspace: ManagedWorkspaceView;
  busy: boolean;
  indexing: boolean;
  checkingTransport: boolean;
  transportCheck?: GitTransportValidation;
  confirmingRemove: boolean;
  onEdit(): void;
  onIndex(): void;
  onCheckTransport(): void;
  onCancelIndex(): void;
  onRemove(): void;
  onCancelRemove(): void;
}) {
  const valid = workspace.validation.state === "ready";
  const repositoryLabel = workspace.repository ?? workspace.name;

  return (
    <SurfaceCard
      title={workspace.name}
      eyebrow={workspace.id}
      description={`${repositoryLabel} · ${workspace.branch ?? "Detached"} → ${workspace.defaultBranch}`}
      actions={<StatusPill dot tone={valid ? "ready" : "warning"}>{valid ? "Ready" : "Needs attention"}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={workspace.access === "read-write" ? "ready" : "neutral"}>{workspace.access === "read-write" ? "Read-write" : "Read-only"}</StatusPill>
          <StatusPill tone={workspaceIndexTone(workspace.index.state)}>Index: {workspace.index.state}</StatusPill>
          {workspace.dirty !== undefined ? <StatusPill tone={workspace.dirty ? "warning" : "ready"}>{workspace.dirty ? "Dirty" : "Clean"}</StatusPill> : null}
          {transportCheck ? <StatusPill tone={transportCheck.ready ? "ready" : "warning"}>Push auth: {transportCheck.ready ? "ready" : "needs attention"}</StatusPill> : null}
        </div>

        {indexing ? (
          <div className="overflow-hidden rounded-xl border border-primary/15 bg-primary/[0.04]">
            <div className="h-1 w-full overflow-hidden bg-muted"><div className="h-full w-1/2 animate-pulse rounded-full bg-primary/45" /></div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div>
                <p className="text-xs font-semibold text-foreground">Indexing workspace</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Updating repository intelligence from the current workspace state.</p>
              </div>
              <ActionButton variant="ghost" size="sm" onClick={onCancelIndex}><X className="size-3.5" aria-hidden="true" />Cancel</ActionButton>
            </div>
          </div>
        ) : null}

        {workspace.validation.message ? <InlineNotice tone="danger" title="Workspace validation failed" role="alert">{workspace.validation.message}</InlineNotice> : null}
        {transportCheck && !transportCheck.ready ? <InlineNotice tone="warning" title="Push authentication needs attention">{transportCheck.message}</InlineNotice> : null}

        <div className="grid gap-3 border-t border-border/70 pt-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton variant="secondary" size="sm" disabled={busy || indexing || checkingTransport} onClick={onEdit}>
              <Pencil className="size-3.5" aria-hidden="true" />Edit
            </ActionButton>
            <ActionButton variant="secondary" size="sm" disabled={busy || indexing || checkingTransport || !valid} onClick={onCheckTransport}>
              <ShieldCheck className="size-3.5" aria-hidden="true" />{checkingTransport ? "Checking…" : "Check push auth"}
            </ActionButton>
            {!indexing ? (
              <ActionButton size="sm" disabled={busy || checkingTransport || !valid} onClick={onIndex}>
                <DatabaseZap className="size-3.5" aria-hidden="true" />{workspace.index.state === "current" ? "Reindex" : "Index workspace"}
              </ActionButton>
            ) : (
              <ActionButton size="sm" disabled><RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />Indexing…</ActionButton>
            )}
          </div>

          {confirmingRemove ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/20 bg-danger/[0.055] px-3 py-2">
              <span className="max-w-sm text-[11px] leading-5 text-danger">Remove SourceNerve registration only. Repository files stay untouched.</span>
              <ActionButton variant="destructive" size="sm" disabled={busy} onClick={onRemove}><Trash2 className="size-3.5" aria-hidden="true" />Confirm remove</ActionButton>
              <ActionButton variant="ghost" size="sm" disabled={busy} onClick={onCancelRemove}>Cancel</ActionButton>
            </div>
          ) : (
            <ActionButton variant="ghost" size="sm" disabled={busy || indexing || checkingTransport} onClick={onRemove} className="justify-self-start text-danger hover:text-danger lg:justify-self-end">
              <Trash2 className="size-3.5" aria-hidden="true" />Remove
            </ActionButton>
          )}
        </div>
      </div>
    </SurfaceCard>
  );
}
