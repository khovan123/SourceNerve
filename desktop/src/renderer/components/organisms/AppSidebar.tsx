import { FolderGit2, GitPullRequest, Settings2, type LucideIcon } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import appIconUrl from "../../../../assets/generated/icon.png";
import { MAIN_NAVIGATION, routeHash, type RouteId, type SettingsSectionId } from "../../navigation";
import { cn } from "../../lib/cn";

const ICONS: Partial<Record<RouteId, LucideIcon>> = {
  "pull-requests": GitPullRequest,
};

const REVIEW_ROUTES: RouteId[] = ["pull-requests"];

export function AppSidebar({
  route,
  workspaces,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onOpenSettings,
}: {
  route: RouteId;
  workspaces: ManagedWorkspaceView[];
  selectedWorkspaceId: string | null;
  onWorkspaceSelect(workspaceId: string): void;
  onOpenSettings(section?: SettingsSectionId): void;
}) {
  return (
    <aside
      className="relative z-20 flex min-h-0 flex-col border-r border-border bg-[var(--sn-sidebar)] px-3 py-3"
      aria-label="Primary navigation"
    >
      <div className="mb-5 flex shrink-0 items-center gap-2.5 px-2 py-1">
        <img src={appIconUrl} alt="" className="size-8 shrink-0 rounded-lg" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">SourceNerve</strong>
          <span className="block truncate text-[11px] text-muted-foreground">Coding workspace</span>
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-3" aria-label="SourceNerve sections">
        <section aria-label="Managed workspaces">
          <p className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Workspaces</p>
          <div className="space-y-0.5">
            {workspaces.length === 0 ? (
              <p className="px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">Use <code>/workspace add</code> in Harness.</p>
            ) : workspaces.map((workspace) => {
              const ready = workspace.validation.state === "ready" && workspace.access === "read-write" && workspace.localWritable;
              const selected = workspace.id === selectedWorkspaceId;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => onWorkspaceSelect(workspace.id)}
                  disabled={!ready}
                  aria-pressed={selected}
                  title={ready ? workspace.repository ?? workspace.name : workspace.validation.message ?? "Workspace is not ready"}
                  className={cn(
                    "relative flex min-h-9 w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                    selected
                      ? "bg-[var(--sn-sidebar-active)] font-semibold text-primary shadow-[inset_0_0_0_1px_var(--border)]"
                      : "font-medium text-muted-foreground hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
                      selected ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <FolderGit2 className={cn("size-3.5 shrink-0", selected ? "text-primary" : "")} strokeWidth={1.8} aria-hidden="true" />
                  <span className={cn("min-w-0 flex-1 truncate", selected ? "text-primary" : "")}>{workspace.name}</span>
                </button>
              );
            })}
          </div>
        </section>

        <NavigationGroup label="Review" routes={REVIEW_ROUTES} route={route} />
      </nav>

      <div className="shrink-0 pt-2.5">
        <button
          type="button"
          onClick={() => onOpenSettings("general")}
          className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground"
        >
          <Settings2 className="size-4 shrink-0" aria-hidden="true" />
          Settings
        </button>
      </div>
    </aside>
  );
}

function NavigationGroup({ label, routes, route }: { label: string; routes: RouteId[]; route: RouteId }) {
  return (
    <section>
      <p className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{label}</p>
      <div className="space-y-0.5">
        {routes.map((routeId) => {
          const item = MAIN_NAVIGATION.find((candidate) => candidate.id === routeId);
          if (!item) return null;
          const Icon = ICONS[item.id];
          if (!Icon) return null;
          const active = route === item.id;
          return (
            <a
              key={item.id}
              href={routeHash(item.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] font-medium no-underline outline-none transition-colors",
                active
                  ? "bg-[var(--sn-sidebar-active)] text-primary"
                  : "text-muted-foreground hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "")} strokeWidth={1.8} aria-hidden="true" />
              <span className={cn("min-w-0 truncate", active ? "text-primary" : "")}>{item.label}</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
