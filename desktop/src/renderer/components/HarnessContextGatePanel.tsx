import { useState } from "react";

import type { DesktopHarnessContextRouteView } from "../../shared/harness-api";
import { ActionButton } from "./atoms/ActionButton";

export function HarnessContextGatePanel({
  workspace,
  runId,
  onRouted,
}: {
  workspace: string;
  runId: string;
  onRouted?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState<DesktopHarnessContextRouteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function routeContext(): Promise<void> {
    const value = query.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const result = await window.sourcenerveDesktop.routeHarnessContext({ workspace, runId, query: value });
    if (!result.ok) setError(result.error.message);
    else {
      setDecision(result.value);
      onRouted?.();
    }
    setBusy(false);
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold text-foreground">Context</p>
        {decision ? <span className="status-pill">{decision.route}</span> : null}
      </div>
      <div className="flex gap-2">
        <input
          className="h-9 min-w-0 flex-1 rounded-[9px] border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-primary/45"
          value={query}
          maxLength={16 * 1024}
          placeholder="Route repository context"
          onChange={(event) => { setQuery(event.target.value); setDecision(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") void routeContext(); }}
          disabled={busy}
        />
        <ActionButton variant="secondary" size="sm" onClick={() => void routeContext()} disabled={busy || !query.trim()}>
          {busy ? "Routing…" : "Route"}
        </ActionButton>
      </div>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {decision ? (
        <div className="flex flex-wrap gap-1.5">
          <span className="status-pill">{decision.retrieve ? "retrieve" : "skip"}</span>
          {decision.surfaces.map((surface) => <span key={surface} className="status-pill">{surface}</span>)}
        </div>
      ) : null}
    </section>
  );
}
