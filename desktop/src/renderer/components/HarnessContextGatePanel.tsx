import { useState } from "react";

import type { DesktopHarnessContextRouteView } from "../../shared/harness-api";
import { Panel } from "./Panel";
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
    const result = await window.sourcenerveDesktop.routeHarnessContext({
      workspace,
      runId,
      query: value,
    });
    if (!result.ok) setError(result.error.message);
    else {
      setDecision(result.value);
      onRouted?.();
    }
    setBusy(false);
  }

  return (
    <Panel title="Context gate" eyebrow="Deterministic routing">
      <div className="space-y-3">
        <div>
          <p className="text-sm text-foreground">Preview which repository context surfaces SourceNerve would use for a request.</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">This gate does not call an LLM or execute retrieval. Harness events persist the decision and a query hash, never the raw query.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
            value={query}
            maxLength={16 * 1024}
            placeholder="e.g. find callers of begin"
            onChange={(event) => { setQuery(event.target.value); setDecision(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") void routeContext(); }}
            disabled={busy}
          />
          <ActionButton variant="secondary" onClick={() => void routeContext()} disabled={busy || !query.trim()}>
            {busy ? "Routing…" : "Route context"}
          </ActionButton>
        </div>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        {decision ? (
          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="status-pill">{decision.retrieve ? "retrieve" : "skip"}</span>
              <span className="rounded-full border border-primary/25 bg-primary/8 px-2.5 py-1 text-[10px] font-semibold text-primary">{decision.route}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{decision.reason}</p>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              <span className="font-medium text-foreground">Surfaces:</span> {decision.surfaces.length > 0 ? decision.surfaces.join(" → ") : "none"}
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
