import { useEffect, useMemo, useRef, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  DesktopHarnessCodexConversationMessage,
  DesktopHarnessCodexSetupView,
  DesktopHarnessRunView,
} from "../../shared/harness-api";
import type {
  DesktopHarnessApprovalView,
  HarnessApprovalDecision,
} from "../../shared/harness-approval-api";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

const APPROVAL_POLL_MS = 750;

export function HarnessConversationPanel({
  workspaces,
  runs,
  selectedRunId,
  selectedRun,
  onRunSelected,
  onChanged,
  onOpenWorkspaces,
}: {
  workspaces: ManagedWorkspaceView[];
  runs: DesktopHarnessRunView[];
  selectedRunId: string | null;
  selectedRun: DesktopHarnessRunView | null;
  onRunSelected(runId: string): Promise<void>;
  onChanged(): Promise<void>;
  onOpenWorkspaces(): void;
}) {
  const readyWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.validation.state === "ready" && workspace.access === "read-write" && workspace.localWritable),
    [workspaces],
  );
  const previousSelectedRunId = useRef<string | null>(null);
  const [setup, setSetup] = useState<DesktopHarnessCodexSetupView | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<DesktopHarnessCodexConversationMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<DesktopHarnessApprovalView[]>([]);
  const [busy, setBusy] = useState<"setup" | "install" | "login" | "new-run" | "send" | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshSetup(); }, []);

  useEffect(() => {
    const selectedRunChanged = previousSelectedRunId.current !== selectedRunId;
    previousSelectedRunId.current = selectedRunId;
    const selectedWorkspace = runs.find((run) => run.id === selectedRunId)?.workspace;
    if (selectedRunChanged && selectedWorkspace && readyWorkspaces.some((workspace) => workspace.id === selectedWorkspace)) {
      if (workspaceId !== selectedWorkspace) setWorkspaceId(selectedWorkspace);
      return;
    }
    if (workspaceId && readyWorkspaces.some((workspace) => workspace.id === workspaceId)) return;
    const fallback = selectedWorkspace && readyWorkspaces.some((workspace) => workspace.id === selectedWorkspace)
      ? selectedWorkspace
      : readyWorkspaces[0]?.id ?? "";
    setWorkspaceId(fallback);
  }, [readyWorkspaces, runs, selectedRunId, workspaceId]);

  const workspaceRuns = useMemo(
    () => runs.filter((run) => run.workspace === workspaceId),
    [runs, workspaceId],
  );

  const selectedWorkspaceRun = useMemo(() => {
    if (!selectedRunId) return null;
    return workspaceRuns.find((run) => run.id === selectedRunId) ?? null;
  }, [selectedRunId, workspaceRuns]);

  const conversationRun = selectedRun?.id === selectedWorkspaceRun?.id ? selectedRun : selectedWorkspaceRun;
  const compatibleRun = conversationRun && isCodexCompatibleRun(conversationRun) ? conversationRun : null;
  const setupReady = setup?.installed && setup.authenticated && setup.accountType === "chatgpt";

  useEffect(() => {
    const run = selectedWorkspaceRun;
    if (!run) {
      setMessages([]);
      setThreadId(null);
      setApprovals([]);
      return undefined;
    }
    let cancelled = false;
    setHydrating(true);
    void window.sourcenerveDesktop.getHarnessCodexConversation({ runId: run.id }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error.message);
        setMessages([]);
        setThreadId(null);
      } else if (result.value.runId === run.id && result.value.workspace === run.workspace) {
        setMessages(result.value.messages);
        setThreadId(result.value.threadId ?? null);
      }
      setHydrating(false);
    });
    return () => { cancelled = true; };
  }, [selectedWorkspaceRun?.id, selectedWorkspaceRun?.workspace]);

  useEffect(() => {
    const run = selectedWorkspaceRun;
    if (!run || run.status !== "running") {
      setApprovals([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      const result = await window.sourcenerveDesktop.listHarnessApprovals({
        runId: run.id,
        status: "pending",
        limit: 100,
      });
      if (cancelled) return;
      if (result.ok) setApprovals(result.value);
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, APPROVAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedWorkspaceRun?.id, selectedWorkspaceRun?.status]);

  async function refreshSetup(showBusy = true): Promise<DesktopHarnessCodexSetupView | null> {
    if (showBusy) setBusy((current) => current ?? "setup");
    setError(null);
    const result = await window.sourcenerveDesktop.getHarnessCodexSetup();
    if (!result.ok) {
      setError(result.error.message);
      if (showBusy) setBusy(null);
      return null;
    }
    setSetup(result.value);
    if (showBusy) setBusy(null);
    return result.value;
  }

  async function installCodex(): Promise<void> {
    setBusy("install");
    setError(null);
    const result = await window.sourcenerveDesktop.installHarnessCodex();
    if (!result.ok) setError(result.error.message);
    else setSetup(result.value);
    setBusy(null);
  }

  async function loginCodex(): Promise<void> {
    setBusy("login");
    setError(null);
    const result = await window.sourcenerveDesktop.loginHarnessCodex();
    if (!result.ok) setError(result.error.message);
    else setSetup(result.value);
    setBusy(null);
  }

  async function hydrateConversation(run: DesktopHarnessRunView, reportError = true): Promise<void> {
    const result = await window.sourcenerveDesktop.getHarnessCodexConversation({ runId: run.id });
    if (!result.ok) {
      if (reportError) setError(result.error.message);
      return;
    }
    if (result.value.runId !== run.id || result.value.workspace !== run.workspace) {
      if (reportError) setError("Harness conversation no longer matches the selected run.");
      return;
    }
    setMessages(result.value.messages);
    setThreadId(result.value.threadId ?? null);
  }

  async function createConversation(showBusy = true): Promise<DesktopHarnessRunView | null> {
    if (!workspaceId) return null;
    if (showBusy) setBusy("new-run");
    setError(null);
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspaceId,
      profile: "interactive-local",
      sandbox: "workspace-write",
    });
    if (!result.ok) {
      setError(result.error.message);
      if (showBusy) setBusy(null);
      return null;
    }
    setMessages([]);
    setThreadId(null);
    setApprovals([]);
    await onChanged();
    await onRunSelected(result.value.id);
    if (showBusy) setBusy(null);
    return result.value;
  }

  async function ensureRun(): Promise<DesktopHarnessRunView | null> {
    if (compatibleRun) return compatibleRun;
    if (conversationRun) {
      setError("This Harness run can no longer continue native Codex turns. Start a new conversation to continue safely.");
      return null;
    }
    return createConversation(false);
  }

  async function changeWorkspace(nextWorkspaceId: string): Promise<void> {
    setWorkspaceId(nextWorkspaceId);
    setMessages([]);
    setThreadId(null);
    setApprovals([]);
    setError(null);
    const nextRun = runs.find((run) => run.workspace === nextWorkspaceId) ?? null;
    if (nextRun) await onRunSelected(nextRun.id);
  }

  async function switchRun(runId: string): Promise<void> {
    if (!runId || runId === selectedRunId) return;
    setError(null);
    setMessages([]);
    setThreadId(null);
    setApprovals([]);
    await onRunSelected(runId);
  }

  async function respondToApproval(approval: DesktopHarnessApprovalView, decision: HarnessApprovalDecision): Promise<void> {
    setApprovalBusy(approval.id);
    setError(null);
    const result = await window.sourcenerveDesktop.respondHarnessApproval({
      approvalId: approval.id,
      decision,
    });
    if (!result.ok) {
      setError(result.error.message);
    } else {
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      await onChanged();
    }
    setApprovalBusy(null);
  }

  async function send(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy !== null) return;
    setError(null);
    setBusy("send");

    const currentSetup = setup ?? await refreshSetup(false);
    if (!currentSetup?.installed || !currentSetup.authenticated || currentSetup.accountType !== "chatgpt") {
      setError("Install the native runtime and connect ChatGPT before starting a Harness conversation.");
      setBusy(null);
      return;
    }

    const run = await ensureRun();
    if (!run) {
      setError((current) => current ?? "Add a ready read-write workspace before starting a Harness conversation.");
      setBusy(null);
      return;
    }

    const account = await window.sourcenerveDesktop.getHarnessCodexAccount({ workspace: run.workspace });
    if (!account.ok) {
      setError(account.error.message);
      setBusy(null);
      return;
    }
    if (!account.value.authenticated || account.value.accountType !== "chatgpt") {
      setError("The native Codex runtime is not using a ChatGPT login.");
      setBusy(null);
      return;
    }

    const clientMessageId = `user:${window.crypto.randomUUID()}`;
    const optimistic: DesktopHarnessCodexConversationMessage = {
      id: clientMessageId,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setPrompt("");

    const result = await window.sourcenerveDesktop.runHarnessCodexTurn({
      runId: run.id,
      prompt: text,
      clientMessageId,
    });
    if (!result.ok) {
      setError(result.error.message);
      await hydrateConversation(run, false);
      setBusy(null);
      await onChanged();
      return;
    }

    setThreadId(result.value.threadId);
    await hydrateConversation(run, false);
    setBusy(null);
    await onChanged();
  }

  return (
    <Panel title="Harness conversation" eyebrow="Native Codex runtime">
      <div className="space-y-4">
        {error ? <p className="error-banner" role="alert">{error}</p> : null}

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground">Chat with Harness in the selected workspace.</p>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              Native Codex owns reasoning, thread history and built-in tools. SourceNerve owns workspace boundaries, execution policy, durable approvals, recovery and proof.
            </p>
          </div>
          {setupReady && readyWorkspaces.length > 0 ? <span className="status-pill">Native runtime ready</span> : null}
        </div>

        {!setupReady || readyWorkspaces.length === 0 ? (
          <div className="space-y-3 rounded-2xl border border-border bg-muted/15 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <SetupStep label="1 · Native runtime" ready={Boolean(setup?.installed)} detail={setup?.installed ? `Codex${setup.version ? ` ${setup.version}` : ""}` : "Install the official Codex CLI"} />
              <SetupStep label="2 · Account" ready={Boolean(setupReady)} detail={setupReady ? "ChatGPT connected" : setup?.accountType === "apiKey" ? "Sign in with ChatGPT instead of an API key" : "Connect your ChatGPT account"} />
              <SetupStep label="3 · Workspace" ready={readyWorkspaces.length > 0} detail={readyWorkspaces.length > 0 ? `${readyWorkspaces.length} writable workspace${readyWorkspaces.length === 1 ? "" : "s"}` : "Add a read-write workspace"} />
            </div>
            <div className="flex flex-wrap gap-2">
              {!setup?.installed ? <ActionButton onClick={() => void installCodex()} disabled={busy !== null || setup?.canInstall === false}>{busy === "install" ? "Installing Codex…" : "Install native runtime"}</ActionButton> : null}
              {setup?.installed && !setupReady ? <ActionButton onClick={() => void loginCodex()} disabled={busy !== null}>{busy === "login" ? "Waiting for ChatGPT login…" : "Connect ChatGPT"}</ActionButton> : null}
              {!setup?.installed && setup?.canInstall === false ? <code className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">npm install -g @openai/codex</code> : null}
              <ActionButton variant="secondary" onClick={() => void refreshSetup()} disabled={busy !== null}>Check runtime</ActionButton>
              {readyWorkspaces.length === 0 ? <ActionButton variant="secondary" onClick={onOpenWorkspaces}>Add workspace</ActionButton> : null}
            </div>
          </div>
        ) : null}

        {readyWorkspaces.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1.2fr)_auto] md:items-end">
            <label className="block text-xs font-medium text-foreground">
              Workspace
              <select
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                value={workspaceId}
                onChange={(event) => { void changeWorkspace(event.target.value); }}
                disabled={busy === "send" || busy === "new-run"}
              >
                {readyWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-medium text-foreground">
              Conversation / run
              <select
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                value={selectedWorkspaceRun?.id ?? ""}
                onChange={(event) => { void switchRun(event.target.value); }}
                disabled={busy === "send" || busy === "new-run" || workspaceRuns.length === 0}
              >
                {workspaceRuns.length === 0 ? <option value="">No conversation yet</option> : null}
                {workspaceRuns.map((run) => (
                  <option key={run.id} value={run.id}>{shortId(run.id)} · {run.status} · {run.profile}</option>
                ))}
              </select>
            </label>
            <ActionButton variant="secondary" onClick={() => void createConversation()} disabled={busy !== null || !setupReady}>
              {busy === "new-run" ? "Starting…" : "New conversation"}
            </ActionButton>
          </div>
        ) : null}

        {readyWorkspaces.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/15 px-3 py-2.5 text-[11px] text-muted-foreground">
            <span className="status-pill">{setupReady ? "Codex ready" : "Runtime required"}</span>
            <span>{conversationRun ? `Run ${shortId(conversationRun.id)}` : "Run starts on first message"}</span>
            <span>·</span>
            <span>{conversationRun ? `${conversationRun.profile} · ${conversationRun.sandbox}` : "interactive-local · workspace-write"}</span>
            <span>·</span>
            <span className={approvals.length > 0 ? "font-semibold text-warning" : ""}>Pending approvals: {approvals.length}</span>
            {threadId ? <><span>·</span><span>Thread {shortId(threadId)}</span></> : null}
          </div>
        ) : null}

        <div className="rounded-2xl border border-border bg-background/55">
          <div className="max-h-[520px] min-h-56 space-y-3 overflow-auto p-4">
            {hydrating ? <p className="text-center text-xs text-muted-foreground">Restoring conversation…</p> : null}
            {!hydrating && messages.length === 0 ? (
              <div className="grid min-h-40 place-items-center text-center">
                <div>
                  <p className="text-sm font-semibold text-foreground">Ask Harness to work in this workspace.</p>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">Native Codex performs the reasoning and tool work behind this conversation. Git/provider mutations and native escalations remain guarded by SourceNerve approvals.</p>
                </div>
              </div>
            ) : messages.map((message) => (
              <article key={message.id} className={message.role === "user" ? "ml-auto max-w-[85%] rounded-2xl bg-primary px-4 py-3 text-primary-foreground" : "mr-auto max-w-[92%] rounded-2xl border border-border bg-card px-4 py-3 text-foreground"}>
                <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
                <p className={message.role === "user" ? "mt-2 text-[10px] text-primary-foreground/70" : "mt-2 text-[10px] text-muted-foreground"}>{new Date(message.createdAt).toLocaleTimeString()}</p>
              </article>
            ))}

            {approvals.length > 0 ? (
              <div className="space-y-3 rounded-2xl border border-warning/35 bg-warning/5 p-4" role="status" aria-label="Pending Harness approvals">
                <div>
                  <p className="text-sm font-semibold text-foreground">Harness needs approval to continue</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">The native Codex turn is paused. Each decision is one-shot and remains bound to this exact run, workspace, Git HEAD and argument digest.</p>
                </div>
                {approvals.map((approval) => (
                  <article key={approval.id} className="rounded-xl border border-border bg-card/80 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground">{approval.tool}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{approval.capabilityId}</p>
                      </div>
                      <span className="status-pill">approval required</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                      <span>HEAD <code>{approval.headSha.slice(0, 12)}</code></span>
                      <span>Args <code>{approval.argumentSha256.slice(0, 16)}…</code></span>
                      {approval.externalRequestId ? <span>Native <code>{approval.externalRequestId}</code></span> : null}
                      <span>Expires {new Date(approval.expiresAt * 1000).toLocaleTimeString()}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton onClick={() => void respondToApproval(approval, "allow")} disabled={approvalBusy !== null}>Allow once</ActionButton>
                      <ActionButton variant="secondary" onClick={() => void respondToApproval(approval, "deny")} disabled={approvalBusy !== null}>Deny</ActionButton>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}

            {busy === "send" && approvals.length === 0 ? (
              <p className="mr-auto max-w-[92%] rounded-2xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">Harness is working with native Codex…</p>
            ) : null}
          </div>
          <div className="border-t border-border p-3">
            {conversationRun && !compatibleRun ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5">
                <p className="text-xs text-muted-foreground">This run is {conversationRun.status} or no longer compatible with native Codex execution. Its transcript remains readable.</p>
                <ActionButton variant="secondary" size="sm" onClick={() => void createConversation()} disabled={busy !== null}>Start new conversation</ActionButton>
              </div>
            ) : null}
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask Harness to inspect, edit, test, or explain this workspace…"
              rows={3}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
              disabled={busy === "send" || busy === "new-run" || !setupReady || readyWorkspaces.length === 0 || Boolean(conversationRun && !compatibleRun)}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">{threadId ? `Native thread ${threadId}` : compatibleRun ? `Harness run ${compatibleRun.id}` : "A workspace-write Harness run will be created on the first message."}</p>
              <ActionButton onClick={() => void send()} disabled={busy !== null || !prompt.trim() || !setupReady || readyWorkspaces.length === 0 || Boolean(conversationRun && !compatibleRun)}>{busy === "send" ? "Harness is working…" : "Send"}</ActionButton>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function isCodexCompatibleRun(run: DesktopHarnessRunView): boolean {
  return run.status === "running"
    && run.freshnessState === "current"
    && run.sandbox === "workspace-write"
    && run.policies.read === "allow"
    && run.policies.write === "allow"
    && run.policies.exec === "allow"
    && run.closedLoop.recoveryStatus !== "needed"
    && run.closedLoop.recoveryStatus !== "in-progress"
    && run.uncertainMutations === 0;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function SetupStep({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <div className={ready ? "rounded-xl border border-success/20 bg-success/5 p-3" : "rounded-xl border border-border bg-muted/20 p-3"}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-foreground">{label}</p>
        <span className="status-pill">{ready ? "Ready" : "Required"}</span>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}
