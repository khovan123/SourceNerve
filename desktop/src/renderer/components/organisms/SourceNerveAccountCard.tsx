import { LogIn, LogOut, RefreshCw, UserRound } from "lucide-react";

import type { Auth0SessionView } from "../../../shared/desktop-api";
import { authLabel, authTone, formatSessionExpiry } from "../../connection-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
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
      eyebrow="Auth0"
      actions={<StatusPill dot tone={authTone(auth.status)}>{authLabel(auth)}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/35 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
            <UserRound className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Authorization Code + PKCE</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">System browser sign-in. Access and refresh tokens never enter renderer state.</p>
          </div>
        </div>

        {authenticated && auth.identity ? (
          <>
            <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
              <Fact label="Account" value={auth.identity.name ?? auth.identity.email ?? "SourceNerve user"} />
              <Fact label="Email" value={auth.identity.email ?? "—"} />
              <Fact label="Subject" value={auth.identity.subject} mono />
              <Fact label="Session" value={auth.expiresAt ? formatSessionExpiry(auth.expiresAt) : "—"} />
            </dl>

            <div className="rounded-xl border border-border bg-muted/25 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Effective local workspace grants</p>
              {auth.workspaceGrants?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {auth.workspaceGrants.map((grant) => (
                    <StatusPill key={grant.workspace} tone="neutral">{grant.workspace} · {grant.access}</StatusPill>
                  ))}
                </div>
              ) : <p className="mt-2 text-xs leading-5 text-muted-foreground">No validated local workspace is granted to this account yet.</p>}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
              <ActionButton variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => onAction("refresh")}>
                <RefreshCw className={`size-3.5 ${busy === "auth:refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === "auth:refresh" ? "Refreshing…" : "Refresh session"}
              </ActionButton>
              <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => onAction("logout")}>
                <LogOut className="size-3.5" aria-hidden="true" />
                {busy === "auth:logout" ? "Signing out…" : "Sign out"}
              </ActionButton>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted-foreground">
              Sign in with the SourceNerve account issued by the operator. No access token, refresh token, tenant secret, or Management API credential is entered here.
            </p>
            {auth.error ? <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger" role="alert">{auth.error}</p> : null}
            <ActionButton disabled={Boolean(busy) || auth.status === "signing-in"} onClick={() => onAction("signin")}>
              <LogIn className="size-4" aria-hidden="true" />
              {busy === "auth:signin" || auth.status === "signing-in" ? "Waiting for browser sign-in…" : "Sign in to SourceNerve"}
            </ActionButton>
          </>
        )}
      </div>
    </SurfaceCard>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words text-xs text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
