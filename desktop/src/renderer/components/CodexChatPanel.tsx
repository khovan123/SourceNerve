import { useEffect, useMemo, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type { DesktopHarnessCodexSetupView, DesktopHarnessRunView } from "../../shared/harness-api";
import { Panel } from "./Panel";
import { ActionButton } from "./atoms/ActionButton";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export function CodexChatPanel({
  workspaces,
  runs,
  selectedRunId,
  onRunSelected,
  onChanged,
  onOpenWorkspaces,
}: {
  workspaces: ManagedWorkspaceView[];
  runs: DesktopHarnessRunView[];
  selectedRunId: string | null;
  onRunSelected(runId: string): Promise<void>;
  onChanged(): Promise<void>;
  onOpenWorkspaces(): void;
}) {
  const readyWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.validation.state === "ready" && workspace.access === "read-write" && workspace.localWritable),
    [workspaces],
  );
  const [setup, setSetup] = useState<DesktopHarnessCodexSetupView | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"setup" | "install" | "login" | "send" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void refreshSetup(); }, []);

  useEffect(() => {
    if (workspaceId && readyWorkspaces.some((workspace) => workspace.id === workspaceId)) return;
    const selectedWorkspace = runs.find((run) => run.id === selectedRunId)?.workspace;
    const next = readyWorkspaces.find((workspace) => workspace.id === selectedWorkspace)?.id ?? readyWorkspaces[0]?.id ?? "";
    setWorkspaceId(next);
  }, [readyWorkspaces, runs, selectedRunId, workspaceId]);

  const compatibleRun = useMemo(() => {
    const candidates = runs.filter((run) => run.workspace === workspaceId && isCodexCompatibleRun(run));
    return candidates.find((run) => run.id === selectedRunId) ?? candidates[0] ?? null;
  }, [runs, selectedRunId, workspaceId]);

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

  async function ensureRun(): Promise<DesktopHarnessRunView | null> {
    if (compatibleRun) return compatibleRun;
    if (!workspaceId) return null;
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspaceId,
      profile: "interactive-local",
      sandbox: "workspace-write",
    });
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    await onChanged();
    await onRunSelected(result.value.id);
    return result.value;
  }

  async function send(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy !== null) return;
    setError(null);
    setBusy("send");

    const currentSetup = setup ?? await refreshSetup(false);
    if (!currentSetup?.installed || !currentSetup.authenticated || currentSetup.accountType !== "chatgpt") {
      setError("Install Codex and sign in with ChatGPT before starting a Harness chat.");
      setBusy(null);
      return;
    }

    const run = await ensureRun();
    if (!run) {
      setError((current) => current ?? "Add a ready read-write workspace before starting a Harness chat.");
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
      setError("The Codex runtime is not using a ChatGPT login.");
      setBusy(null);
      return;
    }

    const userMessage: ChatMessage = { id: `user:${Date.now()}`, role: "user", text };
    setMessages((current) => [...current, userMessage]);
    setPrompt("");
    const result = await window.sourcenerveDesktop.runHarnessCodexTurn({ runId: run.id, prompt: text });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      await onChanged();
      return;
    }

    setThreadId(result.value.threadId);
    setMessages((current) => [...current, {
      id: `assistant:${result.value.turnId}`,
      role: "assistant",
      text: result.value.response?.trim() || `Codex turn ${result.value.status}.`,
    }]);
    setBusy(null);
    await onChanged();
  }

  const setupReady = setup?.installed && setup.authenticated && setup.accountType === "chatgpt";

  return (
    <Panel title="Chat with Codex" eyebrow="ChatGPT native lane">
      <div className="space-y-4">
        {error ? <p className="error-banner" role="alert">{error}</p> : null}

        <div className="grid gap-3 md:grid-cols-3">
          <SetupStep label="1 · Codex CLI" ready={Boolean(setup?.installed)} detail={setup?.installed ? `Installed${setup.version ? ` · ${setup.version}` : ""}` : "Install the official Codex CLI"} />
          <SetupStep label="2 · ChatGPT login" ready={Boolean(setupReady)} detail={setupReady ? "Signed in with ChatGPT" : setup?.accountType === "apiKey" ? "API-key login is not the ChatGPT lane" : "Sign in with your ChatGPT account"} />
          <SetupStep label="3 · Workspace" ready={readyWorkspaces.length > 0} detail={readyWorkspaces.length > 0 ? `${readyWorkspaces.length} ready workspace${readyWorkspaces.length === 1 ? "" : "s"}` : "Add a read-write workspace"} />
        </div>

        <div className="flex flex-wrap gap-2">
          {!setup?.installed ? <ActionButton onClick={() => void installCodex()} disabled={busy !== null || setup?.canInstall === false}>{busy === "install" ? "Installing Codex…" : "Install Codex"}</ActionButton> : null}
          {setup?.installed && !setupReady ? <ActionButton onClick={() => void loginCodex()} disabled={busy !== null}>{busy === "login" ? "Waiting for ChatGPT login…" : "Sign in with ChatGPT"}</ActionButton> : null}
          {!setup?.installed && setup?.canInstall === false ? <code className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">npm install -g @openai/codex</code> : null}
          <ActionButton variant="secondary" onClick={() => void refreshSetup()} disabled={busy !== null}>Check Codex</ActionButton>
          {readyWorkspaces.length === 0 ? <ActionButton variant="secondary" onClick={onOpenWorkspaces}>Add workspace</ActionButton> : null}
        </div>

        {readyWorkspaces.length > 0 ? (
          <label className="block max-w-xl text-xs font-medium text-foreground">
            Workspace
            <select className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm" value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setThreadId(null); setMessages([]); }} disabled={busy === "send"}>
              {readyWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </label>
        ) : null}

        <div className="rounded-2xl border border-border bg-background/55">
          <div className="max-h-[420px] min-h-48 space-y-3 overflow-auto p-4">
            {messages.length === 0 ? (
              <div className="grid min-h-40 place-items-center text-center">
                <div>
                  <p className="text-sm font-semibold text-foreground">Ask Codex to work in this workspace.</p>
                  <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">SourceNerve owns the workspace boundary and Harness policy. Git/provider mutations and native escalations still use exact one-shot approvals.</p>
                </div>
              </div>
            ) : messages.map((message) => (
              <article key={message.id} className={message.role === "user" ? "ml-auto max-w-[85%] rounded-2xl bg-primary px-4 py-3 text-primary-foreground" : "mr-auto max-w-[92%] rounded-2xl border border-border bg-card px-4 py-3 text-foreground"}>
                <p className="whitespace-pre-wrap text-sm leading-6">{message.text}</p>
              </article>
            ))}
          </div>
          <div className="border-t border-border p-3">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask Codex to inspect, edit, test, or explain this workspace…"
              rows={3}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
              disabled={busy === "send" || !setupReady || readyWorkspaces.length === 0}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">{threadId ? `Thread ${threadId}` : compatibleRun ? `Harness run ${compatibleRun.id}` : "A workspace-write Harness run will be created on first message."}</p>
              <ActionButton onClick={() => void send()} disabled={busy !== null || !prompt.trim() || !setupReady || readyWorkspaces.length === 0}>{busy === "send" ? "Codex is working…" : "Send"}</ActionButton>
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
