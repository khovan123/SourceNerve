import { GitBranch } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskBranchStage({
  branch,
  defaultBranch,
  busy,
  onBranch,
  onCheckout,
}: {
  branch: string;
  defaultBranch?: string;
  busy: string | null;
  onBranch(value: string): void;
  onCheckout(): void;
}) {
  return (
    <SurfaceCard title="1. Feature branch" eyebrow="Create or recover from exact task base HEAD">
      <div className="space-y-4">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Feature branch</span>
          <input className="h-10 w-full rounded-xl border border-border bg-background/70 px-3 font-mono text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={branch} maxLength={240} onChange={(event) => onBranch(event.target.value)} />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">Default branch: <strong className="text-foreground">{defaultBranch ?? "—"}</strong>. SourceNerve fails closed if current HEAD no longer matches the task snapshot.</p>
        <ActionButton size="sm" disabled={busy === "branch" || !branch.trim()} onClick={onCheckout}>
          <GitBranch className="size-3.5" aria-hidden="true" />
          {busy === "branch" ? "Preparing…" : "Create / recover feature branch"}
        </ActionButton>
      </div>
    </SurfaceCard>
  );
}
