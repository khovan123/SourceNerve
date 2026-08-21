import { useEffect, useMemo, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type { IntelligenceContextPack } from "../../shared/intelligence-api";
import type {
  DesktopTaskApplyResult,
  DesktopTaskCommitResult,
  DesktopTaskFileExpectation,
  DesktopTaskListItem,
  DesktopTaskPushResult,
  DesktopTaskReviewResult,
  DesktopTaskSnapshot,
} from "../../shared/task-api";
import {
  suggestTaskBranch,
  TASK_PHASES,
  type TaskExpectationDraft,
  type TaskSessionProposalReview,
} from "../task-workflow-view-model";
import { TaskBranchStage } from "./organisms/TaskBranchStage";
import { TaskCommitStage } from "./organisms/TaskCommitStage";
import { TaskContextSnapshotCard } from "./organisms/TaskContextSnapshotCard";
import { TaskPatchStage } from "./organisms/TaskPatchStage";
import { TaskPushStage, TaskPushedCard } from "./organisms/TaskPushStage";
import { TaskReviewStage } from "./organisms/TaskReviewStage";
import { TaskStartResume } from "./organisms/TaskStartResume";
import { TaskSummaryCard } from "./organisms/TaskSummaryCard";
import { TaskTimelineCard } from "./organisms/TaskTimelineCard";
import { TaskWorkflowHeader } from "./organisms/TaskWorkflowHeader";

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
  const [expectations, setExpectations] = useState<TaskExpectationDraft[]>([
    { key: expectationKey++, path: "", newFile: false },
  ]);
  const [sessionProposal, setSessionProposal] = useState<TaskSessionProposalReview | null>(null);
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
  const phaseIndex = TASK_PHASES.indexOf(currentPhase as (typeof TASK_PHASES)[number]);

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
    setBranch(result.value.lifecycle.branch ?? suggestTaskBranch(result.value));
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
      setBranch(result.value.lifecycle.branch ?? suggestTaskBranch(result.value));
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
      setBranch(suggestTaskBranch(result.value.snapshot));
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
      setBranch(result.value.lifecycle.branch ?? suggestTaskBranch(result.value));
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

  function updateExpectation(key: number, update: Partial<TaskExpectationDraft>): void {
    setExpectations((items) => items.map((item) => item.key === key ? { ...item, ...update, sha256: update.path !== undefined || update.newFile !== undefined ? undefined : item.sha256, message: undefined } : item));
    setSessionProposal(null);
  }

  async function loadExpectationSha(item: TaskExpectationDraft): Promise<void> {
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
    <section className="space-y-4" aria-label="Durable SourceNerve task workflow">
      <TaskWorkflowHeader error={error} notice={notice} />
      <TaskStartResume
        eligibleWorkspaces={eligibleWorkspaces}
        tasks={tasks}
        selectedTaskId={selected?.task.id}
        newWorkspace={newWorkspace}
        contextQuery={contextQuery}
        contextMaxBytes={contextMaxBytes}
        contextMaxItems={contextMaxItems}
        openTaskId={openTaskId}
        busy={busy}
        onWorkspace={setNewWorkspace}
        onContextQuery={setContextQuery}
        onContextMaxBytes={setContextMaxBytes}
        onContextMaxItems={setContextMaxItems}
        onOpenTaskId={setOpenTaskId}
        onBegin={() => void beginTask()}
        onRemember={() => void rememberTask()}
        onSelectTask={(taskId) => void selectTask(taskId)}
      />

      {selected ? (
        <>
          <TaskSummaryCard
            selected={selected}
            writable={Boolean(writable)}
            phaseIndex={phaseIndex}
            busy={busy}
            onRefresh={() => void refreshTask()}
            onCancel={() => void cancelTask()}
          />
          {beginContext ? <TaskContextSnapshotCard pack={beginContext} /> : null}
          {!mutationBlocked && selected.lifecycle.phase === "snapshot" ? (
            <TaskBranchStage branch={branch} defaultBranch={selectedWorkspace?.defaultBranch} busy={busy} onBranch={setBranch} onCheckout={() => void checkoutBranch()} />
          ) : null}
          {!mutationBlocked && selected.lifecycle.phase === "branched" ? (
            <TaskPatchStage
              expectations={expectations}
              patch={patch}
              proposal={sessionProposal}
              durableProposalExists={latestProposal?.status === "proposed"}
              busy={busy}
              onExpectation={updateExpectation}
              onLoadSha={(item) => void loadExpectationSha(item)}
              onRemoveExpectation={(key) => { setExpectations((items) => items.filter((entry) => entry.key !== key)); setSessionProposal(null); }}
              onAddExpectation={() => { setExpectations((items) => [...items, { key: expectationKey++, path: "", newFile: false }]); setSessionProposal(null); }}
              onPatch={changePatch}
              onPropose={() => void proposePatch()}
              onApply={() => void applyProposal()}
            />
          ) : null}
          {!mutationBlocked && (selected.lifecycle.phase === "patched" || selected.lifecycle.phase === "reviewed") ? (
            <TaskReviewStage phase={selected.lifecycle.phase} applied={applied} reviewed={reviewed} busy={busy} onReview={() => void reviewTask()} />
          ) : null}
          {!mutationBlocked && selected.lifecycle.phase === "reviewed" ? (
            <TaskCommitStage reviewed={reviewed} commitMessage={commitMessage} committed={committed} busy={busy} onCommitMessage={setCommitMessage} onCommit={() => void commitTask()} />
          ) : null}
          {!mutationBlocked && selected.lifecycle.phase === "committed" ? (
            <TaskPushStage selected={selected} workspace={selectedWorkspace} pushed={pushed} busy={busy} onPush={() => void pushTask()} />
          ) : null}
          {selected.lifecycle.phase === "pushed" ? <TaskPushedCard selected={selected} /> : null}
          <TaskTimelineCard selected={selected} />
        </>
      ) : null}
    </section>
  );
}
