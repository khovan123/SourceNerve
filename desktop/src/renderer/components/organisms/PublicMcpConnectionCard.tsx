import { Cable, RefreshCw, RotateCcw, ShieldOff } from "lucide-react";

import type { Auth0SessionView, PublicMcpView } from "../../../shared/desktop-api";
import { publicMcpLabel, publicMcpTone } from "../../connection-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function PublicMcpConnectionCard({
  auth,
  publicMcp,
  busy,
  onAction,
}: {
  auth: Auth0SessionView;
  publicMcp: PublicMcpView;
  busy: string | null;
  onAction(action: "enroll" | "retry" | "rotate" | "revoke" | "re-enroll"): void;
}) {
  const authReady = auth.status === "authenticated";
  const publicUrl = publicMcp.publicMcpUrl ?? (publicMcp.hostname ? `https://${publicMcp.hostname}/mcp` : "—");

  return (
    <SurfaceCard
      title="Public MCP"
      eyebrow="Cloudflare"
      actions={<StatusPill dot tone={publicMcpTone(publicMcp)}>{publicMcpLabel(publicMcp)}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/35 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
            <Cable className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Installation-scoped managed tunnel</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Provisioned by the authenticated bootstrap broker. No Cloudflare token, tunnel ID, config file, or CLI input is requested from the user.</p>
          </div>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          <Fact label="Hostname" value={publicMcp.hostname ?? "—"} mono />
          <Fact label="Tunnel" value={publicMcp.tunnelRunning ? "Running" : "Stopped"} />
          <Fact label="MCP Server URL" value={publicUrl} mono />
          <Fact label="Last check" value={publicMcp.lastCheckedAt ? new Date(publicMcp.lastCheckedAt).toLocaleString() : "—"} />
          <div className="bg-card px-3 py-3 sm:col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Status</dt>
            <dd className="mt-1 text-xs leading-5 text-foreground">{publicMcp.message ?? publicMcp.state}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
          {publicMcp.state === "not-enrolled" ? (
            <ActionButton disabled={Boolean(busy) || !authReady} onClick={() => onAction("enroll")}>
              <Cable className="size-4" aria-hidden="true" />
              {busy === "public-mcp:enroll" ? "Enrolling…" : "Enroll Public MCP"}
            </ActionButton>
          ) : publicMcp.state === "revoked" ? (
            <ActionButton disabled={Boolean(busy) || !authReady} onClick={() => onAction("re-enroll")}>
              <RefreshCw className="size-4" aria-hidden="true" />
              {busy === "public-mcp:re-enroll" ? "Re-enrolling…" : "Re-enroll"}
            </ActionButton>
          ) : (
            <>
              <ActionButton disabled={Boolean(busy) || !authReady} onClick={() => onAction("retry")}>
                <RefreshCw className={`size-4 ${busy === "public-mcp:retry" ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === "public-mcp:retry" ? "Checking…" : "Retry / Repair"}
              </ActionButton>
              <ActionButton variant="secondary" disabled={Boolean(busy) || !authReady} onClick={() => onAction("rotate")}>
                <RotateCcw className="size-4" aria-hidden="true" />
                {busy === "public-mcp:rotate" ? "Rotating…" : "Rotate credential"}
              </ActionButton>
              <ActionButton variant="ghost" disabled={Boolean(busy) || !authReady} onClick={() => onAction("revoke")} className="text-danger hover:text-danger">
                <ShieldOff className="size-4" aria-hidden="true" />
                {busy === "public-mcp:revoke" ? "Revoking…" : "Revoke"}
              </ActionButton>
            </>
          )}
        </div>
      </div>
    </SurfaceCard>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
