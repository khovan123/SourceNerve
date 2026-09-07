import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronUp,
  FolderGit2,
  GitPullRequest,
  LogOut,
  Settings2,
  type LucideIcon,
} from "lucide-react";

import type { Auth0SessionView, ManagedWorkspaceView } from "../../../shared/desktop-api";
import appIconUrl from "../../../../assets/generated/icon.png";
import { MAIN_NAVIGATION, routeHash, type RouteId, type SettingsSectionId } from "../../navigation";
import { cn } from "../../lib/cn";

const ICONS: Partial<Record<RouteId, LucideIcon>> = {
  "pull-requests": GitPullRequest,
};

const REVIEW_ROUTES: RouteId[] = ["pull-requests"];

export function AppSidebar({
  route,
  auth,
  workspaces,
  selectedWorkspaceId,
  onWorkspaceSelect,
  onOpenSettings,
  onLogout,
}: {
  route: RouteId;
  auth: Auth0SessionView;
  workspaces: ManagedWorkspaceView[];
  selectedWorkspaceId: string | null;
  onWorkspaceSelect(workspaceId: string): void;
  onOpenSettings(section?: SettingsSectionId): void;
  onLogout(): void;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountSelectionIndex, setAccountSelectionIndex] = useState(0);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const identityLabel = auth.identity?.name ?? auth.identity?.email ?? "SourceNerve account";
  const identitySecondary = auth.identity?.email && auth.identity.email !== identityLabel
    ? auth.identity.email
    : auth.status === "authenticated"
      ? "Connected"
      : "Not signed in";
  const initials = accountInitials(identityLabel);

  useEffect(() => {
    if (!accountOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [accountOpen]);

  const accountItemCount = auth.status === "authenticated" ? 2 : 1;

  useEffect(() => {
    if (!accountOpen) return;
    const item = accountRef.current?.querySelector<HTMLButtonElement>(`#account-menu-option-${accountSelectionIndex}`);
    item?.focus();
  }, [accountOpen]);

  function moveAccountSelection(nextIndex: number): void {
    const normalized = (nextIndex + accountItemCount) % accountItemCount;
    setAccountSelectionIndex(normalized);
    requestAnimationFrame(() => {
      accountRef.current?.querySelector<HTMLButtonElement>(`#account-menu-option-${normalized}`)?.focus();
    });
  }

  function closeAccountMenu(restoreFocus = false): void {
    setAccountOpen(false);
    if (restoreFocus) requestAnimationFrame(() => accountButtonRef.current?.focus());
  }

  function handleAccountMenuKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveAccountSelection(index + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveAccountSelection(index - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveAccountSelection(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveAccountSelection(accountItemCount - 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAccountMenu(true);
      return;
    }
    if (event.key === "Tab") setAccountOpen(false);
  }

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

      <div ref={accountRef} className="relative shrink-0 pt-2.5">
        {accountOpen ? (
          <div
            className="absolute bottom-[calc(100%+8px)] left-0 right-0 overflow-hidden rounded-[12px] border border-border bg-card p-1.5 shadow-[0_12px_36px_var(--sn-shadow)]"
            role="menu"
            aria-label="Account actions"
          >
            <div className="border-b border-border px-2.5 py-2.5">
              <p className="truncate text-xs font-semibold text-foreground">{identityLabel}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{identitySecondary}</p>
            </div>
            <button
              id="account-menu-option-0"
              type="button"
              role="menuitem"
              tabIndex={accountSelectionIndex === 0 ? 0 : -1}
              className={cn(
                "relative mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors",
                accountSelectionIndex === 0
                  ? "bg-[var(--sn-sidebar-active)] text-primary shadow-[inset_0_0_0_1px_var(--border)]"
                  : "text-foreground hover:bg-muted/60",
              )}
              onMouseEnter={() => setAccountSelectionIndex(0)}
              onFocus={() => setAccountSelectionIndex(0)}
              onKeyDown={(event) => handleAccountMenuKeyDown(event, 0)}
              onClick={() => {
                setAccountOpen(false);
                onOpenSettings("general");
              }}
            >
              {accountSelectionIndex === 0 ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
              <Settings2 className="size-3.5" aria-hidden="true" />
              Settings
            </button>
            {auth.status === "authenticated" ? (
              <>
                <div className="my-1 border-t border-border" />
                <button
                  id="account-menu-option-1"
                  type="button"
                  role="menuitem"
                  tabIndex={accountSelectionIndex === 1 ? 0 : -1}
                  className={cn(
                    "relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-danger transition-colors",
                    accountSelectionIndex === 1
                      ? "bg-[var(--sn-sidebar-active)] shadow-[inset_0_0_0_1px_var(--border)]"
                      : "hover:bg-danger/5",
                  )}
                  onMouseEnter={() => setAccountSelectionIndex(1)}
                  onFocus={() => setAccountSelectionIndex(1)}
                  onKeyDown={(event) => handleAccountMenuKeyDown(event, 1)}
                  onClick={() => {
                    setAccountOpen(false);
                    onLogout();
                  }}
                >
                  {accountSelectionIndex === 1 ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-danger" aria-hidden="true" /> : null}
                  <LogOut className="size-3.5" aria-hidden="true" />
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        <button
          ref={accountButtonRef}
          type="button"
          className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left hover:bg-[var(--sn-sidebar-hover)]"
          aria-expanded={accountOpen}
          aria-haspopup="menu"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setAccountSelectionIndex(event.key === "ArrowUp" ? accountItemCount - 1 : 0);
              setAccountOpen(true);
              return;
            }
            if (event.key === "Escape" && accountOpen) {
              event.preventDefault();
              closeAccountMenu();
            }
          }}
          onClick={() => {
            setAccountSelectionIndex(0);
            setAccountOpen((open) => !open);
          }}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background">{initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">{identityLabel}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{identitySecondary}</span>
          </span>
          <ChevronUp className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", accountOpen ? "rotate-180" : "")} aria-hidden="true" />
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

function accountInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "SN";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}
