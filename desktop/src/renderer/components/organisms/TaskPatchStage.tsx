import { FilePlus2, ShieldCheck, Trash2 } from "lucide-react";

import type { TaskExpectationDraft, TaskSessionProposalReview } from "../../task-workflow-view-model";
import { shortTaskSha } from "../../task-workflow-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
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
    <SurfaceCard title="2. Patch proposal" eyebrow="Review expectations + complete patch before Apply">
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">File expectations</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Existing files require the current SHA; new files must not already exist.</p>
            </div>
            <ActionButton variant="secondary" size="sm" disabled={expectations.length >= 128} onClick={onAddExpectation}>
              <FilePlus2 className="size-3.5" aria-hidden="true" />
              Add expectation
            </ActionButton>
          </div>
          <div className="space-y-2">
            {expectations.map((item) => (
              <div className="grid gap-2 rounded-xl border border-border bg-muted/20 p-3 lg:grid-cols-[minmax(0,1fr)_auto_auto]" key={item.key}>
                <div className="min-w-0">
                  <input className="h-9 w-full rounded-lg border border-border bg-background/70 px-3 font-mono text-xs text-foreground outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10" value={item.path} maxLength={1024} onChange={(event) => onExpectation(item.key, { path: event.target.value })} placeholder="src/module.rs" />
                  <p className={`mt-1 min-h-4 text-[10px] ${item.message && !item.sha256 ? "text-warning" : "text-muted-foreground"}`}>{item.sha256 ? `SHA ${shortTaskSha(item.sha256)}` : item.message ?? ""}</p>
                </div>
                <div className="flex items-center gap-2 self-start">
                  <span className="text-[11px] text-muted-foreground">New file</span>
                  <ToggleSwitch label={`Mark ${item.path || "path"} as new file`} checked={item.newFile} onChange={(checked) => onExpectation(item.key, { newFile: checked })} />
                </div>
                <div className="flex flex-wrap gap-2 self-start">
                  {!item.newFile ? <ActionButton variant="secondary" size="sm" disabled={!item.path.trim() || busy === `sha:${item.key}`} onClick={() => onLoadSha(item)}>{busy === `sha:${item.key}` ? "Loading…" : "Load current SHA"}</ActionButton> : null}
                  <ActionButton variant="ghost" size="icon" disabled={expectations.length === 1} onClick={() => onRemoveExpectation(item.key)} aria-label="Remove file expectation" className="text-danger hover:text-danger"><Trash2 className="size-3.5" aria-hidden="true" /></ActionButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Unified patch · max 1,000,000 bytes</span>
          <textarea className="min-h-72 w-full rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#f2eadf] outline-none focus:border-primary/45 focus:ring-2 focus:ring-primary/10 dark:bg-black/40" value={patch} onChange={(event) => onPatch(event.target.value)} spellCheck={false} placeholder="diff --git a/... b/..." />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">Draft size: {new TextEncoder().encode(patch).byteLength.toLocaleString()} bytes. Patch text stays in renderer memory and SourceNerve task state; Desktop does not persist it in its registry.</p>
          <ActionButton size="sm" disabled={busy === "propose" || !patch} onClick={onPropose}>
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {busy === "propose" ? "Validating…" : "Validate proposal"}
          </ActionButton>
        </div>

        {proposal ? <ProposalReview proposal={proposal} busy={busy === "apply"} onApply={onApply} /> : durableProposalExists ? (
          <p className="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2 text-xs leading-5 text-warning">A proposed patch exists in durable task state, but its raw patch is not restored into Desktop after reload. For safety, create/review a proposal in this session before Apply.</p>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function ProposalReview({ proposal, busy, onApply }: { proposal: TaskSessionProposalReview; busy: boolean; onApply(): void }) {
  return (
    <div className="space-y-3 rounded-xl border border-warning/25 bg-warning/5 p-4">
      <div>
        <p className="text-xs font-semibold text-foreground">Reviewed proposal in this session</p>
        <p className="mt-1 break-all text-[10px] text-muted-foreground">Proposal {proposal.proposal.id} · SHA {proposal.proposal.patchSha256}</p>
      </div>
      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">{proposal.proposal.changedPaths.map((path) => <span key={path} className="rounded-full border border-border bg-card px-2 py-1 font-mono">{path}</span>)}</div>
      <pre className="max-h-96 overflow-auto rounded-xl border border-border bg-[#11100e] p-4 font-mono text-[11px] leading-5 text-[#f2eadf] dark:bg-black/40"><code>{proposal.patch}</code></pre>
      <ActionButton variant="destructive" size="sm" disabled={busy} onClick={onApply}>{busy ? "Applying…" : "Apply reviewed proposal"}</ActionButton>
    </div>
  );
}
