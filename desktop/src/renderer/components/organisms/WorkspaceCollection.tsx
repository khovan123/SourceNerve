import { useEffect, useState } from "react";
import { Check, FolderOpen } from "lucide-react";

import type { GitTransportValidation, ManagedWorkspaceView } from "../../../shared/desktop-api";
import { cn } from "../../lib/cn";
import { EmptyState } from "../molecules/EmptyState";
import { WorkspaceRepositoryCard } from "./WorkspaceRepositoryCard";

export function WorkspaceCollection({
  loading,
  workspaces,
  busy,
  checkingTransportId,
  transportChecks,
  confirmRemoveId,
  onEdit,
  onCheckTransport,
  onRemove,
  onCancelRemove,
}: {
  loading: boolean;
  workspaces: ManagedWorkspaceView[];
  busy: boolean;
  checkingTransportId: string | null;
  transportChecks: Record<string, GitTransportValidation>;
  confirmRemoveId: string | null;
  onEdit(workspace: ManagedWorkspaceView): void;
  onCheckTransport(workspaceId: string): void;
  onRemove(workspaceId: string): void;
  onCancelRemove(): void;
}) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    if (workspaces.length === 0) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (selectedWorkspaceId && workspaces.some((workspace) => workspace.id === selectedWorkspaceId)) return;
    setSelectedWorkspaceId(workspaces[0].id);
  }, [selectedWorkspaceId, workspaces]);

  if (loading) {
    return (
      <div className="grid min-h-[420px] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-[12px] border border-border bg-card" aria-busy="true" aria-label="Loading managed workspaces">
        <div className="border-r border-border p-2">
          <div className="space-y-1.5">
            {[0, 1, 2].map((item) => <div key={item} className="h-10 animate-pulse rounded-lg bg-muted/55" />)}
          </div>
        </div>
        <div className="p-4">
          <div className="h-56 animate-pulse rounded-[12px] bg-muted/45" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="Choose a local Git repository to start"
        description="Desktop validates the repository, derives provider metadata, materializes the managed runtime, and starts SourceNerve without editing TOML."
        className="min-h-60"
      />
    );
  }

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];

  return (
    <div className="grid min-h-[440px] grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-[12px] border border-border bg-card">
      <aside className="min-h-0 border-r border-border bg-[var(--sn-sidebar)] p-2" aria-label="Managed workspaces">
        <div className="space-y-1">
          {workspaces.map((workspace) => {
            const active = workspace.id === selectedWorkspace.id;
            const ready = workspace.validation.state === "ready";
            return (
              <button
                key={workspace.id}
                type="button"
                onClick={() => setSelectedWorkspaceId(workspace.id)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-[var(--sn-sidebar-active)] text-foreground"
                    : "text-muted-foreground hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground",
                )}
              >
                <span className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md border text-[9px]",
                  ready ? "border-success/25 bg-success/8 text-success" : "border-warning/25 bg-warning/8 text-warning",
                )}>
                  {ready ? <Check className="size-3" aria-hidden="true" /> : "!"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{workspace.name}</span>
                  {workspace.repository && workspace.repository !== workspace.name ? (
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{workspace.repository}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="min-w-0 p-4">
        <WorkspaceRepositoryCard
          workspace={selectedWorkspace}
          busy={busy}
          checkingTransport={checkingTransportId === selectedWorkspace.id}
          transportCheck={transportChecks[selectedWorkspace.id]}
          confirmingRemove={confirmRemoveId === selectedWorkspace.id}
          onEdit={() => onEdit(selectedWorkspace)}
          onCheckTransport={() => onCheckTransport(selectedWorkspace.id)}
          onRemove={() => onRemove(selectedWorkspace.id)}
          onCancelRemove={onCancelRemove}
        />
      </div>
    </div>
  );
}
