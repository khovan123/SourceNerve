import { DatabaseZap, RefreshCw } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";

export function IntelligenceWorkspaceHeader({
  workspaces,
  loading,
  busyWorkspaceId,
  error,
  onReload,
  onReindex,
}: {
  workspaces: ManagedWorkspaceView[];
  loading: boolean;
  busyWorkspaceId: string | null;
  error: string | null;
  onReload(): void;
  onReindex(workspaceId: string): void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ActionButton variant="secondary" size="sm" disabled={loading} onClick={onReload}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          {loading ? "Refreshing…" : "Refresh repositories"}
        </ActionButton>
      </div>

      {loading && workspaces.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
          Loading repositories…
        </div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
          No repositories are registered yet. Add a workspace first to make it available here.
        </div>
      ) : (
        <div className="grid gap-2">
          {workspaces.map((workspace) => {
            const busy = busyWorkspaceId === workspace.id;
            const ready = workspace.validation.state === "ready";
            const indexed = workspace.index.state === "current";
            const repositoryLabel = workspace.repository || workspace.name;

            return (
              <article
                key={workspace.id}
                className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/15 px-4 py-3 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words text-sm font-semibold text-foreground">
                      {repositoryLabel}
                    </p>
                    {workspace.provider ? (
                      <StatusPill tone="neutral">
                        {workspace.provider === "github" ? "GitHub" : "GitLab"}
                      </StatusPill>
                    ) : null}
                    <StatusPill tone={ready ? "ready" : "warning"}>
                      {ready ? "Ready" : "Needs attention"}
                    </StatusPill>
                    <StatusPill tone={indexed ? "ready" : "warning"}>
                      Index: {workspace.index.state}
                    </StatusPill>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>Workspace: {workspace.name}</span>
                    <span>Branch: {workspace.defaultBranch}</span>
                    <span>{workspace.access === "read-write" ? "Read-write" : "Read-only"}</span>
                    {workspace.index.graphVersion !== undefined ? (
                      <span>Graph v{workspace.index.graphVersion}</span>
                    ) : null}
                    {workspace.index.parsedFiles !== undefined ? (
                      <span>{workspace.index.parsedFiles} indexed files</span>
                    ) : null}
                  </div>

                  {!ready && workspace.validation.message ? (
                    <p className="mt-2 text-[11px] leading-5 text-warning">
                      {workspace.validation.message}
                    </p>
                  ) : null}
                </div>

                <ActionButton
                  variant="secondary"
                  size="sm"
                  disabled={!ready || busyWorkspaceId !== null}
                  aria-busy={busy}
                  onClick={() => onReindex(workspace.id)}
                  className="shrink-0 self-start lg:self-center"
                >
                  <DatabaseZap className={`size-3.5 ${busy ? "animate-pulse" : ""}`} aria-hidden="true" />
                  {busy ? "Indexing…" : indexed ? "Re-index" : "Index repository"}
                </ActionButton>
              </article>
            );
          })}
        </div>
      )}

      {error ? (
        <InlineNotice tone="danger" title="Repository intelligence needs attention" role="alert">
          {error}
        </InlineNotice>
      ) : null}
    </div>
  );
}
