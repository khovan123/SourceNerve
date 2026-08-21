import { ArrowRight, Copy, PlugZap, Boxes } from "lucide-react";

import { routeHash } from "../../navigation";
import { ActionButton } from "../atoms/ActionButton";

export function OverviewRecoveryBar({
  busy,
  actionMessage,
  onCopyDiagnostics,
}: {
  busy: string | null;
  actionMessage: string | null;
  onCopyDiagnostics(): void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card/70 px-5 py-4 shadow-sm backdrop-blur-sm">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            Operational overview
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Live runtime, repository readiness and the signals that need attention now.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton variant="secondary" size="sm" onClick={() => { window.location.hash = routeHash("connections"); }}>
            <PlugZap className="size-3.5" aria-hidden="true" /> Connections
          </ActionButton>
          <ActionButton variant="secondary" size="sm" onClick={() => { window.location.hash = routeHash("workspaces"); }}>
            <Boxes className="size-3.5" aria-hidden="true" /> Workspaces
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={onCopyDiagnostics}>
            <Copy className="size-3.5" aria-hidden="true" />
            {busy === "diagnostics:copy" ? "Copying…" : "Copy diagnostics"}
          </ActionButton>
        </div>
      </div>
      {actionMessage ? (
        <div className="rounded-xl border border-border bg-muted/70 px-4 py-3 text-xs text-muted-foreground" role="status">{actionMessage}</div>
      ) : null}
    </div>
  );
}
