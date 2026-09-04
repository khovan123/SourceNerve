import {
  Activity,
  Blocks,
  Boxes,
  GitPullRequest,
  LayoutDashboard,
  ListTodo,
  PlugZap,
  Puzzle,
  ScrollText,
  Settings2,
  type LucideIcon,
} from "lucide-react";

import appIconUrl from "../../../../assets/generated/icon.png";
import { NAVIGATION, routeHash, type RouteId } from "../../navigation";
import { cn } from "../../lib/cn";

const ICONS: Record<RouteId, LucideIcon> = {
  overview: LayoutDashboard,
  workspaces: Boxes,
  mcp: Blocks,
  plugins: Puzzle,
  harness: Activity,
  tasks: ListTodo,
  "pull-requests": GitPullRequest,
  connections: PlugZap,
  diagnostics: ScrollText,
  settings: Settings2,
};

const SIDEBAR_LABELS: Partial<Record<RouteId, string>> = {
  tasks: "Tasks",
  diagnostics: "Diagnostics",
};

export function AppSidebar({ route }: { route: RouteId }) {
  return (
    <aside
      className="relative z-10 flex min-h-0 flex-col overflow-hidden border-r border-border/70 bg-card/70 px-2.5 py-3.5 backdrop-blur-2xl xl:px-3 xl:py-4"
      aria-label="Primary navigation"
    >
      <div className="mb-4 flex shrink-0 items-center justify-center gap-3 px-1 py-1 xl:mb-5 xl:justify-start xl:px-2">
        <img
          src={appIconUrl}
          alt=""
          className="size-10 shrink-0 rounded-2xl shadow-[0_10px_24px_rgba(35,29,22,0.12)]"
          aria-hidden="true"
        />
        <div className="hidden min-w-0 xl:block">
          <strong className="block truncate text-sm font-semibold tracking-[-0.02em] text-foreground">
            SourceNerve
          </strong>
          <span className="block truncate text-[11px] text-muted-foreground">
            AI repository workspace
          </span>
        </div>
      </div>

      <nav
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden"
        aria-label="SourceNerve sections"
      >
        {NAVIGATION.map((item) => {
          const Icon = ICONS[item.id];
          const active = route === item.id;
          const sidebarLabel = SIDEBAR_LABELS[item.id] ?? item.label;
          return (
            <a
              key={item.id}
              href={routeHash(item.id)}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              className={cn(
                "group relative flex min-h-10 shrink-0 items-center justify-center gap-3 rounded-xl px-2.5 py-2 text-sm font-medium no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background xl:justify-start xl:px-3",
                active
                  ? "bg-foreground text-background shadow-[0_8px_20px_rgba(31,27,22,0.12)]"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              <Icon
                className="size-4.5 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="hidden min-w-0 truncate no-underline xl:inline">
                {sidebarLabel}
              </span>
              {active ? (
                <span
                  className="absolute right-1 h-5 w-0.5 rounded-full bg-background/65 xl:right-1.5"
                  aria-hidden="true"
                />
              ) : null}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
