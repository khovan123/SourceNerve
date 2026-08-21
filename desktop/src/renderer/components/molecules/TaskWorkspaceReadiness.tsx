import { DatabaseZap, FolderCog, RefreshCw } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";

export function TaskWorkspaceReadiness({
  workspaces,
  busy,
  preparingWorkspaceId,
  onPrepare,
  onRefresh,
  onOpenWorkspaces,
}: {
  workspaces: ManagedWorkspaceView[];
  busy: string | null;
  preparingWorkspaceId: string | null;
  onPrepare(workspaceId: string): void;
  onRefresh(): void;
  onOpenWorkspaces(): void;
}) {
  return (
    <div className="space-y-3">
      {workspaces.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">No managed workspace is registered yet.</p>
      ) : (
        <div className="space-y-2">
          {workspaces.map((workspace) => {
            const blockers = taskWorkspaceBlockers(workspace);
            const eligible = blockers.length === 0;
            const canPrepare = canPrepareWorkspace(workspace);
            return (
              <div key={workspace.id} className="rounded-xl border border-border bg-muted/20 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-foreground">{workspace.name}</p>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{workspace.repository ?? workspace.id}</p>
                  </div>
                  <StatusPill tone={eligible ? "ready" : "warning"}>{eligible ? "Task ready" : "Blocked"}</StatusPill>
                </div>
                {blockers.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-[11px] leading-5 text-muted-foreground">
                    {blockers.map((blocker) => <li key={blocker}>• {blocker}</li>)}
                  </ul>
                ) : null}
                {canPrepare ? (
                  <div className="mt-3">
                    <ActionButton size="sm" disabled={Boolean(busy) || preparingWorkspaceId === workspace.id} onClick={() => onPrepare(workspace.id)}>
                      <DatabaseZap className="size-3.5" aria-hidden="true" />
                      {preparingWorkspaceId === workspace.id ? "Preparing…" : workspace.index.state === "not-indexed" ? "Index workspace" : "Reindex workspace"}
                    </ActionButton>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <ActionButton variant="secondary" size="sm" disabled={Boolean(busy)} onClick={onRefresh}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh readiness
        </ActionButton>
        <ActionButton variant="ghost" size="sm" onClick={onOpenWorkspaces}>
          <FolderCog className="size-3.5" aria-hidden="true" />
          Open Workspaces
        </ActionButton>
      </div>
    </div>
  );
}

export function taskWorkspaceBlockers(workspace: ManagedWorkspaceView): string[] {
  const blockers: string[] = [];
  if (workspace.validation.state !== "ready") {
    blockers.push(workspace.validation.message ?? "Workspace validation is not ready.");
    return blockers;
  }
  if (workspace.access !== "read-write") blockers.push("Read-write access is required for a new task.");
  if (workspace.dirty) blockers.push("Working tree is dirty. Commit or stash local changes, then refresh.");
  if (workspace.index.state !== "current") blockers.push(`Repository index is ${workspace.index.state}.`);
  if (workspace.branch && workspace.branch !== workspace.defaultBranch) blockers.push(`Switch from ${workspace.branch} to default branch ${workspace.defaultBranch}.`);
  return blockers;
}

function canPrepareWorkspace(workspace: ManagedWorkspaceView): boolean {
  return workspace.validation.state === "ready"
    && workspace.access === "read-write"
    && workspace.dirty === false
    && (!workspace.branch || workspace.branch === workspace.defaultBranch)
    && (workspace.index.state === "not-indexed" || workspace.index.state === "stale");
}
