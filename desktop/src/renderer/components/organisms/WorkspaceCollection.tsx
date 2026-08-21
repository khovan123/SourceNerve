import { FolderOpen } from "lucide-react";

import type { GitTransportValidation, ManagedWorkspaceView } from "../../../shared/desktop-api";
import { SurfaceCard } from "../molecules/SurfaceCard";
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
  onCancelIndex,
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
  onCancelIndex(workspaceId: string): void;
  onRemove(workspaceId: string): void;
  onCancelRemove(): void;
}) {
  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl border border-border bg-card/60" />)}
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <SurfaceCard title="No managed workspaces" eyebrow="Repository">
        <div className="flex flex-col items-center px-5 py-8 text-center">
          <div className="grid size-12 place-items-center rounded-2xl border border-border bg-muted/60 text-muted-foreground">
            <FolderOpen className="size-5" aria-hidden="true" />
          </div>
          <strong className="mt-4 text-sm text-foreground">Choose a local Git repository to start.</strong>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            Desktop validates the repository, derives provider metadata, materializes the managed runtime, and starts SourceNerve without editing TOML.
          </p>
        </div>
      </SurfaceCard>
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
          onCancelIndex={() => onCancelIndex(workspace.id)}
          onRemove={() => onRemove(workspace.id)}
          onCancelRemove={onCancelRemove}
        />
      ))}
    </div>
  );
}
