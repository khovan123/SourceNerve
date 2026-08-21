import { GitMerge, RefreshCw } from "lucide-react";

import type { ProviderMergeMethod, ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const selectClass = "h-10 rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10";

export function ProviderPullStateCard({
  state,
  exactHeadReady,
  mergeReady,
  mergeMethod,
  busy,
  onMergeMethod,
  onRefresh,
  onMerge,
}: {
  state: ProviderWorkflowState;
  exactHeadReady: boolean;
  mergeReady: boolean;
  mergeMethod: ProviderMergeMethod;
  busy: string | null;
  onMergeMethod(method: ProviderMergeMethod): void;
  onRefresh(): void;
  onMerge(): void;
}) {
  const pull = state.pull;
  if (!pull) return null;

  return (
    <SurfaceCard
      title={`${providerChangeLabel(state.provider)} #${pull.number}`}
      eyebrow="Fresh provider state required before merge"
      actions={(
        <ActionButton variant="secondary" size="sm" disabled={busy === "pull-refresh"} onClick={onRefresh}>
          <RefreshCw className={`size-3.5 ${busy === "pull-refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
          {busy === "pull-refresh" ? "Refreshing…" : "Refresh provider state"}
        </ActionButton>
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={pull.state === "merged" ? "ready" : pull.state === "open" ? "working" : "warning"}>{pull.state}{pull.draft ? " · draft" : ""}</StatusPill>
          <StatusPill tone={exactHeadReady ? "ready" : "warning"}>{exactHeadReady ? "Exact head verified" : "Head mismatch"}</StatusPill>
          <StatusPill tone={pull.mergeable === false ? "warning" : pull.mergeable === true ? "ready" : "neutral"}>{pull.mergeable === false ? "Merge blocked" : pull.mergeable === true ? "Provider says mergeable" : "Mergeability unknown"}</StatusPill>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Base" value={pull.baseBranch} />
          <Fact label="Head branch" value={pull.headBranch} />
          <Fact label="Provider head" value={shortProviderSha(pull.headSha)} mono />
          <Fact label="Recorded head" value={state.pullHeadSha ? shortProviderSha(state.pullHeadSha) : "—"} mono />
          <Fact label="Mergeability" value={pull.mergeable === false ? "Blocked" : pull.mergeable === true ? "Provider says mergeable" : "Provider did not report"} />
          <Fact label="Merge state" value={pull.mergeState ?? "—"} />
        </dl>

        {pull.url ? <div className="rounded-xl border border-border bg-muted/25 px-3 py-2 text-[11px] leading-5 text-muted-foreground"><span className="font-semibold text-foreground">Provider URL</span><br /><code className="break-all">{pull.url}</code></div> : null}

        {!exactHeadReady && pull.state === "open" ? (
          <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger">
            Provider head <code>{pull.headSha}</code> differs from task-recorded head <code>{state.pullHeadSha ?? "missing"}</code>. Merge is disabled. Refresh task/provider state; Desktop will not substitute or guess a SHA.
          </p>
        ) : null}
        {pull.mergeable === false ? (
          <p className="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-xs leading-5 text-warning">
            Provider reports merge blocked{pull.mergeState ? `: ${pull.mergeState}` : "."} Required checks, reviews, branch protection, or permissions remain provider-owned constraints.
          </p>
        ) : null}

        {state.lifecyclePhase === "pr_open" ? (
          <div className="flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-end sm:justify-between">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Merge method</span>
              <select className={selectClass} value={mergeMethod} onChange={(event) => onMergeMethod(event.target.value as ProviderMergeMethod)}>
                <option value="merge">Merge commit</option>
                <option value="squash">Squash</option>
                <option value="rebase">Rebase</option>
              </select>
            </label>
            <ActionButton variant="destructive" disabled={!mergeReady || busy === "merge"} onClick={onMerge}>
              <GitMerge className="size-4" aria-hidden="true" />
              {busy === "merge" ? "Merging…" : `Merge exact head ${shortProviderSha(pull.headSha)}`}
            </ActionButton>
          </div>
        ) : null}
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
