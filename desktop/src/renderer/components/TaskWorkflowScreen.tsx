import { useEffect, useMemo, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type { IntelligenceContextPack } from "../../shared/intelligence-api";
import type {
  DesktopTaskApplyResult,
  DesktopTaskCommitResult,
  DesktopTaskFileExpectation,
  DesktopTaskListItem,
  DesktopTaskProposalView,
  DesktopTaskPushResult,
  DesktopTaskReviewResult,
  DesktopTaskSnapshot,
} from "../../shared/task-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

interface ExpectationDraft {
  key: number;
  path: string;
  newFile: boolean;
  sha256?: string;
  message?: string;
}

interface SessionProposalReview {
  proposal: DesktopTaskProposalView;
  patch: string;
  expectedFiles: DesktopTaskFileExpectation[];
}

const PHASES = ["snapshot", "branched", "patched", "reviewed", "committed", "pushed"] as const;
let expectationKey = 1;

export function TaskWorkflowScreen() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [tasks, setTasks] = useState<DesktopTaskListItem[]>([]);
  const [selected, setSelected] = useState<DesktopTaskSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newWorkspace, setNewWorkspace] = useState("");
  const [contextQuery, setContextQuery] = useState("");
  const [contextMaxBytes, setContextMaxBytes] = useState(64 * 1024);
  const [contextMaxItems, setContextMaxItems] = useState(20);
  const [beginContext, setBeginContext] = useState<IntelligenceContextPack | null>(null);
  const [openTaskId, setOpenTaskId] = useState("");

  const [branch, setBranch] = useState("");
  const [patch, setPatch] = useState("");
  const [expectations, setExpectations] = useState<ExpectationDraft[]>([
    { key: expectationKey++, path: "", newFile: false },
  ]);
  const [sessionProposal, setSessionProposal] = useState<SessionProposalReview | null>(null);
  const [applied, setApplied] = useState<DesktopTaskApplyResult | null>(null);
  const [reviewed, setReviewed] = useState<DesktopTaskReviewResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committed, setCommitted] = useState<DesktopTaskCommitResult | null>(null);
  const [pushed, setPushed] = useState<DesktopTaskPushResult | null>(null);

  useEffect(() => {
    void loadInitial();
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selected?.task.workspace) ?? null,
    [selected, workspaces],
  );
  const writable = selectedWorkspace?.access === "read-write";
  const mutationBlocked = !writable || selected?.task.status === "stale" || selected?.task.status === "cancelled";
  const latestProposal = selected?.proposals[0] ?? null;
  const currentPhase = selected?.lifecycle.phase ?? "snapshot";
  const phaseIndex = PHASES.indexOf(currentPhase as (typeof PHASES)[number]);

  async function loadInitial(): Promise<void> {
    setBusy("load");
    setError(null);
    const [workspaceResult, taskResult] = await Promise.all([
      window.sourcenerveDesktop.listManagedWorkspaces(),
      window.sourcenerveDesktop.listDesktopTasks(),
    ]);
    if (workspaceResult.ok) {
      const ready = workspaceResult.value.filter((workspace) => workspace.validation.state === "ready");
      setWorkspaces(ready);
      const eligible = ready.find((workspace) => workspace.access === "read-write" && workspace.index.state === "current" && workspace.dirty === false);
      setNewWorkspace((current) => current || eligible?.id || "");
    } else {
      setError(workspaceResult.error.message);
    }
    if (taskResult.ok) setTasks(taskResult.value);
    else setError((current) => current ?? taskResult.error.message);
    setBusy(null);
  }

  async function refreshTask(taskId = selected?.task.id): Promise<void> {
    if (!taskId) return;
    const result = await window.sourcenerveDesktop.getDesktopTask(taskId);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setSelected(result.value);
    setBranch(result.value.lifecycle.branch ?? suggestBranch(result.value));
    await refreshTaskList();
  }

  async function refreshTaskList(): Promise<void> {
    const result = await window.sourcenerveDesktop.listDesktopTasks();
    if (result.ok) setTasks(result.value);
  }

  function resetSessionMutationState(): void {
    setSessionProposal(null);
    setApplied(null);
    setReviewed(null);
    setCommitted(null);
    setPushed(null);
    setPatch("");
    setExpectations([{ key: expectationKey++, path: "", newFile: false }]);
    setCommitMessage("");
  }

  async function selectTask(taskId: string): Promise<void> {
    setBusy("task");
    setError(null);
    setNotice(null);
    resetSessionMutationState();
    setBeginContext(null);
    const result = await window.sourcenerveDesktop.getDesktopTask(taskId);
    if (result.ok) {
      setSelected(result.value);
      setBranch(result.value.lifecycle.branch ?? suggestBranch(result.value));
    } else setError(result.error.message);
    setBusy(null);
  }

  async function beginTask(): Promise<void> {
    if (!newWorkspace) return;
    setBusy("begin");
    setError(null);
    setNotice(null);
    resetSessionMutationState();
    const result = await window.sourcenerveDesktop.beginDesktopTask({
      workspace: newWorkspace,
      ...(contextQuery.trim() ? { contextQuery: contextQuery.trim() } : {}),
      contextMaxBytes,
      contextMaxItems,
    });
    if (result.ok) {
      setSelected(result.value.snapshot);
      setBeginContext(result.value.context ?? null);
      setBranch(suggestBranch(result.value.snapshot));
      setNotice(result.value.replayed ? "Existing idempotent task begin result recovered." : "Task snapshot created. Review the base HEAD and graph version before branching.");
      await refreshTaskList();
    } else setError(result.error.message);
    setBusy(null);
  }

  async function rememberTask(): Promise<void> {
    const taskId = openTaskId.trim();
    if (!taskId) return;
    setBusy("remember");
    setError(null);
    resetSessionMutationState();
    const result = await window.sourcenerveDesktop.rememberDesktopTask(taskId);
    if (result.ok) {
      setSelected(result.value);
      setBranch(result.value.lifecycle.branch ?? suggestBranch(result.value));
      setOpenTaskId("");
      setNotice("Existing durable task added to Desktop. State was loaded from SourceNerve, not reconstructed locally.");
      await refreshTaskList();
    } else setError(result.error.message);
    setBusy(null);
  }

  async function cancelTask(): Promise<void> {
    if (!selected) return;
    if (!window.confirm(`Cancel task ${selected.task.id}? This changes the durable task state but does not reset or delete repository files.`)) return;
    setBusy("cancel");
    setError(null);
    const result = await window.sourcenerveDesktop.cancelDesktopTask(selected.task.id);
    if (result.ok) {
      setSelected(result.value);
      setNotice("Task cancelled. Repository files were not reset by Desktop.");
      await refreshTaskList();
    } else setError(result.error.message);
    setBusy(null);
  }

  async function checkoutBranch(): Promise<void> {
    if (!selected || !branch.trim()) return;
    const workspace = selectedWorkspace;
    if (!workspace) return;
    if (!window.confirm(`Create/recover feature branch “${branch.trim()}” for task ${selected.task.id}?\n\nBase HEAD: ${selected.task.baseHead}\nDefault branch: ${workspace.defaultBranch}`)) return;
    setBusy("branch");
    setError(null);
    const result = await window.sourcenerveDesktop.checkoutDesktopTaskBranch({ taskId: selected.task.id, branch: branch.trim() });
    if (result.ok) {
      setNotice(result.value.replayed ? "Existing task branch recovered." : "Feature branch is ready.");
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  function changePatch(value: string): void {
    setPatch(value);
    setSessionProposal(null);
  }

  function updateExpectation(key: number, update: Partial<ExpectationDraft>): void {
    setExpectations((items) => items.map((item) => item.key === key ? { ...item, ...update, sha256: update.path !== undefined || update.newFile !== undefined ? undefined : item.sha256, message: undefined } : item));
    setSessionProposal(null);
  }

  async function loadExpectationSha(item: ExpectationDraft): Promise<void> {
    if (!selected || !item.path.trim() || item.newFile) return;
    setBusy(`sha:${item.key}`);
    setError(null);
    const result = await window.sourcenerveDesktop.readIntelligenceFile({
      workspace: selected.task.workspace,
      path: item.path.trim(),
      startLine: 1,
      endLine: 1,
    });
    if (result.ok) {
      setExpectations((items) => items.map((entry) => entry.key === item.key ? { ...entry, sha256: result.value.sha256, message: "Current file SHA loaded" } : entry));
      setSessionProposal(null);
    } else {
      setExpectations((items) => items.map((entry) => entry.key === item.key ? { ...entry, sha256: undefined, message: result.error.message } : entry));
    }
    setBusy(null);
  }

  function normalizedExpectations(): DesktopTaskFileExpectation[] | null {
    const result: DesktopTaskFileExpectation[] = [];
    for (const item of expectations) {
      const path = item.path.trim();
      if (!path) continue;
      if (item.newFile) result.push({ path });
      else if (item.sha256) result.push({ path, sha256: item.sha256 });
      else return null;
    }
    return result.length > 0 ? result : null;
  }

  async function proposePatch(): Promise<void> {
    if (!selected || !patch) return;
    const expectedFiles = normalizedExpectations();
    if (!expectedFiles) {
      setError("Every existing file expectation needs a current SHA. Use “Load current SHA”, or mark the path as a new file.");
      return;
    }
    setBusy("propose");
    setError(null);
    const result = await window.sourcenerveDesktop.proposeDesktopTaskPatch({ taskId: selected.task.id, expectedFiles, patch });
    if (result.ok) {
      setSessionProposal({ proposal: result.value.proposal, patch, expectedFiles });
      setNotice("Proposal validated by SourceNerve. Review the complete patch, changed paths and expectations below before Apply.");
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function applyProposal(): Promise<void> {
    if (!selected || !sessionProposal) return;
    const proposal = sessionProposal.proposal;
    const stillPresent = selected.proposals.some((item) => item.id === proposal.id && item.status === "proposed");
    if (!stillPresent) {
      setSessionProposal(null);
      setError("Proposal changed after review. Refresh and create/review a current proposal before Apply.");
      return;
    }
    const confirmed = window.confirm(
      `Apply reviewed proposal ${proposal.id}?\n\nPatch SHA-256: ${proposal.patchSha256}\nChanged paths:\n${proposal.changedPaths.join("\n")}\n\nSourceNerve will re-check HEAD and file expectations before changing the working tree.`,
    );
    if (!confirmed) return;
    setBusy("apply");
    setError(null);
    const result = await window.sourcenerveDesktop.applyDesktopTaskProposal({ taskId: selected.task.id, proposalId: proposal.id });
    if (result.ok) {
      setApplied(result.value);
      setSessionProposal(null);
      setNotice("Patch applied through SourceNerve guards. Review the complete applied delta before commit.");
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function reviewTask(): Promise<void> {
    if (!selected) return;
    setBusy("review");
    setError(null);
    const result = await window.sourcenerveDesktop.reviewDesktopTask(selected.task.id);
    if (result.ok) {
      setReviewed(result.value);
      setNotice(`Review gate recorded: ${result.value.review.diffSha256}. Commit remains disabled until this review is loaded in the current session.`);
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function commitTask(): Promise<void> {
    if (!selected || !reviewed || !commitMessage.trim()) return;
    const lifecycleSha = selected.lifecycle.reviewedDiffSha256;
    if (!lifecycleSha || reviewed.review.diffSha256 !== lifecycleSha) {
      setReviewed(null);
      setError("Reviewed diff changed. Run Review again before commit.");
      return;
    }
    if (!window.confirm(`Commit the exact reviewed delta?\n\nBranch: ${selected.lifecycle.branch}\nHEAD: ${reviewed.review.head}\nReview SHA-256: ${reviewed.review.diffSha256}\nMessage: ${commitMessage.trim()}`)) return;
    setBusy("commit");
    setError(null);
    const result = await window.sourcenerveDesktop.commitDesktopTask({ taskId: selected.task.id, message: commitMessage.trim() });
    if (result.ok) {
      setCommitted(result.value);
      setNotice(`Committed exact reviewed state at ${result.value.commit.commit}.`);
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function pushTask(): Promise<void> {
    if (!selected || !selected.lifecycle.commitSha || !selectedWorkspace) return;
    if (!window.confirm(`Push exact persisted task commit?\n\nRemote: ${selectedWorkspace.remote}\nBranch: ${selected.lifecycle.branch}\nCommit: ${selected.lifecycle.commitSha}\n\nNo force push or custom refspec is available.`)) return;
    setBusy("push");
    setError(null);
    const result = await window.sourcenerveDesktop.pushDesktopTask(selected.task.id);
    if (result.ok) {
      setPushed(result.value);
      setNotice(`Pushed ${result.value.push.head} to ${result.value.push.remote}/${result.value.push.branch}. Pull request lifecycle is a separate step in the next workflow.`);
      await refreshTask(selected.task.id);
    } else setError(result.error.message);
    setBusy(null);
  }

  const eligibleWorkspaces = workspaces.filter((workspace) =>
    workspace.access === "read-write" &&
    workspace.index.state === "current" &&
    workspace.validation.state === "ready" &&
    workspace.dirty === false &&
    (!workspace.branch || workspace.branch === workspace.defaultBranch),
  );

  return (
    <div className="task-shell">
      <Panel title="Guarded tasks" eyebrow="Durable SourceNerve mutation workflow">
        <div className="task-callout">
          <strong>No direct Git controls.</strong>
          <span>Desktop never offers default-branch commits, force push, reset, raw refspecs or shell commands. Server-side SourceNerve guards remain authoritative.</span>
        </div>
        {error ? <p className="task-error" role="alert">{error}</p> : null}
        {notice ? <p className="task-notice">{notice}</p> : null}
      </Panel>

      <div className="task-columns task-columns--top">
        <Panel title="Start a task" eyebrow="Snapshot current HEAD + graph">
          {eligibleWorkspaces.length === 0 ? <p className="muted">A new task requires a ready, clean, current-index, read-write workspace on its default branch.</p> : (
            <>
              <label className="field"><span>Workspace</span><select value={newWorkspace} onChange={(event) => setNewWorkspace(event.target.value)}>{eligibleWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.id}</option>)}</select></label>
              <label className="field"><span>Context question (optional)</span><textarea value={contextQuery} maxLength={4096} rows={3} onChange={(event) => setContextQuery(event.target.value)} placeholder="What code should be changed and why?" /></label>
              <div className="task-inline-fields">
                <label className="field"><span>Context budget</span><select value={contextMaxBytes} onChange={(event) => setContextMaxBytes(Number(event.target.value))}><option value={16 * 1024}>16 KiB</option><option value={32 * 1024}>32 KiB</option><option value={64 * 1024}>64 KiB</option><option value={128 * 1024}>128 KiB</option></select></label>
                <label className="field"><span>Max items</span><select value={contextMaxItems} onChange={(event) => setContextMaxItems(Number(event.target.value))}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option></select></label>
              </div>
              <button className="button" type="button" disabled={busy === "begin" || !newWorkspace} onClick={() => void beginTask()}>{busy === "begin" ? "Starting…" : "Start durable task"}</button>
            </>
          )}
        </Panel>

        <Panel title="Resume tasks" eyebrow="Rust state is authoritative">
          <div className="task-open-row">
            <input value={openTaskId} onChange={(event) => setOpenTaskId(event.target.value)} placeholder="Existing task UUID" />
            <button className="button button--quiet" type="button" disabled={busy === "remember" || !openTaskId.trim()} onClick={() => void rememberTask()}>Open existing</button>
          </div>
          <div className="task-list">
            {tasks.map((item) => (
              <button className={`task-list-item ${selected?.task.id === item.taskId ? "task-list-item--active" : ""}`} type="button" key={item.taskId} onClick={() => void selectTask(item.taskId)}>
                <strong>{item.snapshot?.task.contextQuery || item.taskId}</strong>
                <span>{item.workspace} · {item.snapshot ? `${item.snapshot.task.status}/${item.snapshot.lifecycle.phase}` : "unavailable"}</span>
                {item.unavailableReason ? <span className="task-warning-text">{item.unavailableReason}</span> : null}
              </button>
            ))}
            {tasks.length === 0 ? <p className="muted">No durable tasks remembered by Desktop yet.</p> : null}
          </div>
        </Panel>
      </div>

      {selected ? (
        <>
          <Panel title={`Task ${selected.task.id}`} eyebrow={`${selected.task.workspace} · durable lifecycle`} actions={<div className="task-heading-actions"><button className="button button--quiet" type="button" onClick={() => void refreshTask()}>Refresh</button>{selected.task.status !== "cancelled" && selected.lifecycle.phase !== "pushed" ? <button className="button button--danger" type="button" disabled={busy === "cancel"} onClick={() => void cancelTask()}>Cancel task</button> : null}</div>}>
            <div className="task-status-row">
              <StatusBadge label={`Task: ${selected.task.status}`} tone={selected.task.status === "active" || selected.task.status === "applied" ? "ready" : "warning"} />
              <StatusBadge label={`Phase: ${selected.lifecycle.phase}`} tone={selected.lifecycle.phase === "pushed" ? "ready" : "working"} />
              <StatusBadge label={writable ? "Read-write" : "Read-only — mutations hidden"} tone={writable ? "ready" : "warning"} />
            </div>
            <div className="task-metrics">
              <TaskMetric label="Base HEAD" value={shortSha(selected.task.baseHead)} />
              <TaskMetric label="Graph version" value={String(selected.task.graphVersion)} />
              <TaskMetric label="Branch" value={selected.lifecycle.branch ?? "Not created"} />
              <TaskMetric label="Review SHA" value={selected.lifecycle.reviewedDiffSha256 ? shortSha(selected.lifecycle.reviewedDiffSha256) : "Not reviewed"} />
              <TaskMetric label="Commit" value={selected.lifecycle.commitSha ? shortSha(selected.lifecycle.commitSha) : "Not committed"} />
              <TaskMetric label="Push" value={selected.lifecycle.pushSha ? shortSha(selected.lifecycle.pushSha) : "Not pushed"} />
            </div>
            {selected.task.staleReason ? <p className="task-error"><strong>Stale:</strong> {selected.task.staleReason}</p> : null}
            <TaskPhaseRail phaseIndex={phaseIndex} />
          </Panel>

          {beginContext ? <ContextSnapshot pack={beginContext} /> : null}

          {!mutationBlocked && selected.lifecycle.phase === "snapshot" ? (
            <Panel title="1. Feature branch" eyebrow="Create or recover from exact task base HEAD">
              <label className="field"><span>Feature branch</span><input value={branch} maxLength={240} onChange={(event) => setBranch(event.target.value)} /></label>
              <p className="muted">Default branch: {selectedWorkspace?.defaultBranch}. SourceNerve will fail closed if the current HEAD no longer matches the task snapshot.</p>
              <button className="button" type="button" disabled={busy === "branch" || !branch.trim()} onClick={() => void checkoutBranch()}>{busy === "branch" ? "Preparing…" : "Create / recover feature branch"}</button>
            </Panel>
          ) : null}

          {!mutationBlocked && selected.lifecycle.phase === "branched" ? (
            <Panel title="2. Patch proposal" eyebrow="Review expectations + complete patch before Apply">
              <div className="task-expectations">
                {expectations.map((item) => (
                  <div className="task-expectation" key={item.key}>
                    <input value={item.path} maxLength={1024} onChange={(event) => updateExpectation(item.key, { path: event.target.value })} placeholder="src/module.rs" />
                    <label><input type="checkbox" checked={item.newFile} onChange={(event) => updateExpectation(item.key, { newFile: event.target.checked })} /> New file</label>
                    {!item.newFile ? <button className="button button--quiet" type="button" disabled={!item.path.trim() || busy === `sha:${item.key}`} onClick={() => void loadExpectationSha(item)}>{busy === `sha:${item.key}` ? "Loading…" : "Load current SHA"}</button> : <span className="muted">No existing SHA expected</span>}
                    <button className="button button--quiet" type="button" disabled={expectations.length === 1} onClick={() => { setExpectations((items) => items.filter((entry) => entry.key !== item.key)); setSessionProposal(null); }}>Remove</button>
                    <span className="task-expectation-sha">{item.sha256 ? `SHA ${shortSha(item.sha256)}` : item.message ?? ""}</span>
                  </div>
                ))}
                <button className="button button--quiet" type="button" disabled={expectations.length >= 128} onClick={() => { setExpectations((items) => [...items, { key: expectationKey++, path: "", newFile: false }]); setSessionProposal(null); }}>Add file expectation</button>
              </div>
              <label className="field"><span>Unified patch · max 1,000,000 bytes</span><textarea className="task-patch-editor" value={patch} onChange={(event) => changePatch(event.target.value)} spellCheck={false} placeholder="diff --git a/... b/..." /></label>
              <p className="muted">Draft size: {new TextEncoder().encode(patch).byteLength.toLocaleString()} bytes. Patch text stays in renderer memory and SourceNerve task state; Desktop does not persist it in its registry.</p>
              <button className="button" type="button" disabled={busy === "propose" || !patch} onClick={() => void proposePatch()}>{busy === "propose" ? "Validating…" : "Validate proposal"}</button>
              {sessionProposal ? <ProposalReview proposal={sessionProposal} onApply={() => void applyProposal()} busy={busy === "apply"} /> : latestProposal?.status === "proposed" ? <p className="task-warning-text">A proposed patch exists in durable task state, but its raw patch is not restored into Desktop after reload. For safety, create/review a proposal in this session before Apply.</p> : null}
            </Panel>
          ) : null}

          {!mutationBlocked && (selected.lifecycle.phase === "patched" || selected.lifecycle.phase === "reviewed") ? (
            <Panel title="3. Review applied delta" eyebrow="Complete diff + SHA gate before commit">
              {applied ? <DiffBlock title="Applied result" diff={applied.diff} sha={undefined} /> : <p className="muted">Applied diff is not persisted in Desktop. Run Review to load the complete current delta and record its SHA gate.</p>}
              <button className="button" type="button" disabled={busy === "review"} onClick={() => void reviewTask()}>{busy === "review" ? "Reviewing…" : selected.lifecycle.phase === "reviewed" ? "Reload reviewed diff" : "Review complete delta"}</button>
              {reviewed ? <DiffBlock title={`Reviewed ${reviewed.review.branch} @ ${shortSha(reviewed.review.head)}`} diff={reviewed.review.diff} sha={reviewed.review.diffSha256} /> : null}
            </Panel>
          ) : null}

          {!mutationBlocked && selected.lifecycle.phase === "reviewed" ? (
            <Panel title="4. Commit reviewed state" eyebrow="Exact reviewed diff SHA required">
              {!reviewed ? <p className="task-warning-text">Reload the reviewed diff in this session before commit. The server keeps the SHA gate, but Desktop requires the user-visible diff too.</p> : null}
              <label className="field"><span>Commit message</span><textarea value={commitMessage} rows={3} maxLength={16 * 1024} onChange={(event) => setCommitMessage(event.target.value)} placeholder="feat: describe guarded change" /></label>
              <button className="button" type="button" disabled={!reviewed || !commitMessage.trim() || busy === "commit"} onClick={() => void commitTask()}>{busy === "commit" ? "Committing…" : "Commit exact reviewed delta"}</button>
              {committed ? <p className="task-notice">Commit {committed.commit.commit} created on {committed.commit.branch}. Working tree clean: {String(committed.commit.clean)}.</p> : null}
            </Panel>
          ) : null}

          {!mutationBlocked && selected.lifecycle.phase === "committed" ? (
            <Panel title="5. Push exact task commit" eyebrow="Externally visible action · explicit confirmation required">
              <p>Remote <strong>{selectedWorkspace?.remote}</strong> · branch <strong>{selected.lifecycle.branch}</strong> · commit <code>{selected.lifecycle.commitSha}</code></p>
              <p className="muted">SourceNerve pushes only the persisted task commit. Desktop provides no force flag and no custom refspec.</p>
              <button className="button" type="button" disabled={busy === "push"} onClick={() => void pushTask()}>{busy === "push" ? "Pushing…" : "Push exact commit"}</button>
              {pushed ? <p className="task-notice">Pushed {pushed.push.head} to {pushed.push.remote}/{pushed.push.branch}.</p> : null}
            </Panel>
          ) : null}

          {selected.lifecycle.phase === "pushed" ? (
            <Panel title="Task pushed" eyebrow="Provider lifecycle remains separate">
              <p>Exact commit <code>{selected.lifecycle.pushSha}</code> is pushed on <strong>{selected.lifecycle.branch}</strong>.</p>
              <p className="muted">Issue / PR creation and merge are intentionally not part of this workflow. Those operations remain a separate guarded provider step.</p>
            </Panel>
          ) : null}

          <Panel title="Durable event timeline" eyebrow="Recovered from SourceNerve state">
            <div className="task-events">{selected.events.slice().reverse().map((event) => <article key={event.id}><strong>{event.eventType}</strong><span>{formatUnix(event.createdAt)}</span><pre>{JSON.stringify(event.metadata, null, 2)}</pre></article>)}</div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

function ProposalReview({ proposal, onApply, busy }: { proposal: SessionProposalReview; onApply(): void; busy: boolean }) {
  return (
    <div className="task-review-box">
      <h3>Reviewed proposal in this session</h3>
      <p><strong>Proposal:</strong> {proposal.proposal.id}</p>
      <p><strong>Patch SHA-256:</strong> <code>{proposal.proposal.patchSha256}</code></p>
      <p><strong>Changed paths:</strong> {proposal.proposal.changedPaths.join(", ") || "None"}</p>
      <h4>File expectations</h4>
      <ul>{proposal.expectedFiles.map((item) => <li key={item.path}>{item.path}: {item.sha256 ?? "new file / must not exist"}</li>)}</ul>
      <pre className="task-diff"><code>{proposal.patch}</code></pre>
      <button className="button button--danger" type="button" disabled={busy} onClick={onApply}>{busy ? "Applying…" : "Apply reviewed proposal"}</button>
    </div>
  );
}

function DiffBlock({ title, diff, sha }: { title: string; diff: string; sha?: string }) {
  return <div className="task-review-box"><h3>{title}</h3>{sha ? <p><strong>Diff SHA-256:</strong> <code>{sha}</code></p> : null}<pre className="task-diff"><code>{diff || "(empty diff)"}</code></pre></div>;
}

function ContextSnapshot({ pack }: { pack: IntelligenceContextPack }) {
  return <Panel title="Task context snapshot" eyebrow={`Graph v${pack.graphVersion} · ${pack.consistency}`}><div className="task-metrics"><TaskMetric label="HEAD" value={shortSha(pack.head)} /><TaskMetric label="Used bytes" value={String(pack.usedBytes)} /><TaskMetric label="Items" value={String(pack.items.length)} /><TaskMetric label="Clean" value={String(pack.clean)} /></div><div className="task-context-items">{pack.items.map((item) => <article key={`${item.path}:${item.startLine}`}><strong>{item.path}:{item.startLine}-{item.endLine}</strong><span>score {item.score}</span><ul>{item.reasons.slice(0, 6).map((reason, index) => <li key={`${reason.signal}-${index}`}>{reason.signal}: {reason.detail}</li>)}</ul></article>)}</div></Panel>;
}

function TaskPhaseRail({ phaseIndex }: { phaseIndex: number }) {
  return <div className="task-phase-rail">{PHASES.map((phase, index) => <span key={phase} className={index <= phaseIndex ? "task-phase task-phase--done" : "task-phase"}>{index + 1}. {phase}</span>)}</div>;
}

function TaskMetric({ label, value }: { label: string; value: string }) {
  return <div className="task-metric"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function suggestBranch(snapshot: DesktopTaskSnapshot): string {
  return `sourcenerve/task-${snapshot.task.id.slice(0, 8)}`;
}

function shortSha(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function formatUnix(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
