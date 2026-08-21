import { Boxes, CheckCircle2, Copy, PlugZap } from "lucide-react";

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
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card/70 px-4 py-4 shadow-sm backdrop-blur-sm sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Operational overview</p>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">Runtime and repository signals that need attention now.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton variant="secondary" size="sm" onClick={() => { window.location.hash = routeHash("connections"); }}>
            <PlugZap className="size-3.5" aria-hidden="true" />
            Connections
          </ActionButton>
          <ActionButton variant="secondary" size="sm" onClick={() => { window.location.hash = routeHash("workspaces"); }}>
            <Boxes className="size-3.5" aria-hidden="true" />
            Workspaces
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={onCopyDiagnostics}>
            <Copy className="size-3.5" aria-hidden="true" />
            {busy === "diagnostics:copy" ? "Copying…" : "Copy diagnostics"}
          </ActionButton>
        </div>
      </div>
      {actionMessage ? (
        <div className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground" role="status">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
          <span>{actionMessage}</span>
        </div>
      ) : null}
    </div>
  );
}
