import { DatabaseZap } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import type { IntelligenceGraphStatus } from "../../../shared/intelligence-api";
import { INTELLIGENCE_TABS, type IntelligenceTab } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
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
        eyebrow="Search, graph, architecture and context"
        actions={(
          <ActionButton variant="secondary" size="sm" disabled={!workspaceId || busy === "index"} onClick={onReindex}>
            <DatabaseZap className={`size-3.5 ${busy === "index" ? "animate-pulse" : ""}`} aria-hidden="true" />
            {busy === "index" ? "Indexing…" : "Index / Re-index"}
          </ActionButton>
        )}
      >
        <div className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Workspace</span>
            <select className="h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={workspaceId} onChange={(event) => onWorkspace(event.target.value)}>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.id})</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <StatusPill tone={selectedWorkspace?.access === "read-write" ? "ready" : "neutral"}>{selectedWorkspace?.access === "read-only" ? "Read-only workspace" : "Read-write workspace"}</StatusPill>
            <StatusPill tone={selectedWorkspace?.index.state === "current" ? "ready" : "warning"}>Index: {selectedWorkspace?.index.state ?? "unknown"}</StatusPill>
            <StatusPill tone={graphStatus ? "ready" : "warning"}>{graphStatus ? `Graph v${graphStatus.graphVersion}` : "Graph unavailable"}</StatusPill>
          </div>
        </div>
      </SurfaceCard>

      {error ? <div className="rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">{error}</div> : null}

      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card/65 p-1 shadow-sm" role="tablist" aria-label="Repository intelligence views">
        {INTELLIGENCE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition ${tab === item.id ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
