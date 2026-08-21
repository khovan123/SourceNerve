import { BrainCircuit, Search } from "lucide-react";

import type { IntelligenceSemanticSearchResult, IntelligenceSemanticStatus } from "../../../shared/intelligence-api";
import { formatIntelligenceScore } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10";

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
  return (
    <SurfaceCard title="Semantic intelligence" eyebrow="Configured provider + ANN status">
      <div className="space-y-5">
        {status ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill dot tone={status.registry.configured ? "ready" : "neutral"}>{status.registry.configured ? "Provider configured" : "Provider not configured"}</StatusPill>
            <StatusPill tone={status.ann.snapshotCurrent ? "ready" : "warning"}>ANN: {status.ann.mode}</StatusPill>
            <StatusPill tone="neutral">{status.ann.eligibleChunks} chunks · {status.ann.algorithm}</StatusPill>
          </div>
        ) : <p className="text-sm text-muted-foreground">Semantic status unavailable.</p>}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-end">
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Semantic query</span><input className={controlClass} value={query} maxLength={4096} onChange={(event) => onQuery(event.target.value)} placeholder="Find code related to workspace grant reconciliation" /></label>
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Provider</span><select className={controlClass} value={providerId} disabled={!status?.registry.configured} onChange={(event) => onProvider(event.target.value)}><option value="">Default</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.id} · {provider.model}</option>)}</select></label>
          <ActionButton disabled={busy || !query.trim() || !status?.registry.configured} onClick={onSearch}><Search className="size-4" aria-hidden="true" />{busy ? "Searching…" : "Semantic search"}</ActionButton>
        </div>

        {search?.run ? <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/25 p-3"><div className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground"><BrainCircuit className="size-3.5" aria-hidden="true" /></div><p className="text-[11px] leading-5 text-muted-foreground">Run <code className="text-foreground">{search.run.id}</code> · {search.run.provider}/{search.run.model} · graph v{search.run.graphVersion}</p></div> : null}

        <div className="space-y-2">
          {search?.hits.map((hit, index) => (
            <article className="rounded-xl border border-border bg-muted/20 p-3" key={`${hit.path}-${hit.startLine}-${index}`}>
              <div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all font-mono text-[11px] text-foreground">{hit.path}:{hit.startLine}-{hit.endLine}</strong><span className="text-[10px] text-muted-foreground">score {formatIntelligenceScore(hit.score)} · {hit.provider}/{hit.model}</span></div>
              <ActionButton variant="ghost" size="sm" className="mt-2" onClick={() => onPreview(hit.path, hit.startLine, hit.endLine)}>Preview hit</ActionButton>
            </article>
          ))}
          {search && search.hits.length === 0 ? <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">No semantic hits.</p> : null}
        </div>
      </div>
    </SurfaceCard>
  );
}
