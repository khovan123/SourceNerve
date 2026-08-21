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
  const needsAttention = publicMcp.state === "degraded" || publicMcp.state === "offline" || publicMcp.state === "revoked";

  return (
    <SurfaceCard
      title="Public MCP"
      description="Remote MCP endpoint for this Desktop installation."
      actions={<StatusPill dot tone={publicMcpTone(publicMcp)}>{publicMcpLabel(publicMcp)}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-background/45 p-3.5">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            <Cable className="size-3.5" aria-hidden="true" />
            MCP Server URL
          </div>
          <p className="mt-2 select-all break-all font-mono text-[12px] leading-5 text-foreground" title={publicUrl}>{publicUrl}</p>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">Use this URL when connecting ChatGPT Plugin or another remote MCP client.</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusPill tone={publicMcp.tunnelRunning ? "ready" : "neutral"} dot>{publicMcp.tunnelRunning ? "Tunnel running" : "Tunnel stopped"}</StatusPill>
          {!authReady ? <StatusPill tone="warning">Sign in required</StatusPill> : null}
        </div>

        {needsAttention ? (
          <InlineNotice tone={publicMcp.state === "offline" ? "danger" : "warning"} title={publicMcpLabel(publicMcp)} role="alert">
            {publicMcp.message ?? "Public MCP needs attention."}
          </InlineNotice>
        ) : publicMcp.message ? (
          <p className="text-xs leading-5 text-muted-foreground" role="status">{publicMcp.message}</p>
        ) : null}

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
                {busy === "public-mcp:retry" ? "Checking…" : "Check connection"}
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
