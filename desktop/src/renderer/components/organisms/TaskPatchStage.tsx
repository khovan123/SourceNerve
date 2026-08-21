import { FilePlus2, ShieldCheck, Trash2 } from "lucide-react";

import type { TaskExpectationDraft, TaskSessionProposalReview } from "../../task-workflow-view-model";
import { shortTaskSha } from "../../task-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
import { CodeSurface } from "../molecules/CodeSurface";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function TaskPatchStage({
  expectations,
  patch,
  proposal,
  durableProposalExists,
  busy,
  onExpectation,
  onLoadSha,
  onRemoveExpectation,
  onAddExpectation,
  onPatch,
  onPropose,
  onApply,
}: {
  expectations: TaskExpectationDraft[];
  patch: string;
  proposal: TaskSessionProposalReview | null;
  durableProposalExists: boolean;
  busy: string | null;
  onExpectation(key: number, update: Partial<TaskExpectationDraft>): void;
  onLoadSha(item: TaskExpectationDraft): void;
  onRemoveExpectation(key: number): void;
  onAddExpectation(): void;
  onPatch(value: string): void;
  onPropose(): void;
  onApply(): void;
}) {
  return (
    <SurfaceCard title="2. Patch proposal" eyebrow="Review expectations + complete patch before Apply" description="File expectations guard the exact starting state; the unified patch is reviewed as one bounded mutation proposal.">
      <div className="space-y-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.22fr)]">
          <section className="min-w-0 rounded-xl border border-border bg-background/30 p-3">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">File expectations</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Existing files require the current SHA; new files must not already exist.</p>
              </div>
              <ActionButton variant="secondary" size="sm" disabled={expectations.length >= 128} onClick={onAddExpectation}>
                <FilePlus2 className="size-3.5" aria-hidden="true" />
                Add
              </ActionButton>
            </div>
            <div className="max-h-[34rem] space-y-2 overflow-auto overscroll-contain pr-1" tabIndex={0}>
              {expectations.map((item) => (
                <div className="grid gap-2 rounded-xl border border-border bg-card/65 p-3" key={item.key}>
                  <input className="h-9 w-full rounded-lg border border-border bg-background/70 px-3 font-mono text-xs text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={item.path} maxLength={1024} onChange={(event) => onExpectation(item.key, { path: event.target.value })} placeholder="src/module.rs" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">New file</span>
                      <ToggleSwitch label={`Mark ${item.path || "path"} as new file`} checked={item.newFile} onChange={(checked) => onExpectation(item.key, { newFile: checked })} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!item.newFile ? <ActionButton variant="secondary" size="sm" disabled={!item.path.trim() || busy === `sha:${item.key}`} onClick={() => onLoadSha(item)}>{busy === `sha:${item.key}` ? "Loading…" : "Load SHA"}</ActionButton> : null}
                      <ActionButton variant="ghost" size="icon" disabled={expectations.length === 1} onClick={() => onRemoveExpectation(item.key)} aria-label="Remove file expectation" className="text-danger hover:text-danger"><Trash2 className="size-3.5" aria-hidden="true" /></ActionButton>
                    </div>
                  </div>
                  <p className={`min-h-4 break-all text-[10px] leading-4 ${item.message && !item.sha256 ? "text-warning" : "text-muted-foreground"}`}>{item.sha256 ? `SHA ${shortTaskSha(item.sha256)}` : item.message ?? ""}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="min-w-0 rounded-xl border border-border bg-background/30 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold text-foreground">Unified patch</p>
                <p className="mt-1 text-[10px] text-muted-foreground">Max 1,000,000 bytes · {new TextEncoder().encode(patch).byteLength.toLocaleString()} bytes drafted</p>
              </div>
              <ActionButton size="sm" disabled={busy === "propose" || !patch} onClick={onPropose}>
                <ShieldCheck className="size-3.5" aria-hidden="true" />
                {busy === "propose" ? "Validating…" : "Validate proposal"}
              </ActionButton>
            </div>
            <textarea className="min-h-[24rem] max-h-[42rem] w-full resize-y rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#f2eadf] outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 dark:bg-black/40" value={patch} onChange={(event) => onPatch(event.target.value)} spellCheck={false} placeholder="diff --git a/... b/..." />
            <p className="mt-2 text-[10px] leading-4 text-muted-foreground">Patch text stays in renderer memory and SourceNerve task state; Desktop does not persist it in its registry.</p>
          </section>
        </div>

        {proposal ? <ProposalReview proposal={proposal} busy={busy === "apply"} onApply={onApply} /> : durableProposalExists ? (
          <InlineNotice tone="warning" title="Durable proposal exists, but raw patch is not restored">
            For safety, create and review a proposal in this session before Apply. Desktop will not reconstruct the patch from durable metadata alone.
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function ProposalReview({ proposal, busy, onApply }: { proposal: TaskSessionProposalReview; busy: boolean; onApply(): void }) {
  return (
    <div className="space-y-3 rounded-xl border border-warning/25 bg-warning/[0.055] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Reviewed proposal in this session</p>
          <p className="mt-1 break-all text-[10px] leading-4 text-muted-foreground">Proposal {proposal.proposal.id} · SHA {proposal.proposal.patchSha256}</p>
        </div>
        <ActionButton variant="destructive" size="sm" disabled={busy} onClick={onApply}>{busy ? "Applying…" : "Apply reviewed proposal"}</ActionButton>
      </div>
      <div className="flex max-h-24 flex-wrap gap-2 overflow-auto overscroll-contain text-[10px] text-muted-foreground" tabIndex={0}>{proposal.proposal.changedPaths.map((path) => <span key={path} className="max-w-full break-all rounded-full border border-border bg-card px-2 py-1 font-mono">{path}</span>)}</div>
      <CodeSurface title="Reviewed patch" meta={`SHA ${shortTaskSha(proposal.proposal.patchSha256)}`} maxHeightClass="max-h-[30rem]">{proposal.patch}</CodeSurface>
    </div>
  );
}
