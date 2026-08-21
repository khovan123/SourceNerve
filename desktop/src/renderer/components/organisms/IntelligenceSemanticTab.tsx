import { BrainCircuit, Search } from "lucide-react";

import type { IntelligenceSemanticSearchResult, IntelligenceSemanticStatus } from "../../../shared/intelligence-api";
import { formatIntelligenceScore } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { EmptyState } from "../molecules/EmptyState";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10";

export function IntelligenceSemanticTab({
  status,
  query,
  providerId,
  search,
  busy,
  onQuery,
  onProvider,
  onSearch,
  onPreview,
}: {
  status: IntelligenceSemanticStatus | null;
  query: string;
  providerId: string;
  search: IntelligenceSemanticSearchResult | null;
  busy: boolean;
  onQuery(value: string): void;
  onProvider(value: string): void;
  onSearch(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  const providers = status?.registry.providers ?? [];
  const configured = status?.registry.configured === true;
  return (
    <SurfaceCard title="Semantic intelligence" eyebrow="Configured provider + ANN status" description="Use configured embeddings as an additional repository retrieval surface while keeping exact paths/ranges visible.">
      <div className="space-y-5">
        {status ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill dot tone={configured ? "ready" : "neutral"}>{configured ? "Provider configured" : "Provider not configured"}</StatusPill>
            <StatusPill tone={status.ann.snapshotCurrent ? "ready" : "warning"}>ANN: {status.ann.mode}</StatusPill>
            <StatusPill tone="neutral">{status.ann.eligibleChunks} chunks · {status.ann.algorithm}</StatusPill>
          </div>
        ) : <InlineNotice tone="warning" title="Semantic status unavailable">Refresh repository intelligence after the workspace and daemon are ready.</InlineNotice>}

        {!configured ? <InlineNotice tone="neutral" title="Semantic provider is optional">Search, graph, architecture and context remain available without a semantic provider.</InlineNotice> : null}

        <div className="grid gap-3 rounded-xl border border-border bg-muted/15 p-3 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-end">
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Semantic query</span><input className={controlClass} value={query} maxLength={4096} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim() && configured && !busy) onSearch(); }} placeholder="Find code related to workspace grant reconciliation" /></label>
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Provider</span><select className={controlClass} value={providerId} disabled={!configured} onChange={(event) => onProvider(event.target.value)}><option value="">Default</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.id} · {provider.model}</option>)}</select></label>
          <ActionButton disabled={busy || !query.trim() || !configured} onClick={onSearch}><Search className="size-4" aria-hidden="true" />{busy ? "Searching…" : "Semantic search"}</ActionButton>
        </div>

        {search?.run ? <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/25 p-3"><div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><BrainCircuit className="size-3.5" aria-hidden="true" /></div><p className="min-w-0 break-words text-[11px] leading-5 text-muted-foreground">Run <code className="select-all break-all text-foreground">{search.run.id}</code> · {search.run.provider}/{search.run.model} · graph v{search.run.graphVersion}</p></div> : null}

        {search ? (
          <div className="grid gap-2 xl:grid-cols-2">
            {search.hits.map((hit, index) => (
              <article className="rounded-xl border border-border bg-card/65 p-3 transition hover:border-primary/15" key={`${hit.path}-${hit.startLine}-${index}`}>
                <div className="flex flex-wrap items-start justify-between gap-2"><strong className="min-w-0 break-all font-mono text-[11px] leading-5 text-foreground">{hit.path}:{hit.startLine}-{hit.endLine}</strong><span className="shrink-0 text-[10px] text-muted-foreground">score {formatIntelligenceScore(hit.score)}</span></div>
                <p className="mt-1 text-[10px] text-muted-foreground">{hit.provider}/{hit.model}</p>
                <ActionButton variant="ghost" size="sm" className="mt-2" onClick={() => onPreview(hit.path, hit.startLine, hit.endLine)}>Open detail</ActionButton>
              </article>
            ))}
            {search.hits.length === 0 ? <div className="xl:col-span-2"><EmptyState icon={Search} title="No semantic hits" description="Try a broader query or verify the embedding snapshot is current." compact /></div> : null}
          </div>
        ) : <EmptyState icon={BrainCircuit} title="No semantic search yet" description="Choose a configured provider and run a query to inspect exact repository ranges." compact />}
      </div>
    </SurfaceCard>
  );
}
