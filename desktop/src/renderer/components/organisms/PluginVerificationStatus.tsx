import { RefreshCw, ScanSearch } from "lucide-react";

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
      description="Verify the SourceNerve account, Public MCP endpoint and plugin metadata before connecting in ChatGPT."
      actions={<StatusPill dot tone={ready ? "ready" : "warning"}>{ready ? "Ready to connect" : "Needs attention"}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={account?.status === "authenticated" ? "ready" : "warning"}>Account {account?.status ?? "unavailable"}</StatusPill>
          <StatusPill tone={view?.publicMcp.state === "ready" ? "ready" : "warning"}>Public MCP {view?.publicMcp.state ?? "unavailable"}</StatusPill>
          {run?.toolCount !== undefined ? <StatusPill tone="neutral">{run.toolCount} tools</StatusPill> : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <ActionButton size="sm" disabled={busy === "verify"} onClick={onVerify}>
            <ScanSearch className="size-3.5" aria-hidden="true" />
            {busy === "verify" ? "Verifying…" : "Verify SourceNerve connection"}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={busy === "state"} onClick={onRefresh}>
            <RefreshCw className={`size-3.5 ${busy === "state" ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
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
                {item.state !== "ready" ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{item.message}</p> : null}
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}
