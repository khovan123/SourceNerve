import { MonitorUp } from "lucide-react";

import { SurfaceCard } from "../molecules/SurfaceCard";

const controls = [
  "Show SourceNerve",
  "Start / Stop / Restart the managed daemon",
  "Open sanitized runtime logs",
  "Quit with graceful tunnel → daemon → app shutdown",
];

export function SystemTrayCard() {
  return (
    <SurfaceCard title="System tray" eyebrow="Native controls">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/45 text-muted-foreground">
          <MonitorUp className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <ul className="grid gap-2 text-xs text-foreground">
            {controls.map((item) => <li key={item} className="rounded-lg border border-border bg-muted/20 px-3 py-2">{item}</li>)}
          </ul>
          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
            Tray controls are fixed semantic operations. They cannot run arbitrary commands, URLs, or processes.
          </p>
        </div>
      </div>
    </SurfaceCard>
  );
}
