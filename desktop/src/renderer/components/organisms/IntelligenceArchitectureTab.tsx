import { Boxes, RefreshCw } from "lucide-react";

import type {
  IntelligenceArchitectureCluster,
  IntelligenceArchitectureClusterResult,
  IntelligenceArchitectureMapResult,
} from "../../../shared/intelligence-api";
import { shortIntelligenceHash } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { EmptyState } from "../molecules/EmptyState";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function IntelligenceArchitectureTab({
  map,
  selectedCluster,
  detail,
  busy,
  onRebuild,
  onSelect,
  onPreview,
}: {
  map: IntelligenceArchitectureMapResult | null;
  selectedCluster: IntelligenceArchitectureCluster | null;
  detail: IntelligenceArchitectureClusterResult | null;
  busy: string | null;
  onRebuild(): void;
  onSelect(cluster: IntelligenceArchitectureCluster): void;
  onPreview(path: string): void;
}) {
  const cluster = detail?.cluster ?? selectedCluster;
  return (
    <SurfaceCard
      title="Architecture map"
      eyebrow="Server-derived repository clusters"
      description="Browse bounded architectural clusters on the left and inspect representative files/dependencies in the detail pane."
      actions={(
        <ActionButton variant="secondary" size="sm" disabled={busy === "architecture-rebuild"} onClick={onRebuild}>
          <RefreshCw className={`size-3.5 ${busy === "architecture-rebuild" ? "animate-spin" : ""}`} aria-hidden="true" />
          {busy === "architecture-rebuild" ? "Building…" : "Build / Rebuild map"}
        </ActionButton>
      )}
    >
      <div className="space-y-4">
        {map?.snapshot ? (
          <div className="flex flex-wrap gap-2"><StatusPill dot tone="ready">Snapshot {shortIntelligenceHash(map.snapshot.snapshotHash)}</StatusPill><StatusPill tone="neutral">Graph v{map.snapshot.graphVersion}</StatusPill><StatusPill tone="neutral">{map.clusters.length} clusters</StatusPill></div>
        ) : <EmptyState icon={Boxes} title="No current architecture snapshot" description="Build the architecture map after indexing a clean workspace." compact />}

        <div className="grid min-h-72 gap-4 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
          <section className="min-w-0 rounded-xl border border-border bg-background/30 p-3" aria-label="Architecture clusters">
            <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-semibold text-foreground">Clusters</h3><StatusPill tone="neutral">{map?.clusters.length ?? 0}</StatusPill></div>
            <div className="max-h-[42rem] space-y-2 overflow-auto overscroll-contain pr-1" tabIndex={0}>
              {map?.clusters.map((item) => (
                <button type="button" aria-pressed={selectedCluster?.clusterKey === item.clusterKey} className={`w-full rounded-xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 ${selectedCluster?.clusterKey === item.clusterKey ? "border-primary/35 bg-primary/[0.07] shadow-sm" : "border-border bg-card/60 hover:border-primary/15 hover:bg-muted/35"}`} key={item.clusterKey} onClick={() => onSelect(item)}>
                  <strong className="block break-words text-xs text-foreground">{item.displayName}</strong>
                  <span className="mt-1 block text-[10px] text-muted-foreground">{item.fileCount} files · {item.symbolCount} symbols</span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">centrality {item.centralityScore} · {item.externalEdgeCount} external edges</span>
                </button>
              ))}
            </div>
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-muted/15 p-4" aria-label="Architecture cluster detail">
            {cluster ? (
              <div className="space-y-4">
                <div className="flex min-w-0 items-start gap-3"><div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><Boxes className="size-4" aria-hidden="true" /></div><div className="min-w-0"><h3 className="break-words text-sm font-semibold text-foreground">{cluster.displayName}</h3><p className="mt-1 select-all break-all font-mono text-[10px] leading-4 text-muted-foreground">{cluster.clusterKey}</p></div></div>
                <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Files" value={cluster.fileCount} /><Metric label="Symbols" value={cluster.symbolCount} /><Metric label="Internal edges" value={cluster.internalEdgeCount} /><Metric label="External edges" value={cluster.externalEdgeCount} />
                </dl>
                <section><h4 className="mb-2 text-[11px] font-semibold text-foreground">Representative files</h4><div className="max-h-44 overflow-auto overscroll-contain rounded-xl border border-border bg-card/50 p-2">{cluster.representativeFiles.map((path) => <button className="mb-1 mr-1 max-w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-left font-mono text-[10px] leading-4 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25" type="button" key={path} onClick={() => onPreview(path)} title={path}>{path}</button>)}</div></section>
                <div className="grid gap-3 md:grid-cols-2"><DependencyList title="Inbound" dependencies={cluster.inbound} /><DependencyList title="Outbound" dependencies={cluster.outbound} /></div>
              </div>
            ) : <EmptyState icon={Boxes} title="Select a cluster" description="Inspect representative files, metrics and inbound/outbound dependencies here." compact />}
          </section>
        </div>
      </div>
    </SurfaceCard>
  );
}

function DependencyList({ title, dependencies }: { title: string; dependencies: IntelligenceArchitectureCluster["inbound"] }) {
  return <section className="rounded-xl border border-border bg-card/60 p-3"><div className="mb-2 flex items-center justify-between"><h4 className="text-[11px] font-semibold text-foreground">{title}</h4><StatusPill tone="neutral">{dependencies.length}</StatusPill></div>{dependencies.length === 0 ? <span className="text-[10px] text-muted-foreground">None</span> : <ul className="max-h-52 space-y-1 overflow-auto overscroll-contain text-[10px] leading-4 text-muted-foreground" tabIndex={0}>{dependencies.slice(0, 32).map((dependency) => <li className="break-words" key={`${title}-${dependency.clusterKey}`}><strong className="break-all text-foreground">{dependency.clusterKey}</strong>: {dependency.edgeCount} edges ({dependency.edgeTypes.join(", ")})</li>)}</ul>}</section>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="bg-card px-3 py-3"><dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold text-foreground">{value.toLocaleString()}</dd></div>;
}
