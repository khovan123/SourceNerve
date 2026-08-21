import { useEffect, useMemo, useState } from "react";

import type { DesktopTaskListItem } from "../../shared/task-api";
import type {
  ProviderMergeMethod,
  ProviderWorkflowState,
} from "../../shared/provider-workflow-api";
import { providerChangeLabel, providerLabel, shortProviderSha } from "../provider-workflow-view-model";
import { ProviderCompletionCard } from "./organisms/ProviderCompletionCard";
import { ProviderCreateActions } from "./organisms/ProviderCreateActions";
import { ProviderPullStateCard } from "./organisms/ProviderPullStateCard";
import { ProviderTaskState } from "./organisms/ProviderTaskState";
import { ProviderWorkflowHeader } from "./organisms/ProviderWorkflowHeader";

export function ProviderWorkflowScreen() {
  const [tasks, setTasks] = useState<DesktopTaskListItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [state, setState] = useState<ProviderWorkflowState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [pullTitle, setPullTitle] = useState("");
  const [pullBody, setPullBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [mergeMethod, setMergeMethod] = useState<ProviderMergeMethod>("squash");

  useEffect(() => {
    void loadTasks();
  }, []);

  useEffect(() => {
    if (selectedTaskId) void loadState(selectedTaskId);
    else setState(null);
  }, [selectedTaskId]);

  const selectedTask = useMemo(
    () => tasks.find((item) => item.taskId === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const pull = state?.pull;
  const exactHeadReady = Boolean(
    pull && state?.pullHeadSha && pull.headSha === state.pullHeadSha,
  );
  const mergeReady = Boolean(
    state &&
    pull &&
    state.lifecyclePhase === "pr_open" &&
    pull.state === "open" &&
    exactHeadReady &&
    pull.mergeable !== false,
  );

  async function loadTasks(): Promise<void> {
    setBusy("tasks");
    setError(null);
    const result = await window.sourcenerveDesktop.listDesktopTasks();
    if (result.ok) {
      setTasks(result.value);
      const first = result.value.find((item) => item.snapshot)?.taskId ?? "";
      setSelectedTaskId((current) => current || first);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function loadState(taskId = selectedTaskId): Promise<void> {
    if (!taskId) return;
    setBusy("state");
    setError(null);
    const result = await window.sourcenerveDesktop.getProviderWorkflowState(taskId);
    if (result.ok) {
      setState(result.value);
      if (!pullTitle && result.value.taskBranch) {
        setPullTitle(`SourceNerve task ${taskId.slice(0, 8)}`);
      }
    } else {
      setState(null);
      setError(result.error.message);
    }
    setBusy(null);
  }

  async function createIssue(): Promise<void> {
    if (!selectedTaskId || !issueTitle.trim()) return;
    setBusy("issue");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.createProviderIssue({
      taskId: selectedTaskId,
      title: issueTitle.trim(),
      body: issueBody,
    });
    if (result.ok) {
      setNotice(`${providerLabel(result.value.issue.provider)} issue #${result.value.issue.number} created${result.value.replayed ? " (replayed durable result)" : ""}.`);
      await loadState();
    } else setError(result.error.message);
    setBusy(null);
  }

  async function createPull(): Promise<void> {
    if (!selectedTaskId || !pullTitle.trim() || !state) return;
    const confirmed = window.confirm(
      `Create ${providerChangeLabel(state.provider)} from the exact pushed task commit?\n\nRepository: ${state.repository}\nHead branch: ${state.taskBranch}\nHead SHA: ${state.taskPushSha}\nBase: ${state.defaultBranch}\nDraft: ${String(draft)}`,
    );
    if (!confirmed) return;
    setBusy("pull-create");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.createProviderPull({
      taskId: selectedTaskId,
      title: pullTitle.trim(),
      body: pullBody,
      draft,
    });
    if (result.ok) {
      setNotice(`${providerChangeLabel(result.value.pull.provider)} #${result.value.pull.number} created at exact task head ${shortProviderSha(result.value.pull.headSha)}.`);
      await loadState();
    } else setError(result.error.message);
    setBusy(null);
  }

  async function refreshPull(): Promise<void> {
    if (!selectedTaskId) return;
    setBusy("pull-refresh");
    setError(null);
    const result = await window.sourcenerveDesktop.refreshProviderPull({ taskId: selectedTaskId });
    if (result.ok) {
      setState((current) => current ? { ...current, pull: result.value } : current);
      setNotice(`Provider state refreshed. Current head: ${result.value.headSha}.`);
    } else setError(result.error.message);
    setBusy(null);
  }

  async function mergePull(): Promise<void> {
    if (!selectedTaskId || !state || !pull || !mergeReady) return;
    const expectedHead = pull.headSha;
    const confirmed = window.confirm(
      `Merge ${providerChangeLabel(state.provider)} #${pull.number}?\n\nRepository: ${state.repository}\nBase: ${pull.baseBranch}\nHead branch: ${pull.headBranch}\nExpected head SHA: ${expectedHead}\nMethod: ${mergeMethod}\n\nSourceNerve will fetch provider state again and fail closed if the head changed. Required checks, reviews, and branch protection remain provider-owned constraints.`,
    );
    if (!confirmed) return;
    setBusy("merge");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.mergeProviderPull({
      taskId: selectedTaskId,
      expectedHeadSha: expectedHead,
      method: mergeMethod,
    });
    if (result.ok) {
      setNotice(`Merged at ${result.value.mergeSha}. Default branch is not synced locally until you choose Sync default branch.`);
      await loadState();
    } else {
      setError(result.error.message);
      await loadState();
    }
    setBusy(null);
  }

  async function syncDefault(): Promise<void> {
    if (!selectedTaskId || !state) return;
    const confirmed = window.confirm(
      `Sync local default branch after merge?\n\nRepository: ${state.repository}\nDefault branch: ${state.defaultBranch}\nMerge SHA: ${state.mergeSha}\n\nThis is a separate explicit SourceNerve lifecycle action.`,
    );
    if (!confirmed) return;
    setBusy("sync");
    setError(null);
    const result = await window.sourcenerveDesktop.syncProviderDefaultBranch(selectedTaskId);
    if (result.ok) {
      setNotice(`Default branch ${result.value.defaultBranch} synced to ${result.value.head}.`);
      await loadState();
    } else setError(result.error.message);
    setBusy(null);
  }

  return (
    <section className="space-y-4" aria-label="Guarded provider lifecycle">
      <ProviderWorkflowHeader error={error} notice={notice} />
      <ProviderTaskState
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        selectedWorkspace={selectedTask?.workspace}
        state={state}
        busy={busy}
        onSelectTask={setSelectedTaskId}
        onRefresh={() => void loadState()}
      />
      {state ? (
        <ProviderCreateActions
          state={state}
          issueTitle={issueTitle}
          issueBody={issueBody}
          pullTitle={pullTitle}
          pullBody={pullBody}
          draft={draft}
          busy={busy}
          onIssueTitle={setIssueTitle}
          onIssueBody={setIssueBody}
          onPullTitle={setPullTitle}
          onPullBody={setPullBody}
          onDraft={setDraft}
          onCreateIssue={() => void createIssue()}
          onCreatePull={() => void createPull()}
        />
      ) : null}
      {state?.pull ? (
        <ProviderPullStateCard
          state={state}
          exactHeadReady={exactHeadReady}
          mergeReady={mergeReady}
          mergeMethod={mergeMethod}
          busy={busy}
          onMergeMethod={setMergeMethod}
          onRefresh={() => void refreshPull()}
          onMerge={() => void mergePull()}
        />
      ) : null}
      {state ? <ProviderCompletionCard state={state} busy={busy} onSync={() => void syncDefault()} /> : null}
    </section>
  );
}
