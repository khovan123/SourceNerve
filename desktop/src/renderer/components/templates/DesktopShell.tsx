import { useState, type PropsWithChildren } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import type { Auth0SessionView, ManagedWorkspaceView } from "../../../shared/desktop-api";
import type { RouteId, SettingsSectionId } from "../../navigation";
import { cn } from "../../lib/cn";
import { AppSidebar } from "../organisms/AppSidebar";

interface DesktopShellProps extends PropsWithChildren {
  route: RouteId;
  auth: Auth0SessionView;
  workspaces: ManagedWorkspaceView[];
  selectedWorkspaceId: string | null;
  onWorkspaceSelect(workspaceId: string): void;
  onOpenSettings(section?: SettingsSectionId): void;
  onLogout(): void;
}

export function DesktopShell({
  route,
  auth,
  workspaces,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onOpenSettings,
  onLogout,
  children,
}: DesktopShellProps) {
  const conversationSurface = route === "harness";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null;

  return (
    <div
      className={cn(
        "grid h-screen w-screen overflow-hidden bg-background text-foreground transition-[grid-template-columns] duration-150",
        sidebarCollapsed
          ? "grid-cols-[minmax(0,1fr)]"
          : "grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)]",
      )}
    >
      {!sidebarCollapsed ? (
        <AppSidebar
          route={route}
          auth={auth}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onWorkspaceSelect={onWorkspaceSelect}
          onOpenSettings={onOpenSettings}
          onLogout={onLogout}
        />
      ) : null}

      <main
        className={cn(
          "relative min-h-0 min-w-0",
          conversationSurface
            ? "flex flex-col overflow-hidden"
            : "overflow-auto px-5 py-5 lg:px-7 lg:py-6",
        )}
      >
        {conversationSurface ? (
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-2" aria-label="Workspace header">
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-[0_1px_4px_var(--sn-shadow)] backdrop-blur hover:bg-muted hover:text-foreground"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed
                ? <PanelLeftOpen className="size-4" aria-hidden="true" />
                : <PanelLeftClose className="size-4" aria-hidden="true" />}
            </button>
            <p className="min-w-0 truncate text-sm font-semibold leading-none text-foreground">
              {selectedWorkspace?.name ?? "Workspace required"}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            className="absolute left-2 top-2 z-40 grid size-8 place-items-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-[0_1px_4px_var(--sn-shadow)] backdrop-blur hover:bg-muted hover:text-foreground"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="size-4" aria-hidden="true" />
              : <PanelLeftClose className="size-4" aria-hidden="true" />}
          </button>
        )}

        <div className={conversationSurface ? "min-h-0 flex-1" : "mx-auto w-full max-w-[1360px] pb-3 pt-10"}>
          {children}
        </div>
      </main>
    </div>
  );
}
