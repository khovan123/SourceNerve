import { Network, Search, Waypoints } from "lucide-react";

import type {
  IntelligenceGraphStatus,
  IntelligenceSymbolContext,
  IntelligenceSymbolSearchResult,
  IntelligenceSymbolView,
  IntelligenceTraceKind,
  IntelligenceTraceResult,
} from "../../../shared/intelligence-api";
import { formatIntelligenceScore } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10";

export function IntelligenceGraphTab({
  graphStatus,
  query,
  kind,
  search,
  selectedSymbol,
  context,
  traceKind,
  traceDepth,
  trace,
  busy,
  onQuery,
  onKind,
  onSearch,
  onSelectSymbol,
  onTraceKind,
  onTraceDepth,
  onTrace,
  onPreview,
}: {
  graphStatus: IntelligenceGraphStatus | null;
  query: string;
  kind: string;
  search: IntelligenceSymbolSearchResult | null;
  selectedSymbol: IntelligenceSymbolView | null;
  context: IntelligenceSymbolContext | null;
  traceKind: IntelligenceTraceKind;
  traceDepth: number;
  trace: IntelligenceTraceResult | null;
  busy: string | null;
  onQuery(value: string): void;
  onKind(value: string): void;
  onSearch(): void;
  onSelectSymbol(symbol: IntelligenceSymbolView): void;
  onTraceKind(kind: IntelligenceTraceKind): void;
  onTraceDepth(depth: number): void;
  onTrace(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <div className="space-y-4">
      <SurfaceCard title="Graph health" eyebrow="Indexed parse and edge coverage" actions={graphStatus ? <StatusPill dot tone="ready">Graph v{graphStatus.graphVersion}</StatusPill> : <StatusPill tone="warning">Unavailable</StatusPill>}>
        {graphStatus ? (
          <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <Metric label="Supported files" value={graphStatus.supportedFiles} />
            <Metric label="Parsed" value={graphStatus.parsedFiles} />
            <Metric label="Partial" value={graphStatus.partialFiles} />
            <Metric label="Failed" value={graphStatus.failedFiles} />
            <Metric label="Symbols" value={graphStatus.symbols} />
            <Metric label="Edges" value={graphStatus.edges} />
            <Metric label="Unresolved refs" value={graphStatus.unresolvedReferences} />
          </dl>
        ) : <p className="text-sm text-muted-foreground">Graph status is unavailable until the workspace is indexed.</p>}
      </SurfaceCard>

      <SurfaceCard title="Symbol explorer" eyebrow="Definitions, edges and impact">
        <div className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem_auto] lg:items-end">
            <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Symbol query</span><input className={controlClass} value={query} maxLength={4096} onChange={(event) => onQuery(event.target.value)} placeholder="router, WorkspaceManager, index_workspace…" /></label>
            <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Kind (optional)</span><input className={controlClass} value={kind} maxLength={64} onChange={(event) => onKind(event.target.value)} placeholder="function" /></label>
            <ActionButton disabled={!query.trim() || busy === "symbols"} onClick={onSearch}><Search className="size-4" aria-hidden="true" />{busy === "symbols" ? "Searching…" : "Find symbols"}</ActionButton>
          </div>

          <div className="grid min-h-72 gap-4 xl:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)]">
            <div className="max-h-[38rem] space-y-2 overflow-auto pr-1">
              {search?.symbols.map((symbol) => (
                <button key={symbol.symbolKey} className={`w-full rounded-xl border px-3 py-3 text-left transition ${selectedSymbol?.symbolKey === symbol.symbolKey ? "border-primary/35 bg-primary/7 shadow-sm" : "border-border bg-muted/20 hover:bg-muted/45"}`} type="button" onClick={() => onSelectSymbol(symbol)}>
                  <strong className="block break-all text-xs text-foreground">{symbol.qualifiedName}</strong>
                  <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{symbol.kind} · {symbol.path}{symbol.startLine ? `:${symbol.startLine}` : ""}</span>
                </button>
              ))}
              {!search ? <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">Search for a symbol to inspect the graph.</p> : null}
            </div>

            <div className="min-w-0 rounded-xl border border-border bg-muted/15 p-4">
              {selectedSymbol ? (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-start gap-2"><Network className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><h3 className="break-all text-sm font-semibold text-foreground">{selectedSymbol.qualifiedName}</h3><p className="mt-1 break-all text-[11px] leading-5 text-muted-foreground">{selectedSymbol.signature ?? `${selectedSymbol.kind} · ${selectedSymbol.path}`}</p></div></div>
                    {selectedSymbol.startLine ? <ActionButton variant="ghost" size="sm" onClick={() => onPreview(selectedSymbol.path, Math.max(1, selectedSymbol.startLine! - 10), (selectedSymbol.endLine ?? selectedSymbol.startLine!) + 20)} className="mt-2">Preview symbol source</ActionButton> : null}
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <EdgeList title="Incoming" edges={context?.incoming ?? []} onSelect={onSelectSymbol} />
                    <EdgeList title="Outgoing" edges={context?.outgoing ?? []} onSelect={onSelectSymbol} />
                  </div>

                  <div className="grid gap-3 rounded-xl border border-border bg-card/60 p-3 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
                    <label className="grid gap-1.5"><span className="text-[11px] font-medium text-muted-foreground">Trace</span><select className={controlClass} value={traceKind} onChange={(event) => onTraceKind(event.target.value as IntelligenceTraceKind)}><option value="callers">Callers</option><option value="callees">Callees</option><option value="references">References</option><option value="impact">Impact</option></select></label>
                    <label className="grid gap-1.5"><span className="text-[11px] font-medium text-muted-foreground">Depth</span><select className={controlClass} value={traceDepth} onChange={(event) => onTraceDepth(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></label>
                    <ActionButton size="sm" disabled={busy === "trace"} onClick={onTrace}><Waypoints className="size-3.5" aria-hidden="true" />{busy === "trace" ? "Tracing…" : "Run trace"}</ActionButton>
                  </div>

                  {trace ? <div className="max-h-80 space-y-2 overflow-auto">{trace.nodes.map((node, index) => <article className="rounded-xl border border-border bg-card/70 p-3" key={`${node.symbol.symbolKey}-${node.distance}-${index}`}><div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all text-xs text-foreground">{node.symbol.qualifiedName}</strong><span className="text-[10px] text-muted-foreground">distance {node.distance} · {node.via} · {node.source}</span></div><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{node.symbol.path}{node.symbol.startLine ? `:${node.symbol.startLine}` : ""}</p><ActionButton variant="ghost" size="sm" onClick={() => onSelectSymbol(node.symbol)} className="mt-1">Inspect symbol</ActionButton></article>)}</div> : null}
                </div>
              ) : <p className="py-12 text-center text-xs text-muted-foreground">Select a symbol to inspect incoming/outgoing edges and traces.</p>}
            </div>
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}

function EdgeList({ title, edges, onSelect }: { title: string; edges: IntelligenceSymbolContext["incoming"]; onSelect(symbol: IntelligenceSymbolView): void }) {
  return <section className="rounded-xl border border-border bg-card/60 p-3"><div className="mb-2 flex items-center justify-between"><h4 className="text-[11px] font-semibold text-foreground">{title}</h4><StatusPill tone="neutral">{edges.length}</StatusPill></div><div className="max-h-52 space-y-1 overflow-auto">{edges.slice(0, 50).map((edge, index) => <button className="w-full rounded-lg px-2 py-2 text-left hover:bg-muted" type="button" key={`${edge.symbol.symbolKey}-${edge.edgeType}-${index}`} onClick={() => onSelect(edge.symbol)}><strong className="block break-all text-[10px] text-foreground">{edge.symbol.qualifiedName}</strong><span className="mt-0.5 block text-[9px] text-muted-foreground">{edge.edgeType} · {formatIntelligenceScore(edge.confidence)} · {edge.source}</span></button>)}</div></section>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="bg-card px-3 py-3"><dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold text-foreground">{value.toLocaleString()}</dd></div>;
}
