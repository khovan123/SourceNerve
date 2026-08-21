import type { ReactNode } from "react";
import type { RuntimeComponent, RuntimeLogEntry, RuntimeLogLevel } from "../../../shared/desktop-api";
import type { RuntimeComponentFilter, RuntimeLogLevelFilter } from "../../overview";
import { SurfaceCard } from "../molecules/SurfaceCard";

const LOG_COMPONENTS: RuntimeComponent[] = ["desktop", "daemon", "auth", "provider", "git", "workspace", "public-mcp"];
const LOG_LEVELS: RuntimeLogLevel[] = ["debug", "info", "warn", "error"];

export function RuntimeLogPanel({
  logs,
  retainedCount,
  droppedLogs,
  levelFilter,
  componentFilter,
  query,
  onLevelFilter,
  onComponentFilter,
  onQuery,
}: {
  logs: RuntimeLogEntry[];
  retainedCount: number;
  droppedLogs: number;
  levelFilter: RuntimeLogLevelFilter;
  componentFilter: RuntimeComponentFilter;
  query: string;
  onLevelFilter(value: RuntimeLogLevelFilter): void;
  onComponentFilter(value: RuntimeComponentFilter): void;
  onQuery(value: string): void;
}) {
  return (
    <SurfaceCard title="Live runtime logs" eyebrow={`${retainedCount} retained${droppedLogs > 0 ? ` · ${droppedLogs} rotated` : ""}`}>
      <div className="mb-4 grid gap-3 md:grid-cols-[140px_180px_minmax(220px,1fr)_auto] md:items-end">
        <FilterField label="Level">
          <select className={inputClass} value={levelFilter} onChange={(event) => onLevelFilter(event.target.value as RuntimeLogLevelFilter)}>
            <option value="all">All</option>
            {LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </FilterField>
        <FilterField label="Component">
          <select className={inputClass} value={componentFilter} onChange={(event) => onComponentFilter(event.target.value as RuntimeComponentFilter)}>
            <option value="all">All</option>
            {LOG_COMPONENTS.map((component) => <option key={component} value={component}>{component}</option>)}
          </select>
        </FilterField>
        <FilterField label="Search">
          <input className={inputClass} value={query} maxLength={128} onChange={(event) => onQuery(event.target.value)} placeholder="message or component" />
        </FilterField>
        <span className="pb-2 text-[11px] text-muted-foreground">Showing {logs.length} / {retainedCount}</span>
      </div>

      <div className="max-h-[360px] overflow-auto rounded-xl border border-border bg-[#12110f] p-2 font-mono text-[11px] text-[#d8d1c5]" role="log" aria-live="polite" aria-relevant="additions text">
        {logs.length === 0 ? (
          <div className="px-4 py-8 text-center text-[#8e877c]">No matching logs. Change filters or wait for runtime activity.</div>
        ) : logs.map((entry) => <LogRow entry={entry} key={entry.sequence} />)}
      </div>
    </SurfaceCard>
  );
}

const inputClass = "h-9 w-full rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none transition focus:border-foreground/30 focus:ring-2 focus:ring-foreground/10";

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</span>{children}</label>;
}

function LogRow({ entry }: { entry: RuntimeLogEntry }) {
  const levelClass = entry.level === "error" ? "text-[#f39a8e]" : entry.level === "warn" ? "text-[#dfbd73]" : entry.level === "debug" ? "text-[#8f98a7]" : "text-[#9dc7a9]";
  return (
    <div className="grid grid-cols-[82px_92px_52px_minmax(0,1fr)] gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]">
      <time className="text-[#756f67]" dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
      <span className="truncate text-[#a7a096]">{entry.component}</span>
      <span className={levelClass}>{entry.level}</span>
      <span className="whitespace-pre-wrap break-words">{entry.message}</span>
    </div>
  );
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString();
}
