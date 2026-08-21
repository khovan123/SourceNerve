import { LogIn, LogOut, RefreshCw, UserRound } from "lucide-react";

import type { Auth0SessionView } from "../../../shared/desktop-api";
import { authLabel, authTone, formatSessionExpiry } from "../../connection-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function SourceNerveAccountCard({
  auth,
  busy,
  onAction,
}: {
  auth: Auth0SessionView;
  busy: string | null;
  onAction(kind: "signin" | "refresh" | "logout"): void;
}) {
  const authenticated = auth.status === "authenticated" && Boolean(auth.identity);

  return (
    <SurfaceCard
      title="SourceNerve Account"
      description="Sign in with SourceNerve. Authentication stays in the trusted Desktop process."
      actions={<StatusPill dot tone={authTone(auth.status)}>{authLabel(auth)}</StatusPill>}
    >
      <div className="space-y-4">
        {authenticated && auth.identity ? (
          <>
            <div className="flex items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/35 text-muted-foreground">
                <UserRound className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{auth.identity.name ?? auth.identity.email ?? "SourceNerve user"}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{auth.identity.email ?? "Signed in"}</p>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Session</p>
                <p className="mt-1 text-xs text-foreground">{auth.expiresAt ? formatSessionExpiry(auth.expiresAt) : "Active"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <ActionButton variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => onAction("refresh")}>
                  <RefreshCw className={`size-3.5 ${busy === "auth:refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
                  {busy === "auth:refresh" ? "Refreshing…" : "Refresh"}
                </ActionButton>
                <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => onAction("logout")}>
                  <LogOut className="size-3.5" aria-hidden="true" />
                  {busy === "auth:logout" ? "Signing out…" : "Sign out"}
                </ActionButton>
              </div>
            </div>

            {auth.workspaceGrants?.length ? (
              <div className="border-t border-border/70 pt-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Workspace access</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {auth.workspaceGrants.map((grant) => (
                    <StatusPill key={grant.workspace} tone="neutral">{grant.workspace} · {grant.access}</StatusPill>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted-foreground">Sign in to use SourceNerve account features and installation services.</p>
            {auth.error ? (
              <InlineNotice tone="danger" title="Sign-in needs attention" role="alert">
                {auth.error}
              </InlineNotice>
            ) : null}
            <ActionButton disabled={Boolean(busy) || auth.status === "signing-in"} onClick={() => onAction("signin")}>
              <LogIn className="size-4" aria-hidden="true" />
              {busy === "auth:signin" || auth.status === "signing-in" ? "Waiting for browser…" : "Sign in"}
            </ActionButton>
          </>
        )}
      </div>
    </SurfaceCard>
  );
}
