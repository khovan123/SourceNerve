import { Layers3 } from "lucide-react";

import type {
  IntelligenceArchitectureCluster,
  IntelligenceContextPack,
  IntelligenceSymbolView,
} from "../../../shared/intelligence-api";
import { clipIntelligenceText } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
import { CodeSurface } from "../molecules/CodeSurface";
import { EmptyState } from "../molecules/EmptyState";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10";

export function IntelligenceContextTab({
  query,
  maxBytes,
  maxItems,
  requireClean,
  providerSemantic,
  semanticAvailable,
  selectedSymbol,
  selectedCluster,
  pack,
  busy,
  onQuery,
  onMaxBytes,
  onMaxItems,
  onRequireClean,
  onProviderSemantic,
  onBuild,
  onPreview,
}: {
  query: string;
  maxBytes: number;
  maxItems: number;
  requireClean: boolean;
  providerSemantic: boolean;
  semanticAvailable: boolean;
  selectedSymbol: IntelligenceSymbolView | null;
  selectedCluster: IntelligenceArchitectureCluster | null;
  pack: IntelligenceContextPack | null;
  busy: boolean;
  onQuery(value: string): void;
  onMaxBytes(value: number): void;
  onMaxItems(value: number): void;
  onRequireClean(value: boolean): void;
  onProviderSemantic(value: boolean): void;
  onBuild(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <SurfaceCard title="Context pack" eyebrow="Explainable, budgeted context selection" description="Build a bounded context set with visible ranking reasons, exact ranges and explicit consistency constraints.">
      <div className="space-y-5">
        <div className="grid gap-3 rounded-xl border border-border bg-muted/15 p-3 lg:grid-cols-[minmax(0,1fr)_8rem_7rem_auto] lg:items-end">
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Context question</span><input className={controlClass} value={query} maxLength={4096} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim() && !busy) onBuild(); }} placeholder="How does OAuth callback handling reach workspace grants?" /></label>
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Budget</span><select className={controlClass} value={maxBytes} onChange={(event) => onMaxBytes(Number(event.target.value))}><option value={16 * 1024}>16 KiB</option><option value={32 * 1024}>32 KiB</option><option value={64 * 1024}>64 KiB</option><option value={128 * 1024}>128 KiB</option></select></label>
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Items</span><select className={controlClass} value={maxItems} onChange={(event) => onMaxItems(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option></select></label>
          <ActionButton disabled={busy || !query.trim()} onClick={onBuild}><Layers3 className="size-4" aria-hidden="true" />{busy ? "Building…" : "Build context pack"}</ActionButton>
        </div>

        <div className="grid gap-3 rounded-xl border border-border bg-muted/20 p-3 md:grid-cols-2">
          <ToggleRow title="Require clean/current index" description="Fail closed if the context cannot be built against a clean current graph." checked={requireClean} onChange={onRequireClean} />
          <ToggleRow title="Provider semantic ranking" description={semanticAvailable ? "Use the configured semantic provider as an additional ranking signal." : "No semantic provider is configured."} checked={providerSemantic && semanticAvailable} disabled={!semanticAvailable} onChange={onProviderSemantic} />
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusPill tone={selectedSymbol ? "working" : "neutral"}>{selectedSymbol ? `Seed symbol: ${selectedSymbol.qualifiedName}` : "No symbol seed"}</StatusPill>
          <StatusPill tone={selectedCluster ? "working" : "neutral"}>{selectedCluster ? `Seed cluster: ${selectedCluster.displayName}` : "No cluster seed"}</StatusPill>
        </div>

        {pack ? (
          <div className="space-y-4">
            <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Used bytes" value={pack.usedBytes} /><Metric label="Max bytes" value={pack.maxBytes} /><Metric label="Items" value={pack.items.length} /><Metric label="Graph version" value={pack.graphVersion} />
            </dl>
            <div className="flex flex-wrap gap-2"><StatusPill tone={pack.clean ? "ready" : "warning"}>Clean: {String(pack.clean)}</StatusPill><StatusPill tone="neutral">{pack.consistency}</StatusPill>{pack.truncated ? <StatusPill tone="warning">Truncated by budget</StatusPill> : null}</div>
            <div className="grid gap-3 xl:grid-cols-2">
              {pack.items.map((item, index) => (
                <article className="min-w-0 rounded-xl border border-border bg-card/65 p-3" key={`${item.path}-${item.startLine}-${index}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2"><strong className="min-w-0 break-all font-mono text-[11px] leading-5 text-foreground">{item.path}:{item.startLine}-{item.endLine}</strong><span className="shrink-0 text-[10px] text-muted-foreground">score {item.score}</span></div>
                  <CodeSurface title={item.path} meta={`L${item.startLine}–${item.endLine}`} maxHeightClass="max-h-64" className="mt-2">{clipIntelligenceText(item.content, 5000)}</CodeSurface>
                  <ul className="mt-2 max-h-28 space-y-1 overflow-auto overscroll-contain text-[10px] leading-4 text-muted-foreground" tabIndex={0}>{item.reasons.map((reason, reasonIndex) => <li key={`${reason.signal}-${reasonIndex}`}><strong className="text-foreground">{reason.signal}</strong> +{reason.score}: {reason.detail}</li>)}</ul>
                  <ActionButton variant="ghost" size="sm" className="mt-2" onClick={() => onPreview(item.path, item.startLine, item.endLine)}>Open exact range</ActionButton>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState icon={Layers3} title="No context pack built yet" description="Ask a repository question and build a bounded context pack to inspect ranked source ranges and reasons." compact />
        )}
      </div>
    </SurfaceCard>
  );
}

function ToggleRow({ title, description, checked, disabled = false, onChange }: { title: string; description: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return <div className="flex items-center justify-between gap-4"><div><p className="text-xs font-medium text-foreground">{title}</p><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</p></div><ToggleSwitch label={title} checked={checked} disabled={disabled} onChange={onChange} /></div>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="bg-card px-3 py-3"><dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt><dd className="mt-1 text-sm font-semibold text-foreground">{value.toLocaleString()}</dd></div>;
}
