import type { IntelligenceContextPack } from "../../../shared/intelligence-api";
import { shortTaskSha } from "../../task-workflow-view-model";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskContextSnapshotCard({ pack }: { pack: IntelligenceContextPack }) {
  return (
    <SurfaceCard title="Task context snapshot" eyebrow={`Graph v${pack.graphVersion} · ${pack.consistency}`} actions={<StatusPill tone={pack.clean ? "ready" : "warning"}>{pack.clean ? "Clean snapshot" : "Dirty snapshot"}</StatusPill>}>
      <div className="space-y-4">
        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="HEAD" value={shortTaskSha(pack.head)} mono />
          <Fact label="Used bytes" value={String(pack.usedBytes)} />
          <Fact label="Items" value={String(pack.items.length)} />
          <Fact label="Clean" value={String(pack.clean)} />
        </dl>
        <div className="grid gap-2 md:grid-cols-2">
          {pack.items.map((item) => (
            <article key={`${item.path}:${item.startLine}`} className="rounded-xl border border-border bg-muted/20 p-3">
              <strong className="break-all font-mono text-[11px] text-foreground">{item.path}:{item.startLine}-{item.endLine}</strong>
              <span className="mt-1 block text-[10px] text-muted-foreground">score {item.score}</span>
              <ul className="mt-2 space-y-1 text-[10px] leading-4 text-muted-foreground">
                {item.reasons.slice(0, 6).map((reason, index) => <li key={`${reason.signal}-${index}`}><strong className="text-foreground">{reason.signal}</strong>: {reason.detail}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </SurfaceCard>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="bg-card px-3 py-3"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt><dd className={`mt-1 break-all text-xs text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd></div>;
}
