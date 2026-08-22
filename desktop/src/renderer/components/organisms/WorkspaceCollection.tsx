import { FolderOpen } from "lucide-react";

import type { GitTransportValidation, ManagedWorkspaceView } from "../../../shared/desktop-api";
import { EmptyState } from "../molecules/EmptyState";
import { WorkspaceRepositoryCard } from "./WorkspaceRepositoryCard";

export function WorkspaceCollection({
  loading,
  workspaces,
  busy,
  indexingId,
  checkingTransportId,
  transportChecks,
  confirmRemoveId,
  onEdit,
  onIndex,
  onCheckTransport,
  onRemove,
  onCancelRemove,
}: {
  loading: boolean;
  workspaces: ManagedWorkspaceView[];
  busy: boolean;
  indexingId: string | null;
  checkingTransportId: string | null;
  transportChecks: Record<string, GitTransportValidation>;
  confirmRemoveId: string | null;
  onEdit(workspace: ManagedWorkspaceView): void;
  onIndex(workspaceId: string): void;
  onCheckTransport(workspaceId: string): void;
  onRemove(workspaceId: string): void;
  onCancelRemove(): void;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" aria-label="Loading managed workspaces">
        {[0, 1].map((item) => (
          <div key={item} className="h-56 animate-pulse rounded-2xl border border-border bg-card/60" aria-hidden="true" />
        ))}
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

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {workspaces.map((workspace) => (
        <WorkspaceRepositoryCard
          key={workspace.id}
          workspace={workspace}
          busy={busy}
          indexing={indexingId === workspace.id}
          checkingTransport={checkingTransportId === workspace.id}
          transportCheck={transportChecks[workspace.id]}
          confirmingRemove={confirmRemoveId === workspace.id}
          onEdit={() => onEdit(workspace)}
          onIndex={() => onIndex(workspace.id)}
          onCheckTransport={() => onCheckTransport(workspace.id)}
          onRemove={() => onRemove(workspace.id)}
          onCancelRemove={onCancelRemove}
        />
      ))}
    </div>
  );
}
