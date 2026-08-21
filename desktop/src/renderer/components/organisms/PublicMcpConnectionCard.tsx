import { Cable, RefreshCw, RotateCcw, ShieldOff } from "lucide-react";

import type { Auth0SessionView, PublicMcpView } from "../../../shared/desktop-api";
import { publicMcpLabel, publicMcpTone } from "../../connection-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
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
      description="Installation-scoped MCP endpoint exposed through the broker-managed Cloudflare tunnel."
      actions={<StatusPill dot tone={publicMcpTone(publicMcp)}>{publicMcpLabel(publicMcp)}</StatusPill>}
    >
      <div className="space-y-4">
        <InlineNotice tone="info" title="Managed installation tunnel">
          No Cloudflare token, tunnel ID, config file, or CLI input is requested from the user. The Desktop only exposes the installation-specific endpoint needed by remote MCP clients.
        </InlineNotice>

        <div className="rounded-xl border border-border bg-background/45 p-3.5">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Cable className="size-3.5" aria-hidden="true" />
            MCP Server URL
          </div>
          <p className="mt-2 select-all break-all font-mono text-[12px] leading-5 text-foreground" title={publicUrl}>{publicUrl}</p>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Use this installation-scoped URL for ChatGPT Plugin / remote MCP setup. It is intentionally different from the canonical OAuth resource.</p>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          <Fact label="Hostname" value={publicMcp.hostname ?? "—"} mono />
          <Fact label="Tunnel" value={publicMcp.tunnelRunning ? "Running" : "Stopped"} />
          <Fact label="Last check" value={publicMcp.lastCheckedAt ? new Date(publicMcp.lastCheckedAt).toLocaleString() : "—"} />
          <Fact label="Authentication" value={authReady ? "SourceNerve account ready" : "Sign in required"} />
        </dl>

        <InlineNotice tone={noticeTone(publicMcp)} title={`Public MCP · ${publicMcpLabel(publicMcp)}`}>
          {publicMcp.message ?? publicMcp.state}
        </InlineNotice>

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

function noticeTone(view: PublicMcpView): "neutral" | "info" | "success" | "warning" | "danger" {
  if (view.state === "ready") return "success";
  if (view.state === "checking" || view.state === "enrolling") return "info";
  if (view.state === "degraded" || view.state === "revoked") return "warning";
  if (view.state === "offline") return "danger";
  return "neutral";
}
