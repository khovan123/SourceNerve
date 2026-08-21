import { GitMerge, RefreshCw } from "lucide-react";

import type { ProviderMergeMethod, ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
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
      description="Merge is enabled only when provider state is fresh, the provider head exactly matches the task-recorded head, and provider mergeability is not blocked."
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

        <div className={`rounded-xl border p-3 ${exactHeadReady ? "border-success/20 bg-success/[0.055]" : "border-danger/25 bg-danger/[0.055]"}`}>
          <div className="grid gap-3 sm:grid-cols-2">
            <HeadFact label="Provider head" value={pull.headSha} tone={exactHeadReady ? "ready" : "danger"} />
            <HeadFact label="Task-recorded head" value={state.pullHeadSha ?? "missing"} tone={exactHeadReady ? "ready" : "danger"} />
          </div>
          <p className={`mt-2 text-[11px] leading-5 ${exactHeadReady ? "text-success" : "text-danger"}`}>
            {exactHeadReady ? "Exact-head guard satisfied. Merge still remains subject to fresh provider checks, reviews and branch protection." : "Head mismatch: merge is disabled. Refresh state and review the new provider head before any new confirmation."}
          </p>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Base" value={pull.baseBranch} />
          <Fact label="Head branch" value={pull.headBranch} />
          <Fact label="Mergeability" value={pull.mergeable === false ? "Blocked" : pull.mergeable === true ? "Provider says mergeable" : "Provider did not report"} />
          <Fact label="Merge state" value={pull.mergeState ?? "—"} />
          <Fact label="Draft" value={String(pull.draft)} />
          <Fact label="Provider state" value={pull.state} />
        </dl>

        {pull.url ? <div className="rounded-xl border border-border bg-muted/25 px-3 py-2 text-[11px] leading-5 text-muted-foreground"><span className="font-semibold text-foreground">Provider URL</span><br /><code className="select-all break-all">{pull.url}</code></div> : null}

        {!exactHeadReady && pull.state === "open" ? (
          <InlineNotice tone="danger" title="Exact-head guard failed" role="alert">
            Provider head <code className="select-all break-all font-mono text-[11px] text-foreground">{pull.headSha}</code> differs from task-recorded head <code className="select-all break-all font-mono text-[11px] text-foreground">{state.pullHeadSha ?? "missing"}</code>. Desktop will not substitute or guess a SHA.
          </InlineNotice>
        ) : null}
        {pull.mergeable === false ? (
          <InlineNotice tone="warning" title="Provider reports merge blocked">
            {pull.mergeState ? `${pull.mergeState}. ` : ""}Required checks, reviews, branch protection, or permissions remain provider-owned constraints.
          </InlineNotice>
        ) : null}

        {state.lifecyclePhase === "pr_open" ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/15 p-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Merge method</span>
              <select className={selectClass} value={mergeMethod} onChange={(event) => onMergeMethod(event.target.value as ProviderMergeMethod)}>
                <option value="merge">Merge commit</option>
                <option value="squash">Squash</option>
                <option value="rebase">Rebase</option>
              </select>
            </label>
            <div className="text-right">
              {!mergeReady ? <p className="mb-2 text-[10px] text-muted-foreground">Merge stays disabled until provider/head guards are satisfied.</p> : null}
              <ActionButton variant="destructive" disabled={!mergeReady || busy === "merge"} onClick={onMerge}>
                <GitMerge className="size-4" aria-hidden="true" />
                {busy === "merge" ? "Merging…" : `Merge exact head ${shortProviderSha(pull.headSha)}`}
              </ActionButton>
            </div>
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function HeadFact({ label, value, tone }: { label: string; value: string; tone: "ready" | "danger" }) {
  return <div className="min-w-0"><p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p><code className={`mt-1 block select-all break-all text-[11px] leading-5 ${tone === "ready" ? "text-success" : "text-danger"}`}>{value}</code></div>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all text-xs text-foreground" title={value}>{value}</dd>
    </div>
  );
}
