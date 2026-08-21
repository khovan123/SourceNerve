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
    <aside className="relative z-10 flex min-h-0 flex-col border-r border-border/80 bg-card/65 px-3 py-4 backdrop-blur-xl" aria-label="Primary navigation">
      <div className="mb-5 flex items-center gap-3 px-2 py-1">
        <div className="grid size-10 place-items-center rounded-2xl border border-border bg-foreground text-background shadow-sm">
          <Sparkles className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0">
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
              title={item.description}
              className={cn(
                "group flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-foreground text-background shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </a>
          );
        })}
      </nav>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/70 px-1 pt-4">
        <StatusPill tone="working" dot>Development</StatusPill>
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Desktop</span>
      </div>
    </aside>
  );
}
