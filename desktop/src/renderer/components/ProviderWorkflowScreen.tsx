import { useEffect, useMemo, useState } from "react";

import type { DesktopTaskListItem } from "../../shared/task-api";
import type {
  ProviderMergeMethod,
  ProviderWorkflowState,
} from "../../shared/provider-workflow-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

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
      setNotice(`${providerChangeLabel(result.value.pull.provider)} #${result.value.pull.number} created at exact task head ${shortSha(result.value.pull.headSha)}.`);
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
    <div className="provider-workflow-shell">
      <Panel title="Provider lifecycle" eyebrow="Guarded issue / PR / MR operations">
        <div className="provider-workflow-callout">
          <strong>Provider constraints are authoritative.</strong>
          <span>Desktop never bypasses branch protection, required checks, reviews, provider permissions, or exact-head guards. Head mismatch requires Refresh and a new explicit confirmation.</span>
        </div>
        {error ? <p className="provider-workflow-error" role="alert">{error}</p> : null}
        {notice ? <p className="provider-workflow-notice">{notice}</p> : null}
      </Panel>

      <div className="provider-workflow-columns">
        <Panel title="Durable task" eyebrow="Provider operations require task context">
          <label className="field">
            <span>Task</span>
            <select value={selectedTaskId} disabled={busy === "tasks"} onChange={(event) => setSelectedTaskId(event.target.value)}>
              <option value="">Select a task</option>
              {tasks.map((item) => <option value={item.taskId} key={item.taskId}>{item.snapshot?.task.contextQuery || item.taskId} · {item.snapshot?.lifecycle.phase ?? "unavailable"}</option>)}
            </select>
          </label>
          <button className="button button--quiet" type="button" disabled={!selectedTaskId || busy === "state"} onClick={() => void loadState()}>{busy === "state" ? "Refreshing…" : "Refresh task/provider state"}</button>
          {selectedTask ? <p className="muted">Workspace: {selectedTask.workspace}</p> : null}
        </Panel>

        <Panel title="Current provider state" eyebrow="Rust task lifecycle + fresh provider observation">
          {state ? (
            <>
              <div className="provider-workflow-status-row">
                <StatusBadge label={providerLabel(state.provider)} tone="ready" />
                <StatusBadge label={`Task: ${state.lifecyclePhase}`} tone={state.lifecyclePhase === "merged" || state.lifecyclePhase === "completed" ? "ready" : "working"} />
                {pull ? <StatusBadge label={`${providerChangeLabel(state.provider)}: ${pull.state}${pull.draft ? " draft" : ""}`} tone={pull.state === "merged" ? "ready" : pull.state === "open" ? "working" : "warning"} /> : null}
              </div>
              <div className="provider-workflow-metrics">
                <Metric label="Repository" value={state.repository} />
                <Metric label="Default branch" value={state.defaultBranch} />
                <Metric label="Task branch" value={state.taskBranch ?? "—"} />
                <Metric label="Task push" value={state.taskPushSha ? shortSha(state.taskPushSha) : "—"} />
                <Metric label="PR/MR" value={state.pullNumber ? `#${state.pullNumber}` : "—"} />
                <Metric label="Recorded head" value={state.pullHeadSha ? shortSha(state.pullHeadSha) : "—"} />
              </div>
            </>
          ) : <p className="muted">Select a task with explicit provider configuration.</p>}
        </Panel>
      </div>

      {state ? (
        <div className="provider-workflow-columns">
          <Panel title="Create issue" eyebrow="From current task/workspace context">
            <label className="field"><span>Title</span><input value={issueTitle} maxLength={512} onChange={(event) => setIssueTitle(event.target.value)} /></label>
            <label className="field"><span>Body</span><textarea value={issueBody} rows={6} maxLength={64 * 1024} onChange={(event) => setIssueBody(event.target.value)} /></label>
            <button className="button" type="button" disabled={!issueTitle.trim() || busy === "issue"} onClick={() => void createIssue()}>{busy === "issue" ? "Creating…" : `Create ${providerLabel(state.provider)} issue`}</button>
          </Panel>

          <Panel title={`Create ${providerChangeLabel(state.provider)}`} eyebrow="Only from exact pushed task SHA">
            {state.lifecyclePhase !== "pushed" ? <p className="muted">Available only when task lifecycle is <strong>pushed</strong>. Current phase: {state.lifecyclePhase}.</p> : (
              <>
                <label className="field"><span>Title</span><input value={pullTitle} maxLength={512} onChange={(event) => setPullTitle(event.target.value)} /></label>
                <label className="field"><span>Body</span><textarea value={pullBody} rows={6} maxLength={64 * 1024} onChange={(event) => setPullBody(event.target.value)} /></label>
                <label className="provider-workflow-checkbox"><input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} /> Create as draft</label>
                <p className="muted">{state.taskBranch} @ <code>{state.taskPushSha}</code> → {state.defaultBranch}</p>
                <button className="button" type="button" disabled={!pullTitle.trim() || busy === "pull-create"} onClick={() => void createPull()}>{busy === "pull-create" ? "Creating…" : `Create ${providerChangeLabel(state.provider)}`}</button>
              </>
            )}
          </Panel>
        </div>
      ) : null}

      {state?.pull ? (
        <Panel title={`${providerChangeLabel(state.provider)} #${state.pull.number}`} eyebrow="Fresh provider state required before merge" actions={<button className="button button--quiet" type="button" disabled={busy === "pull-refresh"} onClick={() => void refreshPull()}>{busy === "pull-refresh" ? "Refreshing…" : "Refresh provider state"}</button>}>
          <div className="provider-workflow-metrics">
            <Metric label="State" value={`${state.pull.state}${state.pull.draft ? " · draft" : ""}`} />
            <Metric label="Base" value={state.pull.baseBranch} />
            <Metric label="Head branch" value={state.pull.headBranch} />
            <Metric label="Provider head" value={shortSha(state.pull.headSha)} />
            <Metric label="Recorded head" value={state.pullHeadSha ? shortSha(state.pullHeadSha) : "—"} />
            <Metric label="Mergeability" value={state.pull.mergeable === false ? "Blocked" : state.pull.mergeable === true ? "Provider says mergeable" : "Provider did not report"} />
          </div>
          {state.pull.mergeState ? <p><strong>Provider merge state:</strong> {state.pull.mergeState}</p> : null}
          {state.pull.url ? <p className="provider-workflow-url"><strong>Provider URL:</strong> <code>{state.pull.url}</code></p> : null}
          {!exactHeadReady && state.pull.state === "open" ? <p className="provider-workflow-error">Provider head <code>{state.pull.headSha}</code> differs from task-recorded head <code>{state.pullHeadSha ?? "missing"}</code>. Merge is disabled. Refresh task/provider state; Desktop will not substitute or guess a SHA.</p> : null}
          {state.pull.mergeable === false ? <p className="provider-workflow-error">Provider reports merge blocked{state.pull.mergeState ? `: ${state.pull.mergeState}` : "."} Required checks, reviews, branch protection, or permissions remain provider-owned constraints.</p> : null}

          {state.lifecyclePhase === "pr_open" ? (
            <div className="provider-workflow-merge-row">
              <label className="field"><span>Merge method</span><select value={mergeMethod} onChange={(event) => setMergeMethod(event.target.value as ProviderMergeMethod)}><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase</option></select></label>
              <button className="button button--danger" type="button" disabled={!mergeReady || busy === "merge"} onClick={() => void mergePull()}>{busy === "merge" ? "Merging…" : `Merge exact head ${shortSha(state.pull.headSha)}`}</button>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {state && state.lifecyclePhase === "merged" && state.mergeSha ? (
        <Panel title="Default branch sync" eyebrow="Separate explicit post-merge action">
          <p>Provider merge SHA: <code>{state.mergeSha}</code>. Local default branch <strong>{state.defaultBranch}</strong> has not been marked synced by this task yet.</p>
          <button className="button" type="button" disabled={busy === "sync"} onClick={() => void syncDefault()}>{busy === "sync" ? "Syncing…" : `Sync ${state.defaultBranch}`}</button>
        </Panel>
      ) : null}

      {state?.defaultSyncedHead ? <Panel title="Provider workflow complete" eyebrow="Merged + default branch synced"><p>Default branch <strong>{state.defaultBranch}</strong> synced to <code>{state.defaultSyncedHead}</code>.</p></Panel> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="provider-workflow-metric"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function providerLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function providerChangeLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "Pull Request" : "Merge Request";
}

function shortSha(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
