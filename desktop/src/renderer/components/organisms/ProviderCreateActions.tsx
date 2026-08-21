import type { ReactNode } from "react";
import { GitPullRequest, MessageSquarePlus } from "lucide-react";

import type { ProviderWorkflowState } from "../../../shared/provider-workflow-api";
import { providerChangeLabel, providerLabel, shortProviderSha } from "../../provider-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export function ProviderCreateActions({
  state,
  issueTitle,
  issueBody,
  pullTitle,
  pullBody,
  draft,
  busy,
  onIssueTitle,
  onIssueBody,
  onPullTitle,
  onPullBody,
  onDraft,
  onCreateIssue,
  onCreatePull,
}: {
  state: ProviderWorkflowState;
  issueTitle: string;
  issueBody: string;
  pullTitle: string;
  pullBody: string;
  draft: boolean;
  busy: string | null;
  onIssueTitle(value: string): void;
  onIssueBody(value: string): void;
  onPullTitle(value: string): void;
  onPullBody(value: string): void;
  onDraft(value: boolean): void;
  onCreateIssue(): void;
  onCreatePull(): void;
}) {
  const pullReady = state.lifecyclePhase === "pushed";
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <SurfaceCard title="Optional provider issue" eyebrow="Context / tracking" description="Create a provider issue from the current durable task context. This does not change the exact pushed task head.">
        <div className="space-y-4">
          <Field label="Title"><input className={`${controlClass} h-10`} value={issueTitle} maxLength={512} onChange={(event) => onIssueTitle(event.target.value)} /></Field>
          <Field label="Body"><textarea className={`${controlClass} min-h-32 py-3`} value={issueBody} rows={5} maxLength={64 * 1024} onChange={(event) => onIssueBody(event.target.value)} /></Field>
          <div className="flex justify-end">
            <ActionButton variant="secondary" size="sm" disabled={!issueTitle.trim() || busy === "issue"} onClick={onCreateIssue}>
              <MessageSquarePlus className="size-3.5" aria-hidden="true" />
              {busy === "issue" ? "Creating…" : `Create ${providerLabel(state.provider)} issue`}
            </ActionButton>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard title={`Create ${providerChangeLabel(state.provider)}`} eyebrow="Phase 1 · exact pushed task SHA" description="The change request can be created only from the exact task branch and pushed SHA recorded by SourceNerve.">
        {!pullReady ? (
          <InlineNotice tone="warning" title="Task must be pushed first">
            Available only when task lifecycle is <strong className="text-foreground">pushed</strong>. Current phase: {state.lifecyclePhase}.
          </InlineNotice>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-success/20 bg-success/[0.055] px-3 py-2.5">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Exact source</p>
              <code className="mt-1 block select-all break-all text-[11px] leading-5 text-success">{state.taskBranch} @ {state.taskPushSha ?? "—"} → {state.defaultBranch}</code>
            </div>
            <Field label="Title"><input className={`${controlClass} h-10`} value={pullTitle} maxLength={512} onChange={(event) => onPullTitle(event.target.value)} /></Field>
            <Field label="Body"><textarea className={`${controlClass} min-h-32 py-3`} value={pullBody} rows={5} maxLength={64 * 1024} onChange={(event) => onPullBody(event.target.value)} /></Field>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/25 px-3 py-2.5">
              <div>
                <p className="text-xs font-medium text-foreground">Create as draft</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Keep the provider change request non-final until explicitly marked ready there.</p>
              </div>
              <ToggleSwitch label="Create change request as draft" checked={draft} onChange={onDraft} />
            </div>
            <div className="flex justify-end">
              <ActionButton disabled={!pullTitle.trim() || busy === "pull-create"} onClick={onCreatePull}>
                <GitPullRequest className="size-4" aria-hidden="true" />
                {busy === "pull-create" ? "Creating…" : `Create ${providerChangeLabel(state.provider)} from ${state.taskPushSha ? shortProviderSha(state.taskPushSha) : "task head"}`}
              </ActionButton>
            </div>
          </div>
        )}
      </SurfaceCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{label}</span>{children}</label>;
}
