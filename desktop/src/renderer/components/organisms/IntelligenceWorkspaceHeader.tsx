import { DatabaseZap } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import type { IntelligenceGraphStatus } from "../../../shared/intelligence-api";
import { INTELLIGENCE_TABS, type IntelligenceTab } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function IntelligenceWorkspaceHeader({
  workspaces,
  workspaceId,
  selectedWorkspace,
  graphStatus,
  tab,
  busy,
  error,
  onWorkspace,
  onTab,
  onReindex,
}: {
  workspaces: ManagedWorkspaceView[];
  workspaceId: string;
  selectedWorkspace: ManagedWorkspaceView | null;
  graphStatus: IntelligenceGraphStatus | null;
  tab: IntelligenceTab;
  busy: string | null;
  error: string | null;
  onWorkspace(id: string): void;
  onTab(tab: IntelligenceTab): void;
  onReindex(): void;
}) {
  return (
    <div className="space-y-3">
      <SurfaceCard
        title="Repository intelligence"
        eyebrow="Read-only analysis workspace"
        description="Search memory and code, inspect graph relationships, architecture clusters, context packs and semantic results without bypassing workspace boundaries."
        compact
        actions={(
          <ActionButton variant="secondary" size="sm" disabled={!workspaceId || busy === "index"} onClick={onReindex}>
            <DatabaseZap className={`size-3.5 ${busy === "index" ? "animate-pulse" : ""}`} aria-hidden="true" />
            {busy === "index" ? "Indexing…" : "Index / Re-index"}
          </ActionButton>
        )}
      >
        <div className="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_auto] lg:items-end">
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Workspace</span>
            <select className="h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={workspaceId} onChange={(event) => onWorkspace(event.target.value)}>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>)}
            </select>
          </label>
          <div className="flex min-w-0 flex-wrap gap-2 lg:justify-end">
            <StatusPill tone={selectedWorkspace?.access === "read-write" ? "ready" : "neutral"}>{selectedWorkspace?.access === "read-only" ? "Read-only workspace" : "Read-write workspace"}</StatusPill>
            <StatusPill tone={selectedWorkspace?.index.state === "current" ? "ready" : "warning"}>Index: {selectedWorkspace?.index.state ?? "unknown"}</StatusPill>
            <StatusPill tone={graphStatus ? "ready" : "warning"}>{graphStatus ? `Graph v${graphStatus.graphVersion}` : "Graph unavailable"}</StatusPill>
          </div>
        </div>
      </SurfaceCard>

      {error ? (
        <InlineNotice tone="danger" title="Repository intelligence needs attention" role="alert">
          {error}
        </InlineNotice>
      ) : null}

      <div className="sticky top-0 z-20 -mx-1 overflow-x-auto px-1 py-1" aria-label="Repository intelligence views">
        <div className="flex min-w-max gap-1 rounded-xl border border-border bg-card/90 p-1 shadow-sm backdrop-blur-xl" role="tablist">
          {INTELLIGENCE_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 ${tab === item.id ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
              onClick={() => onTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
