import type { ReactNode } from "react";
import { FileSearch2, Search } from "lucide-react";

import type { IntelligenceCodeSearchResult, IntelligenceMemorySearchResult } from "../../../shared/intelligence-api";
import { formatIntelligenceScore } from "../../intelligence-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function IntelligenceSearchTab({
  query,
  limit,
  memory,
  code,
  busy,
  onQuery,
  onLimit,
  onRun,
  onPreview,
}: {
  query: string;
  limit: number;
  memory: IntelligenceMemorySearchResult | null;
  code: IntelligenceCodeSearchResult | null;
  busy: boolean;
  onQuery(value: string): void;
  onLimit(value: number): void;
  onRun(): void;
  onPreview(path: string, start: number, end: number): void;
}) {
  return (
    <SurfaceCard title="Search" eyebrow="FTS memory + bounded raw code search">
      <div className="space-y-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_8rem_auto] lg:items-end">
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Query</span><input className="h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={query} maxLength={4096} onChange={(event) => onQuery(event.target.value)} placeholder="Search repository intelligence" /></label>
          <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">Limit</span><select className="h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={limit} onChange={(event) => onLimit(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select></label>
          <ActionButton disabled={busy || !query.trim()} onClick={onRun}><Search className="size-4" aria-hidden="true" />{busy ? "Searching…" : "Search"}</ActionButton>
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <ResultSection title="Indexed memory / FTS" count={memory?.hits.length}>
            {memory?.hits.map((hit, index) => (
              <ResultCard key={`${hit.path}-${index}`} title={hit.path} meta={`score ${formatIntelligenceScore(hit.score)}`}>
                <p className="text-[11px] leading-5 text-muted-foreground">{hit.snippet}</p>
                <ActionButton variant="ghost" size="sm" onClick={() => onPreview(hit.path, 1, 200)}><FileSearch2 className="size-3.5" aria-hidden="true" />Preview file</ActionButton>
              </ResultCard>
            ))}
          </ResultSection>
          <ResultSection title="Raw code search" count={code?.hits.length} suffix={code?.truncated ? " · truncated" : ""}>
            {code?.hits.map((hit, index) => (
              <ResultCard key={`${hit.path}-${hit.line}-${index}`} title={`${hit.path}:${hit.line}`}>
                <pre className="overflow-auto rounded-lg border border-border bg-[#11100e] p-3 font-mono text-[10px] leading-4 text-[#e9dfd2] dark:bg-black/40">{hit.text}</pre>
                <ActionButton variant="ghost" size="sm" onClick={() => onPreview(hit.path, Math.max(1, hit.line - 20), hit.line + 40)}><FileSearch2 className="size-3.5" aria-hidden="true" />Preview around match</ActionButton>
              </ResultCard>
            ))}
          </ResultSection>
        </div>
      </div>
    </SurfaceCard>
  );
}

function ResultSection({ title, count, suffix = "", children }: { title: string; count?: number; suffix?: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-xs font-semibold text-foreground">{title}</h3><StatusPill tone="neutral">{count === undefined ? "Not run" : `${count} result${count === 1 ? "" : "s"}${suffix}`}</StatusPill></div>
      <div className="max-h-[36rem] space-y-2 overflow-auto pr-1">{children}{count === 0 ? <p className="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">No results.</p> : null}</div>
    </section>
  );
}

function ResultCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return <article className="space-y-2 rounded-xl border border-border bg-muted/20 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all font-mono text-[11px] text-foreground">{title}</strong>{meta ? <span className="text-[10px] text-muted-foreground">{meta}</span> : null}</div>{children}</article>;
}
