import type { DesktopTaskSnapshot } from "../../../shared/task-api";
import { formatTaskTimestamp } from "../../task-workflow-view-model";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskTimelineCard({ selected }: { selected: DesktopTaskSnapshot }) {
  const events = selected.events.slice().reverse();
  return (
    <SurfaceCard title="Durable event timeline" eyebrow="Recovered from SourceNerve state" actions={<StatusPill tone="neutral">{events.length} events</StatusPill>}>
      <div className="max-h-[32rem] space-y-2 overflow-auto pr-1">
        {events.map((event) => (
          <article key={event.id} className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-xs text-foreground">{event.eventType}</strong>
              <time className="text-[10px] text-muted-foreground">{formatTaskTimestamp(event.createdAt)}</time>
            </div>
            <pre className="mt-2 max-h-52 overflow-auto rounded-lg border border-border bg-[#11100e] p-3 font-mono text-[10px] leading-4 text-[#e9dfd2] dark:bg-black/40">{JSON.stringify(event.metadata, null, 2)}</pre>
          </article>
        ))}
      </div>
    </SurfaceCard>
  );
}
