import {
  Boxes,
  BrainCircuit,
  GitPullRequest,
  LayoutDashboard,
  ListTodo,
  PlugZap,
  ScrollText,
  Settings2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { NAVIGATION, routeHash, type RouteId } from "../../navigation";
import { cn } from "../../lib/cn";
import { StatusPill } from "../atoms/StatusPill";

const ICONS: Record<RouteId, LucideIcon> = {
  overview: LayoutDashboard,
  workspaces: Boxes,
  intelligence: BrainCircuit,
  tasks: ListTodo,
  "pull-requests": GitPullRequest,
  connections: PlugZap,
  diagnostics: ScrollText,
  settings: Settings2,
};

export function AppSidebar({ route }: { route: RouteId }) {
  return (
    <aside className="relative z-10 flex min-h-0 flex-col border-r border-border/70 bg-card/70 px-2.5 py-3.5 backdrop-blur-2xl xl:px-3 xl:py-4" aria-label="Primary navigation">
      <div className="mb-4 flex items-center justify-center gap-3 px-1 py-1 xl:mb-5 xl:justify-start xl:px-2">
        <div className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-foreground text-background shadow-[0_10px_24px_rgba(35,29,22,0.12)]">
          <Sparkles className="size-4" aria-hidden="true" />
        </div>
        <div className="hidden min-w-0 xl:block">
          <strong className="block truncate text-sm font-semibold tracking-[-0.02em]">SourceNerve</strong>
          <span className="block truncate text-[11px] text-muted-foreground">AI repository workspace</span>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-auto" aria-label="SourceNerve sections">
        {NAVIGATION.map((item) => {
          const Icon = ICONS[item.id];
          const active = route === item.id;
          return (
            <a
              key={item.id}
              href={routeHash(item.id)}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={`${item.label} — ${item.description}`}
              className={cn(
                "group relative flex min-h-11 items-center justify-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium outline-none transition-all focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background xl:justify-start xl:px-3",
                active
                  ? "bg-foreground text-background shadow-[0_8px_20px_rgba(31,27,22,0.12)]"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span className="hidden truncate xl:inline">{item.label}</span>
              {active ? <span className="absolute -right-[11px] h-6 w-0.5 rounded-full bg-primary xl:-right-[13px]" aria-hidden="true" /> : null}
            </a>
          );
        })}
      </nav>

      <div className="mt-4 flex items-center justify-center border-t border-border/70 px-1 pt-4 xl:justify-between xl:gap-2">
        <div className="hidden xl:block"><StatusPill tone="working" dot>Development</StatusPill></div>
        <div className="grid size-8 place-items-center rounded-xl border border-border bg-muted/45 xl:hidden" title="Development Desktop" aria-label="Development Desktop">
          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        </div>
        <span className="hidden text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground xl:inline">Desktop</span>
      </div>
    </aside>
  );
}
