import { RefreshCw, ScanSearch, ShieldCheck } from "lucide-react";

import type { PluginVerificationRunResult, PluginVerificationView } from "../../../shared/plugin-verification-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function PluginVerificationStatus({
  view,
  run,
  busy,
  onVerify,
  onRefresh,
}: {
  view: PluginVerificationView | null;
  run: PluginVerificationRunResult | null;
  busy: string | null;
  onVerify(): void;
  onRefresh(): void;
}) {
  const account = view?.account;
  const ready = view?.status === "ready-to-connect";

  return (
    <SurfaceCard
      title="ChatGPT connection"
      eyebrow="Same SourceNerve Auth0 account"
      actions={<StatusPill dot tone={ready ? "ready" : "warning"}>{ready ? "Ready to connect" : "Needs attention"}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/5 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/15 bg-card text-primary">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-medium text-foreground">Desktop verifies SourceNerve; it does not automate ChatGPT.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">OAuth issuer/resource/scopes, legal URLs and plugin metadata come from the packaged product profile. The MCP Server URL comes from this installation&apos;s managed Public MCP enrollment.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusPill tone={account?.status === "authenticated" ? "ready" : "warning"}>Account: {account?.status ?? "unavailable"}</StatusPill>
          <StatusPill tone={view?.publicMcp.state === "ready" ? "ready" : "warning"}>Public MCP: {view?.publicMcp.state ?? "unavailable"}</StatusPill>
          {run?.toolCount !== undefined ? <StatusPill tone="neutral">Tools: {run.toolCount}</StatusPill> : null}
          {run?.serverName ? <StatusPill tone="neutral">{run.serverName}{run.serverVersion ? ` ${run.serverVersion}` : ""}</StatusPill> : null}
        </div>

        {account?.identity ? (
          <div className="rounded-xl border border-border bg-muted/25 p-3">
            <p className="text-xs font-semibold text-foreground">{account.identity.email ?? account.identity.name ?? account.identity.subject}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{account.workspaceGrants.length} effective workspace grant(s)</p>
            {account.workspaceGrants.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {account.workspaceGrants.map((grant) => <StatusPill key={`${grant.workspace}:${grant.access}`} tone="neutral">{grant.workspace} · {grant.access}</StatusPill>)}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <ActionButton size="sm" disabled={busy === "verify"} onClick={onVerify}>
            <ScanSearch className="size-3.5" aria-hidden="true" />
            {busy === "verify" ? "Verifying…" : "Verify SourceNerve connection"}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={busy === "state"} onClick={onRefresh}>
            <RefreshCw className={`size-3.5 ${busy === "state" ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh state
          </ActionButton>
        </div>

        {view ? (
          <div className="grid gap-2 md:grid-cols-2">
            {view.checks.map((item) => (
              <article key={item.id} className="rounded-xl border border-border bg-muted/20 p-3">
                <div className="flex items-start justify-between gap-3">
                  <strong className="text-xs text-foreground">{item.label}</strong>
                  <StatusPill tone={item.state === "ready" ? "ready" : item.state === "not-checked" ? "neutral" : "warning"}>{item.state}</StatusPill>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{item.message}</p>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}
