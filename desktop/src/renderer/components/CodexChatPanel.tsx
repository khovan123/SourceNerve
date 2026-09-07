import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, CircleX, Command, FolderOpen, LoaderCircle, Maximize2, Minimize2, ShieldCheck, Wrench } from "lucide-react";

import type { GitTransportValidation, ManagedWorkspaceView, WorkspaceAccess } from "../../shared/desktop-api";
import type {
  DesktopHarnessCodexConversationMessage,
  DesktopHarnessCodexConversationSummary,
  DesktopHarnessCodexSetupView,
  DesktopHarnessCodexStatusView,
  DesktopHarnessCodexUsageView,
  DesktopHarnessCommandView,
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
} from "../../shared/harness-api";
import type {
  DesktopHarnessApprovalView,
  HarnessApprovalDecision,
} from "../../shared/harness-approval-api";
import appIconUrl from "../../../assets/generated/icon.png";
import type { WorkspaceDraft } from "../workspace-view-model";
import { AgentOpsPanel } from "./AgentOpsPanel";
import { ActionButton } from "./atoms/ActionButton";

const APPROVAL_POLL_MS = 750;
const COMPOSER_LINE_HEIGHT_PX = 24;
const COMPOSER_VERTICAL_PADDING_PX = 12;
const COMPOSER_MAX_ROWS = 9;
const COMPOSER_EXPANDED_MIN_ROWS = 12;
const COMPOSER_EXPANDED_VIEWPORT_RATIO = 0.55;

type PermissionPresetId = "read-only" | "workspace-write" | "guarded" | "full-access";

const PERMISSION_PRESETS: Array<{ id: PermissionPresetId; label: string; profile: string; sandbox: "read-only" | "workspace-write" | "danger-full-access"; danger?: boolean }> = [
  { id: "read-only", label: "Read only", profile: "read-only-analysis", sandbox: "read-only" },
  { id: "workspace-write", label: "Workspace write", profile: "interactive-local", sandbox: "workspace-write" },
  { id: "guarded", label: "Guarded", profile: "guarded-durable", sandbox: "workspace-write" },
  { id: "full-access", label: "Full sandbox", profile: "interactive-local", sandbox: "danger-full-access", danger: true },
];

type SlashCommandItem = {
  command: string;
  label: string;
  requiresArgument: boolean;
};

type BangCommandEntry = {
  id: string;
  workspace: string;
  requestId: string;
  command: string;
  status: "running" | "completed" | "failed";
  createdAt: number;
  result?: DesktopHarnessCommandView;
  error?: string;
};

type BangCommandRequest = {
  entryId: string;
  workspace: string;
  requestId: string;
  command: string;
};

const SOURCENERVE_SLASH_COMMANDS: SlashCommandItem[] = [
  { command: "/new", label: "New conversation", requiresArgument: false },
  { command: "/resume", label: "Resume conversation", requiresArgument: false },
  { command: "/status", label: "Show native Codex plan and rate-limit reset status", requiresArgument: false },
  { command: "/usage", label: "Show native Codex token usage", requiresArgument: false },
  { command: "/clear all", label: "Delete all conversations in this workspace", requiresArgument: false },
  { command: "/permission", label: "Change Harness permission", requiresArgument: false },
  { command: "/run", label: "Show current run status, progress and permissions", requiresArgument: false },
  { command: "/run refresh", label: "Refresh current run", requiresArgument: false },
  { command: "/run cancel", label: "Cancel current run", requiresArgument: false },
  { command: "/harness agent", label: "Show SourceNerve Agent tools in chat", requiresArgument: false },
  { command: "/workspace add", label: "Add a repository workspace", requiresArgument: false },
  { command: "/workspace edit", label: "Edit the current workspace", requiresArgument: false },
  { command: "/workspace remove", label: "Remove a workspace from SourceNerve", requiresArgument: true },
  { command: "/workspace check", label: "Check the current workspace", requiresArgument: false },
  { command: "/workspace list", label: "Refresh workspace list in sidebar", requiresArgument: false },
  { command: "/workspace help", label: "Show workspace command syntax", requiresArgument: false },
];

const SLASH_COMMANDS: SlashCommandItem[] = SOURCENERVE_SLASH_COMMANDS;

export function HarnessConversationPanel({
  workspaces,
  runs,
  selectedRunId,
  selectedRun,
  selectedWorkspaceId,
  events,
  jobs,
  externalError,
  onRunSelected,
  onCancelRun,
  onCancelJob,
  onRefreshRun,
  onChanged,
  onWorkspaceSelected,
  onWorkspacesChanged,
}: {
  workspaces: ManagedWorkspaceView[];
  runs: DesktopHarnessRunView[];
  selectedRunId: string | null;
  selectedRun: DesktopHarnessRunView | null;
  selectedWorkspaceId: string | null;
  events: DesktopHarnessEventView[];
  jobs: DesktopHarnessJobView[];
  externalError?: string | null;
  onRunSelected(runId: string): Promise<void>;
  onCancelRun(): Promise<void>;
  onCancelJob(job: DesktopHarnessJobView): Promise<void>;
  onRefreshRun(): Promise<void>;
  onChanged(): Promise<void>;
  onWorkspaceSelected(workspaceId: string): void;
  onWorkspacesChanged(): Promise<void>;
}) {
  const readyWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.validation.state === "ready" && workspace.access === "read-write" && workspace.localWritable),
    [workspaces],
  );
  const workspaceId = selectedWorkspaceId ?? "";
  const selectedReadyWorkspace = readyWorkspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const [setup, setSetup] = useState<DesktopHarnessCodexSetupView | null>(null);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<DesktopHarnessCodexConversationMessage[]>([]);
  const [conversationSummaries, setConversationSummaries] = useState<DesktopHarnessCodexConversationSummary[]>([]);
  const [approvals, setApprovals] = useState<DesktopHarnessApprovalView[]>([]);
  const [bangCommands, setBangCommands] = useState<BangCommandEntry[]>([]);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeSelectionIndex, setResumeSelectionIndex] = useState(0);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionSelectionIndex, setPermissionSelectionIndex] = useState(0);
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [codexStatus, setCodexStatus] = useState<DesktopHarnessCodexStatusView | null>(null);
  const [codexUsage, setCodexUsage] = useState<DesktopHarnessCodexUsageView | null>(null);
  const [codexInfoPanel, setCodexInfoPanel] = useState<"status" | "usage" | null>(null);
  const [busy, setBusy] = useState<"setup" | "install" | "login" | "new-run" | "permission" | "workspace" | "run" | "clear" | "resume" | "codex-info" | "command" | "send" | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft | null>(null);
  const [workspaceFieldErrors, setWorkspaceFieldErrors] = useState<Record<string, string>>({});
  const [workspaceCheck, setWorkspaceCheck] = useState<{ workspace: ManagedWorkspaceView; result: GitTransportValidation } | null>(null);
  const [workspaceListOpen, setWorkspaceListOpen] = useState(false);
  const [workspaceHelpOpen, setWorkspaceHelpOpen] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerCanExpand, setComposerCanExpand] = useState(false);
  const commandSurfaceRef = useRef<HTMLDivElement | null>(null);
  const resumeMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { void refreshSetup(); }, []);

  useEffect(() => {
    setRunPanelOpen(false);
    setAgentPanelOpen(false);
    setCodexInfoPanel(null);
  }, [selectedWorkspaceId, selectedRunId]);

  useEffect(() => {
    setError(null);
    setWorkspaceNotice(null);
    setMessages([]);
    setApprovals([]);
    setBangCommands([]);
    setResumeOpen(false);
    setResumeSelectionIndex(0);
    setPermissionOpen(false);
    setPermissionSelectionIndex(0);
    setConversationSummaries([]);
    setWorkspaceDraft(null);
    setWorkspaceCheck(null);
    setWorkspaceListOpen(false);
    setWorkspaceHelpOpen(false);
    setWorkspaceFieldErrors({});
  }, [selectedWorkspaceId]);

  const workspaceRuns = useMemo(
    () => runs.filter((run) => run.workspace === workspaceId),
    [runs, workspaceId],
  );

  const resumeItems = useMemo(() => {
    const runsById = new Map(workspaceRuns.map((run) => [run.id, run]));
    return [...conversationSummaries]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((summary) => ({ ...summary, run: summary.runId ? runsById.get(summary.runId) ?? null : null }));
  }, [conversationSummaries, workspaceRuns]);

  const selectedWorkspaceRun = useMemo(() => {
    if (!selectedRunId) return null;
    return workspaceRuns.find((run) => run.id === selectedRunId) ?? null;
  }, [selectedRunId, workspaceRuns]);

  const conversationRun = selectedRun?.id === selectedWorkspaceRun?.id ? selectedRun : selectedWorkspaceRun;
  const compatibleRun = conversationRun && isCodexCompatibleRun(conversationRun) ? conversationRun : null;
  const activePermission = permissionForRun(conversationRun);
  const setupReady = setup?.installed && setup.authenticated && setup.accountType === "chatgpt";
  const slashQuery = prompt.trimStart();
  const slashNeedle = slashQuery.trimEnd();
  const slashSuggestions = slashQuery.startsWith("/")
    ? SLASH_COMMANDS
      .filter((item) => item.command.startsWith(slashNeedle))
      .sort((left, right) => Number(right.command === slashNeedle) - Number(left.command === slashNeedle))
    : [];
  const promptIsSlashCommand = slashQuery.startsWith("/");
  const bangCommandText = extractBangCommand(prompt);
  const promptIsBangCommand = bangCommandText !== null;
  const composerValue = promptIsBangCommand ? bangComposerValue(prompt) : prompt;
  const slashMenuVisible = slashSuggestions.length > 0 && promptIsSlashCommand && !resumeOpen && !permissionOpen;
  const activeResumeSelectionIndex = resumeItems.length === 0
    ? 0
    : Math.min(resumeSelectionIndex, resumeItems.length - 1);
  const activeSlashSelectionIndex = slashSuggestions.length === 0
    ? 0
    : Math.min(slashSelectionIndex, slashSuggestions.length - 1);

  useEffect(() => {
    setSlashSelectionIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (!resumeOpen || resumeItems.length === 0) return;
    const option = resumeMenuRef.current?.querySelector<HTMLElement>(`#resume-conversation-option-${activeResumeSelectionIndex}`);
    option?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeResumeSelectionIndex, resumeItems.length, resumeOpen]);

  useEffect(() => {
    if (!slashMenuVisible) return;
    const option = slashMenuRef.current?.querySelector<HTMLElement>(`#slash-command-option-${activeSlashSelectionIndex}`);
    option?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSlashSelectionIndex, slashMenuVisible]);

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    const minRows = promptIsBangCommand ? 1 : 2;
    const minHeight = (minRows * COMPOSER_LINE_HEIGHT_PX) + COMPOSER_VERTICAL_PADDING_PX;
    const collapsedMaxHeight = (COMPOSER_MAX_ROWS * COMPOSER_LINE_HEIGHT_PX) + COMPOSER_VERTICAL_PADDING_PX;
    const expandedMaxHeight = Math.max(collapsedMaxHeight, Math.floor(window.innerHeight * COMPOSER_EXPANDED_VIEWPORT_RATIO));
    const expandedMinHeight = Math.min(
      (COMPOSER_EXPANDED_MIN_ROWS * COMPOSER_LINE_HEIGHT_PX) + COMPOSER_VERTICAL_PADDING_PX,
      expandedMaxHeight,
    );

    textarea.style.height = "0px";
    const contentHeight = textarea.scrollHeight;
    const maxHeight = composerExpanded ? expandedMaxHeight : collapsedMaxHeight;
    const requestedHeight = composerExpanded ? Math.max(contentHeight, expandedMinHeight) : contentHeight;
    const nextHeight = Math.min(Math.max(requestedHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    setComposerCanExpand(composerExpanded || contentHeight > minHeight + (COMPOSER_LINE_HEIGHT_PX * 2));
  }, [composerExpanded, composerValue, promptIsBangCommand]);

  useEffect(() => {
    if (composerValue.length === 0) setComposerExpanded(false);
  }, [composerValue]);
  const activityItems = useMemo(() => buildActivityItems(events, jobs), [events, jobs]);
  const latestContextRoute = useMemo(() => {
    const event = [...events].reverse().find((item) => item.eventType === "context/gate");
    if (!event) return null;
    return {
      route: summaryField(event.summary, "route") ?? "unknown",
      retrieve: summaryField(event.summary, "retrieve") === "true",
      queryBytes: summaryField(event.summary, "query_bytes"),
    };
  }, [events]);
  const feedItems = useMemo(() => buildConversationFeed(messages, activityItems, bangCommands), [messages, activityItems, bangCommands]);
  const activeJobs = jobs.filter((job) => job.status === "active" || job.status === "pending");
  const runningToolCount = activityItems.filter((item) => item.kind === "tool" && item.status === "running").length;
  const visibleError = error ?? externalError ?? null;
  const commandSurfaceActive = Boolean(
    visibleError
      || workspaceNotice
      || codexInfoPanel
      || runPanelOpen
      || agentPanelOpen
      || workspaceDraft
      || workspaceCheck
      || workspaceListOpen
      || workspaceHelpOpen,
  );

  useEffect(() => {
    if (!commandSurfaceActive) return;
    const frame = window.requestAnimationFrame(() => {
      commandSurfaceRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    commandSurfaceActive,
    visibleError,
    workspaceNotice,
    codexInfoPanel,
    runPanelOpen,
    agentPanelOpen,
    workspaceDraft?.id,
    workspaceCheck?.result.message,
    workspaceListOpen,
    workspaceHelpOpen,
  ]);

  useEffect(() => {
    const run = selectedWorkspaceRun;
    if (!run) {
      setMessages([]);
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
        } else if (result.value.runId === run.id && result.value.workspace === run.workspace) {
        setMessages(result.value.messages);
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
  }

  async function loadConversationSummaries(): Promise<DesktopHarnessCodexConversationSummary[] | null> {
    if (!workspaceId) return [];
    setResumeLoading(true);
    const result = await window.sourcenerveDesktop.listHarnessCodexConversations({ workspace: workspaceId });
    setResumeLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    const sorted = [...result.value].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const currentIndex = sorted.findIndex((summary) => Boolean(summary.runId && summary.runId === selectedRunId));
    setResumeSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
    setConversationSummaries(result.value);
    return result.value;
  }

  async function clearWorkspaceConversations(): Promise<void> {
    if (!workspaceId) {
      setError("Choose a workspace before clearing conversations.");
      return;
    }
    setError(null);
    setWorkspaceNotice(null);
    const summaries = await loadConversationSummaries();
    const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? workspaceId;
    const conversationCount = summaries?.length ?? workspaceRuns.length;
    if (conversationCount === 0) {
      setResumeOpen(false);
      setWorkspaceNotice(`No saved conversations in “${workspaceName}”.`);
      return;
    }
    if (!window.confirm(`Delete all ${conversationCount} saved conversation${conversationCount === 1 ? "" : "s"} from “${workspaceName}”? This permanently deletes the native Codex conversations for this workspace. Harness audit runs are kept.`)) return;

    setBusy("clear");
    const result = await window.sourcenerveDesktop.clearHarnessCodexConversations({ workspace: workspaceId });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }
    setConversationSummaries([]);
    setMessages([]);
    setApprovals([]);
    setResumeOpen(false);
    setPermissionOpen(false);
    setRunPanelOpen(false);
    setAgentPanelOpen(false);
    setWorkspaceNotice(`Cleared ${result.value.deleted} conversation${result.value.deleted === 1 ? "" : "s"} from “${workspaceName}”. Harness audit runs are kept.`);
    setBusy(null);
    await onChanged();
  }

  async function createConversation(showBusy = true): Promise<DesktopHarnessRunView | null> {
    if (!workspaceId) return null;
    if (showBusy) setBusy("new-run");
    setError(null);
    setResumeOpen(false);
    setPermissionOpen(false);
    const inheritedPermission = conversationRun ? permissionForRun(conversationRun) : null;
    const inheritedPreset = inheritedPermission
      ? PERMISSION_PRESETS.find((preset) => preset.id === inheritedPermission) ?? null
      : null;
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspaceId,
      profile: inheritedPreset?.profile ?? "interactive-local",
      sandbox: inheritedPreset?.sandbox ?? "workspace-write",
    });
    if (!result.ok) {
      setError(result.error.message);
      if (showBusy) setBusy(null);
      return null;
    }
    setMessages([]);
    setApprovals([]);
    await onChanged();
    await onRunSelected(result.value.id);
    if (showBusy) setBusy(null);
    return result.value;
  }

  async function ensureRun(): Promise<DesktopHarnessRunView | null> {
    if (compatibleRun) return compatibleRun;
    if (conversationRun && runRequiresOperatorResolution(conversationRun)) {
      setError("Resolve the current Harness approval, recovery, or uncertain mutation before continuing.");
      return null;
    }
    // Normal prompts should never require /new. If the selected conversation is
    // finished or stale, start a fresh native Codex/Harness conversation and
    // submit the prompt there while preserving the current permission preset.
    return createConversation(false);
  }

  async function resumeNativeConversation(threadId: string): Promise<void> {
    if (!workspaceId || busy !== null) return;
    setBusy("resume");
    setError(null);
    setWorkspaceNotice(null);
    setMessages([]);
    setApprovals([]);
    setPermissionOpen(false);
    try {
      const result = await window.sourcenerveDesktop.resumeHarnessCodexConversation({ workspace: workspaceId, threadId });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMessages(result.value.messages);
      setResumeOpen(false);
      await onChanged();
      await onRunSelected(result.value.runId);
    } finally {
      setBusy(null);
    }
  }

  async function applyPermission(preset: (typeof PERMISSION_PRESETS)[number]): Promise<void> {
    const workspace = readyWorkspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) {
      setError("Choose a ready workspace before changing permission.");
      return;
    }
    if (conversationRun && permissionForRun(conversationRun) === preset.id) {
      setPermissionOpen(false);
      setPrompt("");
      return;
    }
    if (preset.danger && !window.confirm("Switch this workspace to the full sandbox? Codex filesystem/process confinement is removed. Protected Git/provider mutations remain guarded by SourceNerve, and native approval callbacks still route through Harness.")) return;

    setBusy("permission");
    setError(null);
    setResumeOpen(false);
    setPermissionOpen(false);
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspace.id,
      profile: preset.profile,
      sandbox: preset.sandbox,
    });
    if (!result.ok) {
      setError(result.error.message);
      setBusy(null);
      return;
    }

    setMessages([]);
    setApprovals([]);
    setPrompt("");
    await onChanged();
    await onRunSelected(result.value.id);
    setBusy(null);
  }

  function closeInlineCommandPanels(): void {
    setCodexInfoPanel(null);
    setRunPanelOpen(false);
    setAgentPanelOpen(false);
    setWorkspaceDraft(null);
    setWorkspaceFieldErrors({});
    setWorkspaceCheck(null);
    setWorkspaceListOpen(false);
    setWorkspaceHelpOpen(false);
  }

  function beginWorkspaceEdit(workspace: ManagedWorkspaceView): void {
    closeInlineCommandPanels();
    setWorkspaceDraft({
      originalId: workspace.id,
      id: workspace.id,
      name: workspace.name,
      access: workspace.access,
      remote: workspace.remote,
      defaultBranch: workspace.defaultBranch,
      root: workspace.root,
    });
    setWorkspaceFieldErrors({});
  }

  async function chooseWorkspaceDraftRepository(): Promise<void> {
    if (!workspaceDraft || busy !== null) return;
    setBusy("workspace");
    setError(null);
    setWorkspaceNotice(null);
    try {
      const picked = await window.sourcenerveDesktop.pickWorkspaceRepository();
      if (!picked.ok) {
        setError(picked.error.message);
        return;
      }
      if (!picked.value) return;
      const selection = picked.value;
      setWorkspaceDraft((current) => current ? {
        ...current,
        selection,
        root: selection.root,
        remote: selection.remote,
        defaultBranch: selection.defaultBranch,
        access: current.access === "read-write" && !selection.localWritable ? "read-only" : current.access,
      } : current);
      setWorkspaceFieldErrors({});
    } catch (actionError) {
      setError(commandError(actionError, "Repository selection could not be opened."));
    } finally {
      setBusy(null);
    }
  }

  async function saveWorkspaceDraft(): Promise<void> {
    const draft = workspaceDraft;
    if (!draft || busy !== null) return;
    setBusy("workspace");
    setError(null);
    setWorkspaceNotice(null);
    setWorkspaceFieldErrors({});
    try {
      const saved = await window.sourcenerveDesktop.saveWorkspace({
        ...(draft.originalId ? { originalId: draft.originalId } : {}),
        ...(draft.selection ? { selectionId: draft.selection.selectionId } : {}),
        id: draft.id.trim(),
        name: draft.name.trim(),
        access: draft.access,
        remote: draft.remote.trim(),
        defaultBranch: draft.defaultBranch.trim(),
      });
      if (!saved.ok) {
        setError(saved.error.message);
        setWorkspaceFieldErrors(saved.error.fieldDetails ?? {});
        return;
      }
      const originalId = draft.originalId;
      setWorkspaceDraft(null);
      await onWorkspacesChanged();
      if (originalId && selectedWorkspaceId === originalId) onWorkspaceSelected(saved.value.id);
      setWorkspaceNotice(`Workspace “${saved.value.name}” updated.`);
    } catch (actionError) {
      setError(commandError(actionError, "Workspace could not be updated."));
    } finally {
      setBusy(null);
    }
  }

  async function executeWorkspaceCommand(text: string): Promise<void> {
    const parsed = parseWorkspaceCommand(text);
    setPrompt("");
    setResumeOpen(false);
    setPermissionOpen(false);
    setError(null);
    setWorkspaceNotice(null);

    if (!parsed.ok) {
      closeInlineCommandPanels();
      setError(parsed.error);
      return;
    }

    const { action, positionals, options, switches } = parsed;
    if (action === "help") {
      closeInlineCommandPanels();
      setWorkspaceHelpOpen(true);
      return;
    }

    if (action === "list") {
      if (positionals.length > 0 || Object.keys(options).length > 0 || switches.size > 0) {
        closeInlineCommandPanels();
        setError("Usage: /workspace list");
        return;
      }
      closeInlineCommandPanels();
      setBusy("workspace");
      try {
        await onWorkspacesChanged();
        setWorkspaceListOpen(true);
      } catch (actionError) {
        setError(commandError(actionError, "Workspace list could not be refreshed."));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (action === "add") {
      closeInlineCommandPanels();
      if (positionals.length > 0 || switches.has("pick")) {
        setError("Usage: /workspace add [--id ID] [--name NAME] [--access read-write|read-only] [--remote REMOTE] [--branch BRANCH]");
        return;
      }
      const requestedAccess = workspaceAccess(options.access);
      if (options.access && !requestedAccess) {
        setError("Workspace access must be read-write or read-only.");
        return;
      }
      setBusy("workspace");
      try {
        const picked = await window.sourcenerveDesktop.pickWorkspaceRepository();
        if (!picked.ok) {
          setError(picked.error.message);
          return;
        }
        if (!picked.value) {
          setWorkspaceNotice("Workspace add cancelled.");
          return;
        }
        const selection = picked.value;
        const access = requestedAccess ?? (selection.localWritable ? "read-write" : "read-only");
        const saved = await window.sourcenerveDesktop.saveWorkspace({
          selectionId: selection.selectionId,
          id: options.id ?? selection.suggestedId,
          name: options.name ?? selection.suggestedName,
          access,
          remote: options.remote ?? selection.remote,
          defaultBranch: options.branch ?? selection.defaultBranch,
        });
        if (!saved.ok) {
          setError(saved.error.message);
          return;
        }
        await onWorkspacesChanged();
        if (saved.value.validation.state === "ready" && saved.value.access === "read-write" && saved.value.localWritable) {
          onWorkspaceSelected(saved.value.id);
        }
        setWorkspaceNotice(`Workspace “${saved.value.name}” added. Use the core sidebar to switch to it.`);
      } catch (actionError) {
        setError(commandError(actionError, "Workspace could not be added."));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (action === "edit") {
      if (positionals.length > 1) {
        closeInlineCommandPanels();
        setError("Usage: /workspace edit [ID] [--id NEW_ID] [--name NAME] [--access read-write|read-only] [--remote REMOTE] [--branch BRANCH] [--pick]");
        return;
      }
      const workspaceIdToEdit = positionals[0] ?? selectedWorkspaceId;
      if (!workspaceIdToEdit) {
        closeInlineCommandPanels();
        setError("Choose a workspace first, or use /workspace edit ID.");
        return;
      }
      const workspace = workspaces.find((item) => item.id === workspaceIdToEdit);
      if (!workspace) {
        closeInlineCommandPanels();
        setError(`Workspace “${workspaceIdToEdit}” was not found.`);
        return;
      }
      const requestedAccess = workspaceAccess(options.access);
      if (options.access && !requestedAccess) {
        closeInlineCommandPanels();
        setError("Workspace access must be read-write or read-only.");
        return;
      }

      const hasDirectChanges = Object.keys(options).length > 0 || switches.size > 0;
      if (!hasDirectChanges) {
        beginWorkspaceEdit(workspace);
        return;
      }

      closeInlineCommandPanels();
      setBusy("workspace");
      try {
        const picked = switches.has("pick") ? await window.sourcenerveDesktop.pickWorkspaceRepository() : null;
        if (picked && !picked.ok) {
          setError(picked.error.message);
          return;
        }
        if (picked?.ok && !picked.value) {
          setWorkspaceNotice("Workspace repository change cancelled.");
          return;
        }
        const selection = picked?.ok ? picked.value : null;
        const access = requestedAccess ?? (selection && !selection.localWritable ? "read-only" : workspace.access);
        const saved = await window.sourcenerveDesktop.saveWorkspace({
          originalId: workspace.id,
          ...(selection ? { selectionId: selection.selectionId } : {}),
          id: options.id ?? workspace.id,
          name: options.name ?? workspace.name,
          access,
          remote: options.remote ?? selection?.remote ?? workspace.remote,
          defaultBranch: options.branch ?? selection?.defaultBranch ?? workspace.defaultBranch,
        });
        if (!saved.ok) {
          setError(saved.error.message);
          return;
        }
        await onWorkspacesChanged();
        if (selectedWorkspaceId === workspace.id) onWorkspaceSelected(saved.value.id);
        setWorkspaceNotice(`Workspace “${saved.value.name}” updated.`);
      } catch (actionError) {
        setError(commandError(actionError, "Workspace could not be updated."));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (action === "remove") {
      closeInlineCommandPanels();
      const workspaceIdToRemove = positionals[0] ?? selectedWorkspaceId;
      if (!workspaceIdToRemove || positionals.length > 1 || Object.keys(options).length > 0 || switches.size > 0) {
        setError("Usage: /workspace remove [ID]");
        return;
      }
      const workspace = workspaces.find((item) => item.id === workspaceIdToRemove);
      if (!workspace) {
        setError(`Workspace “${workspaceIdToRemove}” was not found.`);
        return;
      }
      if (!window.confirm(`Remove workspace “${workspace.name}” from SourceNerve? Repository files will not be deleted.`)) return;
      setBusy("workspace");
      try {
        const removed = await window.sourcenerveDesktop.removeWorkspace(workspace.id);
        if (!removed.ok) {
          setError(removed.error.message);
          return;
        }
        await onWorkspacesChanged();
        setWorkspaceNotice(removed.value.removed ? `Workspace “${workspace.name}” removed.` : `Workspace “${workspace.name}” was already absent.`);
      } catch (actionError) {
        setError(commandError(actionError, "Workspace could not be removed."));
      } finally {
        setBusy(null);
      }
      return;
    }

    if (action === "check") {
      if (positionals.length > 1 || Object.keys(options).length > 0 || switches.size > 0) {
        closeInlineCommandPanels();
        setError("Usage: /workspace check [ID]");
        return;
      }
      const workspaceIdToCheck = positionals[0] ?? selectedWorkspaceId;
      if (!workspaceIdToCheck) {
        closeInlineCommandPanels();
        setError("Choose a workspace first, or use /workspace check ID.");
        return;
      }
      const workspace = workspaces.find((item) => item.id === workspaceIdToCheck);
      if (!workspace) {
        closeInlineCommandPanels();
        setError(`Workspace “${workspaceIdToCheck}” was not found.`);
        return;
      }
      closeInlineCommandPanels();
      setBusy("workspace");
      try {
        const checked = await window.sourcenerveDesktop.validateGitTransport(workspaceIdToCheck);
        if (!checked.ok) {
          setError(checked.error.message);
          return;
        }
        setWorkspaceCheck({ workspace, result: checked.value });
      } catch (actionError) {
        setError(commandError(actionError, "Git transport could not be checked."));
      } finally {
        setBusy(null);
      }
      return;
    }

    closeInlineCommandPanels();
    setError("Unknown workspace command. Use /workspace help.");
  }

  async function executeSlashCommand(text: string): Promise<boolean> {
    if (!text.trimStart().startsWith("/")) return false;
    const [command, argument] = tokenizeSlashCommand(text);
    if (command === "/workspace") {
      await executeWorkspaceCommand(text);
      return true;
    }
    if (command === "/new") {
      closeInlineCommandPanels();
      setPrompt("");
      setResumeOpen(false);
      setPermissionOpen(false);
      await createConversation();
      return true;
    }
    if (command === "/resume") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setWorkspaceNotice(null);
      setPermissionOpen(false);
      setResumeSelectionIndex(0);
      setResumeOpen(true);
      void loadConversationSummaries();
      return true;
    }
    if (command === "/status") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setWorkspaceNotice(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      if (!workspaceId) {
        setError("Choose a workspace before reading Codex status.");
        return true;
      }
      setBusy("codex-info");
      try {
        if (typeof window.sourcenerveDesktop.getHarnessCodexStatus !== "function") {
          setError("SourceNerve Desktop needs to restart to load the native Codex status bridge.");
          return true;
        }
        const result = await window.sourcenerveDesktop.getHarnessCodexStatus({ workspace: workspaceId });
        if (!result.ok) {
          setError(result.error.message);
          return true;
        }
        setCodexStatus(result.value);
        setCodexInfoPanel("status");
      } catch (infoError) {
        setError(commandError(infoError, "Codex status could not be loaded."));
      } finally {
        setBusy(null);
      }
      return true;
    }
    if (command === "/usage") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setWorkspaceNotice(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      if (!workspaceId) {
        setError("Choose a workspace before reading Codex usage.");
        return true;
      }
      setBusy("codex-info");
      try {
        if (typeof window.sourcenerveDesktop.getHarnessCodexUsage !== "function") {
          setError("SourceNerve Desktop needs to restart to load the native Codex usage bridge.");
          return true;
        }
        const result = await window.sourcenerveDesktop.getHarnessCodexUsage({
          workspace: workspaceId,
          ...(conversationRun ? { runId: conversationRun.id } : {}),
        });
        if (!result.ok) {
          setError(result.error.message);
          return true;
        }
        setCodexUsage(result.value);
        setCodexInfoPanel("usage");
      } catch (infoError) {
        setError(commandError(infoError, "Codex usage could not be loaded."));
      } finally {
        setBusy(null);
      }
      return true;
    }
    if (command === "/clear") {
      closeInlineCommandPanels();
      setPrompt("");
      setResumeOpen(false);
      setPermissionOpen(false);
      if (!argument) {
        await createConversation();
        return true;
      }
      if (argument !== "all") {
        setError("Use /clear to start fresh or /clear all to delete every saved conversation in this workspace.");
        return true;
      }
      await clearWorkspaceConversations();
      return true;
    }
    if (command === "/permission") {
      closeInlineCommandPanels();
      setError(null);
      setWorkspaceNotice(null);
      setResumeOpen(false);
      if (!argument) {
        setPrompt("");
        const currentIndex = PERMISSION_PRESETS.findIndex((item) => item.id === activePermission);
        setPermissionSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
        setPermissionOpen(true);
        return true;
      }
      const normalized = argument === "danger-full-access" ? "full-access" : argument;
      const preset = PERMISSION_PRESETS.find((item) => item.id === normalized);
      if (!preset) {
        setError("Unknown permission. Use read-only, workspace-write, guarded, or full-access.");
        return true;
      }
      await applyPermission(preset);
      return true;
    }
    if (command === "/run") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setWorkspaceNotice(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      if (!conversationRun) {
        setError("There is no Harness run for this workspace yet.");
        return true;
      }
      if (!argument || argument === "status") {
        setRunPanelOpen(true);
        return true;
      }
      if (argument === "hide") {
        setRunPanelOpen(false);
        return true;
      }
      if (argument === "refresh") {
        setBusy("run");
        await onRefreshRun();
        setBusy(null);
        setRunPanelOpen(true);
        return true;
      }
      if (argument === "cancel") {
        if (conversationRun.status !== "running") {
          setError(`This Harness run is ${conversationRun.status} and cannot be cancelled.`);
          return true;
        }
        setBusy("run");
        await onCancelRun();
        await onRefreshRun();
        setBusy(null);
        setRunPanelOpen(true);
        return true;
      }
      setError("Unknown /run action. Use /run, /run refresh, /run cancel, or /run hide.");
      return true;
    }
    if (command === "/harness" && argument === "agent") {
      closeInlineCommandPanels();
      const harnessTokens = tokenizeSlashCommand(text);
      setPrompt("");
      setError(null);
      setWorkspaceNotice(null);
      if (!conversationRun) {
        setError("There is no Harness run for Agent tools yet.");
        return true;
      }
      setAgentPanelOpen(harnessTokens[2] !== "hide");
      return true;
    }
    if (command?.startsWith("/")) {
      closeInlineCommandPanels();
      setError(`Unknown SourceNerve command “${command}”. Codex TUI slash commands are not mirrored in Desktop; native Codex capabilities stay owned by the app-server.`);
      return true;
    }
    return false;
  }

  function chooseSlashSuggestion(item: SlashCommandItem): void {
    setSlashSelectionIndex(0);
    setPrompt(item.requiresArgument ? `${item.command} ` : item.command);
  }

  function updateBangCommand(entryId: string, update: Partial<BangCommandEntry>): void {
    setBangCommands((current) => current.map((entry) => entry.id === entryId ? { ...entry, ...update } : entry));
  }

  async function dispatchBangCommand(request: BangCommandRequest): Promise<void> {
    setBusy("command");
    try {
      const result = await window.sourcenerveDesktop.runHarnessCommand({
        workspace: request.workspace,
        command: request.command,
        requestId: request.requestId,
      });
      if (!result.ok) {
        updateBangCommand(request.entryId, { status: "failed", error: result.error.message });
        return;
      }
      updateBangCommand(request.entryId, {
        status: result.value.success === false ? "failed" : "completed",
        result: result.value,
        error: undefined,
      });
    } catch (commandFailure) {
      updateBangCommand(request.entryId, { status: "failed", error: commandError(commandFailure, "Workspace command failed.") });
    } finally {
      setBusy(null);
    }
  }

  async function executeBangCommand(text: string): Promise<void> {
    const command = extractBangCommand(text);
    if (command === null) return;
    if (!command) {
      setError("Type a command after !.");
      return;
    }
    closeInlineCommandPanels();
    setError(null);
    setWorkspaceNotice(null);
    setResumeOpen(false);
    setPermissionOpen(false);

    if (!selectedReadyWorkspace) {
      setError("Add a ready read-write workspace before running a command.");
      return;
    }
    const request: BangCommandRequest = {
      entryId: `bang:${window.crypto.randomUUID()}`,
      workspace: selectedReadyWorkspace.id,
      requestId: `bang:${window.crypto.randomUUID()}`,
      command,
    };
    setBangCommands((current) => [...current.slice(-19), {
      id: request.entryId,
      workspace: request.workspace,
      requestId: request.requestId,
      command: request.command,
      status: "running",
      createdAt: Date.now(),
    }]);
    setPrompt("");
    await dispatchBangCommand(request);
    await onChanged();
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

  async function cancelInlineJob(job: DesktopHarnessJobView): Promise<void> {
    if (jobBusy !== null) return;
    setJobBusy(job.id);
    try {
      await onCancelJob(job);
    } finally {
      setJobBusy(null);
    }
  }

  async function send(): Promise<void> {
    const text = prompt.trim();
    if (!text || busy !== null) return;
    setError(null);
    setWorkspaceNotice(null);

    if (await executeSlashCommand(text)) return;
    if (promptIsBangCommand) {
      await executeBangCommand(text);
      return;
    }

    closeInlineCommandPanels();
    setBusy("send");
    setResumeOpen(false);

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

    const optimisticMessageId = `user:${window.crypto.randomUUID()}`;
    const optimistic: DesktopHarnessCodexConversationMessage = {
      id: optimisticMessageId,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setPrompt("");

    const result = await window.sourcenerveDesktop.runHarnessCodexTurn({
      runId: run.id,
      prompt: text,
    });
    if (!result.ok) {
      setError(result.error.message);
      await hydrateConversation(run, false);
      setBusy(null);
      await onChanged();
      return;
    }

    await hydrateConversation(run, false);
    setBusy(null);
    await onChanged();
  }

  const composerDisabled = busy !== null;
  const sendBlockedByRun = Boolean(conversationRun && runRequiresOperatorResolution(conversationRun) && !promptIsSlashCommand && !promptIsBangCommand);
  const sendBlockedBySetup = !promptIsSlashCommand && (!selectedReadyWorkspace || (!promptIsBangCommand && !setupReady));
  const bangCommandReady = !promptIsBangCommand || Boolean(bangCommandText);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Harness conversation">
      {!setupReady || readyWorkspaces.length === 0 ? (
        <div className="shrink-0 border-b border-border bg-card px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {!setup?.installed ? <ActionButton onClick={() => void installCodex()} disabled={busy !== null || setup?.canInstall === false}>{busy === "install" ? "Installing…" : "Install Codex"}</ActionButton> : null}
            {setup?.installed && !setupReady ? <ActionButton onClick={() => void loginCodex()} disabled={busy !== null}>{busy === "login" ? "Connecting…" : "Connect ChatGPT"}</ActionButton> : null}
            <ActionButton variant="secondary" onClick={() => void refreshSetup()} disabled={busy !== null}>Check runtime</ActionButton>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-background">
        <div className="mx-auto w-full max-w-[860px] space-y-6 px-5 py-8 lg:px-8">
          {hydrating ? <p className="text-center text-xs text-muted-foreground">Restoring conversation…</p> : null}
          {!hydrating
            && feedItems.length === 0
            && codexInfoPanel === null
            && !runPanelOpen
            && !agentPanelOpen
            && !workspaceDraft
            && !workspaceCheck
            && !workspaceListOpen
            && !workspaceHelpOpen
            && !visibleError
            && !workspaceNotice
            && approvals.length === 0 ? (
            <div className="grid min-h-[48vh] place-items-center text-center">
              <div className="max-w-xl">
                <img src={appIconUrl} alt="" className="mx-auto mb-4 size-10 rounded-[10px]" aria-hidden="true" />
                <p className="text-lg font-semibold tracking-[-0.02em] text-foreground">What would you like Harness to work on?</p>
                {workspaces.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Use <code>/workspace add</code> to add your first workspace.</p> : null}
              </div>
            </div>
          ) : feedItems.map((item) => item.kind === "message" ? (
            <article key={item.message.id} className={item.message.role === "user" ? "ml-auto max-w-[78%]" : "mr-auto w-full"}>
              {item.message.role === "user" ? (
                <div className="rounded-[16px] bg-muted/75 px-4 py-3 text-foreground">
                  <p className="whitespace-pre-wrap text-sm leading-6">{item.message.text}</p>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">{new Date(item.message.createdAt).toLocaleTimeString()}</p>
                </div>
              ) : (
                <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <img src={appIconUrl} alt="" className="size-7 rounded-[8px]" aria-hidden="true" />
                  <div className="min-w-0 pt-0.5">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">Harness</span>
                      <span className="text-[10px] text-muted-foreground">{new Date(item.message.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{item.message.text}</p>
                  </div>
                </div>
              )}
            </article>
          ) : item.kind === "tool" ? (
            <ToolActivityRow key={item.id} item={item} />
          ) : item.kind === "job" ? (
            <JobActivityRow key={item.id} item={item} busy={jobBusy === item.job.id} onCancel={() => void cancelInlineJob(item.job)} />
          ) : (
            <BangCommandRow key={item.entry.id} entry={item.entry} />
          ))}

          {commandSurfaceActive ? (
            <div ref={commandSurfaceRef} className="space-y-3" aria-label="Command output">
              {visibleError ? <CommandNoticeInlinePanel tone="danger" title="Command failed" message={visibleError} onClose={() => setError(null)} /> : null}
              {workspaceNotice ? <CommandNoticeInlinePanel tone="success" title="Done" message={workspaceNotice} onClose={() => setWorkspaceNotice(null)} /> : null}

              {workspaceDraft ? (
                <WorkspaceEditInlinePanel
                  draft={workspaceDraft}
                  fieldErrors={workspaceFieldErrors}
                  busy={busy === "workspace"}
                  onChange={setWorkspaceDraft}
                  onChooseRepository={() => void chooseWorkspaceDraftRepository()}
                  onSave={() => void saveWorkspaceDraft()}
                  onClose={() => { setWorkspaceDraft(null); setWorkspaceFieldErrors({}); }}
                />
              ) : null}

              {workspaceCheck ? (
                <WorkspaceCheckInlinePanel
                  workspace={workspaceCheck.workspace}
                  result={workspaceCheck.result}
                  onClose={() => setWorkspaceCheck(null)}
                />
              ) : null}

              {workspaceListOpen ? (
                <WorkspaceListInlinePanel
                  workspaces={workspaces}
                  selectedWorkspaceId={selectedWorkspaceId}
                  busy={busy === "workspace"}
                  onRefresh={() => void executeWorkspaceCommand("/workspace list")}
                  onClose={() => setWorkspaceListOpen(false)}
                />
              ) : null}

              {workspaceHelpOpen ? <WorkspaceHelpInlinePanel onClose={() => setWorkspaceHelpOpen(false)} /> : null}

              {codexInfoPanel === "status" && codexStatus ? (
                <CodexStatusInlinePanel status={codexStatus} onClose={() => setCodexInfoPanel(null)} />
              ) : null}

              {codexInfoPanel === "usage" && codexUsage ? (
                <CodexUsageInlinePanel usage={codexUsage} onClose={() => setCodexInfoPanel(null)} />
              ) : null}

              {runPanelOpen && conversationRun ? (
                <RunInlinePanel
                  run={conversationRun}
                  contextRoute={latestContextRoute}
                  busy={busy === "run"}
                  onRefresh={() => void onRefreshRun()}
                  onCancel={() => void onCancelRun()}
                  onClose={() => setRunPanelOpen(false)}
                />
              ) : null}

              {agentPanelOpen && conversationRun ? (
                <div className="rounded-[14px] border border-border bg-card p-4" aria-label="Harness agent tools">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">Agent</p>
                    <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setAgentPanelOpen(false)}>Close</button>
                  </div>
                  <AgentOpsPanel
                    runId={conversationRun.id}
                    runStatus={conversationRun.status}
                    onChanged={() => { void onRefreshRun(); }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {approvals.length > 0 ? (
            <div className="space-y-3 rounded-[14px] border border-warning/35 bg-warning/5 p-4" role="status" aria-label="Pending Harness approvals">
              <p className="text-sm font-semibold text-foreground">Approval required</p>
              {approvals.map((approval) => (
                <article key={approval.id} className="rounded-[10px] border border-border bg-card p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground">{approval.tool}</p>
                    </div>
                    <span className="status-pill">approval required</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ActionButton onClick={() => void respondToApproval(approval, "allow")} disabled={approvalBusy !== null}>Allow once</ActionButton>
                    <ActionButton variant="secondary" onClick={() => void respondToApproval(approval, "deny")} disabled={approvalBusy !== null}>Deny</ActionButton>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {busy === "send" && approvals.length === 0 && runningToolCount === 0 && activeJobs.length === 0 ? (
            <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
              <img src={appIconUrl} alt="" className="size-7 rounded-[8px]" aria-hidden="true" />
              <p className="pt-1 text-xs text-muted-foreground">Harness is working with native Codex…</p>
            </div>
          ) : null}
        </div>
      </div>

      <footer className="shrink-0 px-5 py-3 lg:px-8">
        <div className="relative mx-auto w-full max-w-[860px]">
          {resumeOpen ? (
            <div className="mb-2 overflow-hidden rounded-[12px] border border-border bg-card shadow-[0_10px_30px_var(--sn-shadow)]">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div>
                  <p className="text-xs font-semibold text-foreground">Resume conversation</p>
                </div>
                <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setResumeOpen(false)}>Close</button>
              </div>
              {resumeLoading ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">Loading conversations…</p>
              ) : resumeItems.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">No native Codex conversations found in this workspace.</p>
              ) : (
                <div
                  ref={resumeMenuRef}
                  className="max-h-72 overflow-auto p-1.5"
                  role="listbox"
                  aria-label="Saved native Codex conversations"
                  aria-activedescendant={`resume-conversation-option-${activeResumeSelectionIndex}`}
                >
                  {resumeItems.map((summary, index) => {
                    const run = summary.run;
                    const current = Boolean(summary.runId && summary.runId === selectedRunId);
                    const selected = index === activeResumeSelectionIndex;
                    return (
                      <button
                        key={summary.threadId}
                        id={`resume-conversation-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`relative flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-muted/55"}`}
                        onMouseEnter={() => setResumeSelectionIndex(index)}
                        onClick={() => void resumeNativeConversation(summary.threadId)}
                      >
                        {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[12px] font-semibold ${selected ? "text-primary" : "text-foreground"}`}>{summary.title}</span>
                          {summary.preview && summary.preview !== summary.title ? <span className="mt-1 block truncate text-[11px] text-muted-foreground">{summary.preview}</span> : null}
                          <span className="mt-1.5 block text-[10px] text-muted-foreground">
                            Native Codex{summary.model ? ` · ${summary.model}` : ""} · {humanizeActivity(summary.status)} · {new Date(summary.updatedAt).toLocaleString()}
                          </span>
                        </span>
                        {current ? <span className="status-pill shrink-0">Current</span> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {permissionOpen ? (
            <div className="mb-2 overflow-hidden rounded-[12px] border border-border bg-card shadow-[0_10px_30px_var(--sn-shadow)]">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <p className="text-xs font-semibold text-foreground">Permission</p>
                <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setPermissionOpen(false)}>Close</button>
              </div>
              <div
                className="p-1.5"
                role="listbox"
                aria-label="Harness permissions"
                aria-activedescendant={`permission-option-${permissionSelectionIndex}`}
              >
                {PERMISSION_PRESETS.map((preset, index) => {
                  const selected = index === permissionSelectionIndex;
                  return (
                    <button
                      key={preset.id}
                      id={`permission-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`relative flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-muted/55"}`}
                      onMouseEnter={() => setPermissionSelectionIndex(index)}
                      onClick={() => void applyPermission(preset)}
                      disabled={busy !== null}
                    >
                      {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
                      <ShieldCheck className={`size-3.5 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                      <span className={`min-w-0 flex-1 text-xs font-medium ${selected ? "text-primary" : "text-foreground"}`}>{preset.label}</span>
                      {activePermission === preset.id ? <span className="status-pill">Current</span> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {slashMenuVisible ? (
            <div
              ref={slashMenuRef}
              className="absolute bottom-[calc(100%+8px)] left-0 right-0 max-h-[204px] overflow-y-auto rounded-[12px] border border-border bg-card p-1.5 shadow-[0_10px_30px_var(--sn-shadow)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="listbox"
              aria-label="Slash commands"
              aria-activedescendant={`slash-command-option-${activeSlashSelectionIndex}`}
            >
              {slashSuggestions.map((item, index) => {
                const selected = index === activeSlashSelectionIndex;
                return (
                <button
                  key={item.command}
                  id={`slash-command-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`relative flex min-h-[48px] w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left transition-colors ${selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-muted/55"}`}
                  onMouseEnter={() => setSlashSelectionIndex(index)}
                  onClick={() => chooseSlashSuggestion(item)}
                >
                  {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
                  <Command className={`size-3.5 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs font-semibold ${selected ? "text-primary" : "text-foreground"}`}>{item.command}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{item.label}</span>
                    </span>
                  </span>
                </button>
                );
              })}
            </div>
          ) : null}

          <div className="relative flex items-end gap-2 rounded-[16px] border border-border bg-card px-3 py-2 shadow-[0_3px_14px_var(--sn-shadow)] transition-[border-color,box-shadow] focus-within:border-foreground/35 focus-within:shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_3px_14px_var(--sn-shadow)]">
            <div className={`flex min-w-0 flex-1 ${promptIsBangCommand ? "items-center gap-2" : "items-end"}`}>
              {promptIsBangCommand ? <span className="ml-1 shrink-0 font-mono text-sm font-semibold leading-6 text-danger" aria-label="Shell command mode">!</span> : null}
              <textarea
                ref={composerTextareaRef}
                value={composerValue}
              onChange={(event) => {
                const nextPrompt = promptIsBangCommand ? `!${event.target.value}` : event.target.value;
                setPrompt(nextPrompt);
                setSlashSelectionIndex(0);
                if (resumeOpen && nextPrompt.trim()) setResumeOpen(false);
                if (permissionOpen && nextPrompt.trim()) setPermissionOpen(false);
              }}
              onKeyDown={(event) => {
                if (promptIsBangCommand && event.key === "Backspace" && composerValue.length === 0) {
                  event.preventDefault();
                  setPrompt("");
                  return;
                }
                if (resumeOpen && event.key === "ArrowDown" && resumeItems.length > 0) {
                  event.preventDefault();
                  setResumeSelectionIndex((current) => (current + 1) % resumeItems.length);
                  return;
                }
                if (resumeOpen && event.key === "ArrowUp" && resumeItems.length > 0) {
                  event.preventDefault();
                  setResumeSelectionIndex((current) => (current - 1 + resumeItems.length) % resumeItems.length);
                  return;
                }
                if (resumeOpen && event.key === "Home" && resumeItems.length > 0) {
                  event.preventDefault();
                  setResumeSelectionIndex(0);
                  return;
                }
                if (resumeOpen && event.key === "End" && resumeItems.length > 0) {
                  event.preventDefault();
                  setResumeSelectionIndex(resumeItems.length - 1);
                  return;
                }
                if (resumeOpen && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const item = resumeItems[activeResumeSelectionIndex] ?? resumeItems[0];
                  if (item) void resumeNativeConversation(item.threadId);
                  return;
                }
                if (permissionOpen && event.key === "ArrowDown") {
                  event.preventDefault();
                  setPermissionSelectionIndex((current) => (current + 1) % PERMISSION_PRESETS.length);
                  return;
                }
                if (permissionOpen && event.key === "ArrowUp") {
                  event.preventDefault();
                  setPermissionSelectionIndex((current) => (current - 1 + PERMISSION_PRESETS.length) % PERMISSION_PRESETS.length);
                  return;
                }
                if (permissionOpen && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const preset = PERMISSION_PRESETS[permissionSelectionIndex] ?? PERMISSION_PRESETS[0];
                  if (preset) void applyPermission(preset);
                  return;
                }
                if (slashMenuVisible && event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashSelectionIndex((current) => (current + 1) % slashSuggestions.length);
                  return;
                }
                if (slashMenuVisible && event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashSelectionIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                if (slashMenuVisible && event.key === "Tab") {
                  event.preventDefault();
                  const item = slashSuggestions[activeSlashSelectionIndex] ?? slashSuggestions[0];
                  if (item) chooseSlashSuggestion(item);
                  return;
                }
                if (slashMenuVisible && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const item = slashSuggestions[activeSlashSelectionIndex] ?? slashSuggestions[0];
                  if (item) void executeSlashCommand(item.command);
                  return;
                }
                if (event.key === "Escape" && (resumeOpen || permissionOpen)) {
                  event.preventDefault();
                  setResumeOpen(false);
                  setPermissionOpen(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
                placeholder={promptIsBangCommand ? "Run command in workspace…" : "Message Harness…"}
                rows={promptIsBangCommand ? 1 : 2}
                style={{ outline: "none" }}
                className="min-w-0 w-full flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-sm leading-6 outline-none focus-visible:outline-none"
                disabled={composerDisabled}
              />
            </div>
            {composerCanExpand ? (
              <button
                type="button"
                className="absolute right-2.5 top-2.5 grid size-7 place-items-center rounded-[8px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                onClick={() => setComposerExpanded((current) => !current)}
                aria-label={composerExpanded ? "Collapse composer" : "Expand composer"}
                title={composerExpanded ? "Collapse composer" : "Expand composer"}
              >
                {composerExpanded ? <Minimize2 className="size-3.5" aria-hidden="true" /> : <Maximize2 className="size-3.5" aria-hidden="true" />}
              </button>
            ) : null}
            <ActionButton
              size="icon"
              className="mb-0.5 shrink-0"
              onClick={() => void send()}
              disabled={composerDisabled || !prompt.trim() || !bangCommandReady || sendBlockedByRun || sendBlockedBySetup}
              aria-label={promptIsBangCommand ? "Run workspace command" : "Send message"}
            >
              <ArrowUp className="size-4" aria-hidden="true" />
            </ActionButton>
          </div>
        </div>
      </footer>
    </section>
  );
}

const inlineCommandControlClass = "h-9 w-full rounded-[9px] border border-border bg-background px-2.5 text-xs text-foreground outline-none transition focus:border-foreground/35 disabled:cursor-not-allowed disabled:opacity-50";

function CommandNoticeInlinePanel({
  tone,
  title,
  message,
  onClose,
}: {
  tone: "success" | "danger";
  title: string;
  message: string;
  onClose(): void;
}) {
  const toneClass = tone === "danger"
    ? "border-danger/30 bg-danger/5"
    : "border-success/30 bg-success/5";
  return (
    <section className={`rounded-[14px] border p-4 ${toneClass}`} role={tone === "danger" ? "alert" : "status"}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{message}</p>
        </div>
        <button type="button" className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}

function WorkspaceEditInlinePanel({
  draft,
  fieldErrors,
  busy,
  onChange,
  onChooseRepository,
  onSave,
  onClose,
}: {
  draft: WorkspaceDraft;
  fieldErrors: Record<string, string>;
  busy: boolean;
  onChange(draft: WorkspaceDraft): void;
  onChooseRepository(): void;
  onSave(): void;
  onClose(): void;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Edit workspace">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Edit workspace</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Changes apply to this SourceNerve workspace.</p>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose} disabled={busy}>Close</button>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-[10px] border border-border/70 bg-muted/30 px-3 py-2.5">
        <code className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground" title={draft.root}>{draft.root}</code>
        <ActionButton variant="secondary" size="sm" onClick={onChooseRepository} disabled={busy}>
          <FolderOpen className="size-3.5" aria-hidden="true" />
          Change repo
        </ActionButton>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <InlineCommandField label="Name" error={fieldErrors.name}>
          <input className={inlineCommandControlClass} value={draft.name} maxLength={128} disabled={busy} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </InlineCommandField>
        <InlineCommandField label="Workspace ID" error={fieldErrors.id}>
          <input className={inlineCommandControlClass} value={draft.id} maxLength={128} disabled={busy} onChange={(event) => onChange({ ...draft, id: event.target.value })} />
        </InlineCommandField>
        <InlineCommandField label="Access" error={fieldErrors.access}>
          <select className={inlineCommandControlClass} value={draft.access} disabled={busy} onChange={(event) => onChange({ ...draft, access: event.target.value as WorkspaceAccess })}>
            <option value="read-write" disabled={draft.selection?.localWritable === false}>Read-write</option>
            <option value="read-only">Read-only</option>
          </select>
        </InlineCommandField>
        <InlineCommandField label="Remote" error={fieldErrors.remote}>
          <input className={inlineCommandControlClass} value={draft.remote} maxLength={128} disabled={busy} onChange={(event) => onChange({ ...draft, remote: event.target.value })} />
        </InlineCommandField>
        <div className="sm:col-span-2">
          <InlineCommandField label="Default branch" error={fieldErrors.defaultBranch}>
            <input className={inlineCommandControlClass} value={draft.defaultBranch} maxLength={256} disabled={busy} onChange={(event) => onChange({ ...draft, defaultBranch: event.target.value })} />
          </InlineCommandField>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton size="sm" onClick={onSave} disabled={busy || !draft.id.trim() || !draft.name.trim() || !draft.remote.trim() || !draft.defaultBranch.trim()}>
          {busy ? "Saving…" : "Save changes"}
        </ActionButton>
        <ActionButton variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</ActionButton>
      </div>
    </section>
  );
}

function InlineCommandField({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <span className="text-[10px] text-danger">{error}</span> : null}
    </label>
  );
}

function WorkspaceCheckInlinePanel({ workspace, result, onClose }: { workspace: ManagedWorkspaceView; result: GitTransportValidation; onClose(): void }) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Workspace check result">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Workspace check</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{workspace.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`status-pill ${result.ready ? "" : "text-warning"}`}>{result.ready ? "Ready" : "Needs attention"}</span>
          <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InlineMetric label="Transport" value={result.transport.toUpperCase()} />
        <InlineMetric label="Access" value={workspace.access} />
        <InlineMetric label="Branch" value={workspace.branch ?? workspace.defaultBranch} />
        <InlineMetric label="Repository" value={workspace.repository ?? workspace.remote} />
      </div>
      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">{result.message}</p>
    </section>
  );
}

function WorkspaceListInlinePanel({
  workspaces,
  selectedWorkspaceId,
  busy,
  onRefresh,
  onClose,
}: {
  workspaces: ManagedWorkspaceView[];
  selectedWorkspaceId: string | null;
  busy: boolean;
  onRefresh(): void;
  onClose(): void;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Workspace list result">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Workspaces</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{workspaces.length} configured</p>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>
      <div className="mt-3 divide-y divide-border/70 rounded-[10px] border border-border/70">
        {workspaces.length === 0 ? <p className="px-3 py-3 text-[11px] text-muted-foreground">No workspaces configured.</p> : workspaces.map((workspace) => (
          <div key={workspace.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-foreground">{workspace.name}</span>
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{workspace.id} · {workspace.access} · {workspace.branch ?? workspace.defaultBranch}</span>
            </span>
            {workspace.id === selectedWorkspaceId ? <span className="status-pill">Current</span> : null}
            <span className="status-pill">{workspace.validation.state}</span>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <ActionButton variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</ActionButton>
      </div>
    </section>
  );
}

function WorkspaceHelpInlinePanel({ onClose }: { onClose(): void }) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Workspace command help">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Workspace commands</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Commands without an ID use the current workspace.</p>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>
      <div className="mt-3 space-y-1.5 font-mono text-[10px] text-muted-foreground">
        <p>/workspace add [--id ID] [--name NAME] [--access read-write|read-only] [--remote REMOTE] [--branch BRANCH]</p>
        <p>/workspace edit [ID] [--id NEW_ID] [--name NAME] [--access read-write|read-only] [--remote REMOTE] [--branch BRANCH] [--pick]</p>
        <p>/workspace check [ID]</p>
        <p>/workspace remove [ID]</p>
        <p>/workspace list</p>
      </div>
    </section>
  );
}

function CodexStatusInlinePanel({ status, onClose }: { status: DesktopHarnessCodexStatusView; onClose(): void }) {
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Native Codex status">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Codex status</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{status.accountType === "chatgpt" ? "ChatGPT" : status.accountType ?? "Not connected"}{status.planType ? ` · ${status.planType}` : ""}</p>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>
      <div className="mt-3 space-y-2">
        {status.rateLimits.length === 0 ? <p className="text-xs text-muted-foreground">Codex did not return rate-limit windows for this account.</p> : status.rateLimits.map((limit, index) => (
          <div key={`${limit.limitId ?? limit.limitName ?? "codex"}:${index}`} className="rounded-[10px] border border-border/70 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">{limit.limitName ?? limit.limitId ?? "Codex"}</p>
              {limit.planType ? <span className="status-pill">{limit.planType}</span> : null}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {limit.primary ? <RateLimitWindowRow label="Primary" window={limit.primary} /> : null}
              {limit.secondary ? <RateLimitWindowRow label="Secondary" window={limit.secondary} /> : null}
            </div>
          </div>
        ))}
      </div>
      {status.resetCreditsAvailable !== undefined ? <p className="mt-3 text-[11px] text-muted-foreground">Reset credits available: <span className="font-medium text-foreground">{status.resetCreditsAvailable}</span></p> : null}
    </section>
  );
}

function RateLimitWindowRow({ label, window }: { label: string; window: { usedPercent: number; remainingPercent: number; windowDurationMins?: number; resetsAt?: number } }) {
  return (
    <div className="rounded-[9px] bg-muted/45 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">{label}{window.windowDurationMins ? ` · ${formatWindowDuration(window.windowDurationMins)}` : ""}</span>
        <span className="font-medium text-foreground">{window.usedPercent}% used</span>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">{window.remainingPercent}% remaining{window.resetsAt ? ` · resets ${formatResetTime(window.resetsAt)}` : ""}</p>
    </div>
  );
}

function CodexUsageInlinePanel({ usage, onClose }: { usage: DesktopHarnessCodexUsageView; onClose(): void }) {
  const summaryItems = [
    ["Lifetime tokens", usage.summary.lifetimeTokens],
    ["Peak daily", usage.summary.peakDailyTokens],
    ["Current streak", usage.summary.currentStreakDays === undefined ? undefined : `${usage.summary.currentStreakDays}d`],
    ["Longest streak", usage.summary.longestStreakDays === undefined ? undefined : `${usage.summary.longestStreakDays}d`],
  ].filter((item) => item[1] !== undefined) as Array<[string, number | string]>;
  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Native Codex usage">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Codex usage</p>
          <p className="mt-1 text-[11px] text-muted-foreground">Native account usage{usage.thread ? " · current conversation included" : ""}</p>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>
      {summaryItems.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summaryItems.map(([label, value]) => <InlineMetric key={label} label={label} value={typeof value === "number" ? formatTokenCount(value) : value} />)}
        </div>
      ) : <p className="mt-3 text-xs text-muted-foreground">Codex did not return account token totals.</p>}
      {usage.thread ? (
        <div className="mt-3 rounded-[10px] border border-border/70 px-3 py-2.5">
          <p className="text-[11px] font-medium text-foreground">Current conversation</p>
          <div className="mt-2 space-y-1.5">
            {usage.thread.groups.length > 0 ? usage.thread.groups.map((group, index) => (
              <div key={`${group.model ?? "model"}:${index}`} className="flex flex-wrap items-center justify-between gap-2 text-[10px]">
                <span className="text-muted-foreground">{group.model ?? "Codex"}{group.reasoningEffort ? ` · ${group.reasoningEffort}` : ""}</span>
                <span className="text-foreground">{group.totalTokens === undefined ? "Token total unavailable" : `${formatTokenCount(group.totalTokens)} tokens`}</span>
              </div>
            )) : <p className="text-[10px] text-muted-foreground">No per-model token breakdown returned.</p>}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatWindowDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function RunInlinePanel({
  run,
  contextRoute,
  busy,
  onRefresh,
  onCancel,
  onClose,
}: {
  run: DesktopHarnessRunView;
  contextRoute: { route: string; retrieve: boolean; queryBytes: string | null } | null;
  busy: boolean;
  onRefresh(): void;
  onCancel(): void;
  onClose(): void;
}) {
  const progress = [
    ["Context", run.closedLoop.contextReads],
    ["Execute", run.closedLoop.executions],
    ["Verify", run.closedLoop.verificationStatus],
    ["Recover", run.closedLoop.recoveryStatus],
    ["Learn", run.closedLoop.learningCount],
  ] as const;

  return (
    <section className="rounded-[14px] border border-border bg-card p-4" aria-label="Current Harness run">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Run</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="status-pill">{humanizeActivity(run.status)}</span>
            <span className="status-pill">{humanizeActivity(run.freshnessState)}</span>
            <span className="status-pill">{humanizeActivity(run.recoveryState)}</span>
            <span className="status-pill">{humanizeActivity(run.profile)}</span>
          </div>
        </div>
        <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <InlineMetric label="Approvals" value={String(run.pendingApprovals)} />
        <InlineMetric label="Uncertain" value={String(run.uncertainMutations)} />
        <InlineMetric label="Jobs" value={String(run.activeJobs)} />
        <InlineMetric label="Sandbox" value={run.sandbox === "danger-full-access" ? "Full sandbox" : humanizeActivity(run.sandbox)} />
      </div>

      {run.sandbox === "danger-full-access" ? (
        <div className="mt-3 rounded-[10px] border border-warning/25 bg-warning/5 px-3 py-2.5">
          <p className="text-[10px] font-semibold text-foreground">Full sandbox removes Codex confinement</p>
          <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Codex receives the run’s full sandbox. Protected Git/provider mutations remain governed by SourceNerve, and any native approval callback Codex raises is still resolved through the Harness approval ledger.</p>
        </div>
      ) : null}

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold text-foreground">Progress</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {progress.map(([label, value]) => (
            <InlineMetric key={label} label={label} value={typeof value === "string" ? humanizeActivity(value) : String(value)} />
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-foreground">Context routing</p>
          <span className="text-[9px] text-muted-foreground">automatic</span>
        </div>
        {contextRoute ? (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <InlineMetric label="Latest route" value={humanizeActivity(contextRoute.route)} />
            <InlineMetric label="Context needed" value={contextRoute.retrieve ? "Yes" : "No"} />
            <InlineMetric label="Query" value={contextRoute.queryBytes ? `${contextRoute.queryBytes} bytes` : "Recorded"} />
          </div>
        ) : (
          <p className="mt-2 text-[10px] text-muted-foreground">No prompt has been routed yet. Harness routes repository context automatically before each Codex turn.</p>
        )}
      </div>

      <div className="mt-4">
        <p className="mb-2 text-[11px] font-semibold text-foreground">Permissions</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(run.policies).map(([name, decision]) => {
            const classes = decision === "allow"
              ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
              : decision === "ask"
                ? "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300"
                : "border-border bg-muted/45 text-muted-foreground";
            return <span key={name} className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ${classes}`}>{name}: {decision}</span>;
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</ActionButton>
        {run.status === "running" ? <ActionButton variant="destructive" size="sm" onClick={onCancel} disabled={busy}>Cancel run</ActionButton> : null}
      </div>
    </section>
  );
}

function InlineMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] bg-muted/40 px-3 py-2.5">
      <p className="text-[9px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-[11px] font-semibold text-foreground">{value}</p>
    </div>
  );
}

type ToolActivityStatus = "running" | "completed" | "failed";

type ConversationActivityItem =
  | { kind: "tool"; id: string; tool: string; label: string; status: ToolActivityStatus; createdAt: number }
  | { kind: "job"; id: string; job: DesktopHarnessJobView; label: string; status: string; createdAt: number };

type ConversationFeedItem =
  | { kind: "message"; createdAt: number; message: DesktopHarnessCodexConversationMessage }
  | { kind: "command"; createdAt: number; entry: BangCommandEntry }
  | ConversationActivityItem;

function buildConversationFeed(
  messages: DesktopHarnessCodexConversationMessage[],
  activity: ConversationActivityItem[],
  commands: BangCommandEntry[],
): ConversationFeedItem[] {
  return [
    ...messages.map((message) => ({ kind: "message" as const, createdAt: new Date(message.createdAt).getTime(), message })),
    ...activity,
    ...commands.map((entry) => ({ kind: "command" as const, createdAt: entry.createdAt, entry })),
  ].sort((left, right) => left.createdAt - right.createdAt);
}

function buildActivityItems(events: DesktopHarnessEventView[], jobs: DesktopHarnessJobView[]): ConversationActivityItem[] {
  const tools: Array<Extract<ConversationActivityItem, { kind: "tool" }>> = [];
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);

  for (const event of orderedEvents) {
    if (!event.eventType.startsWith("tool/")) continue;
    const tool = summaryField(event.summary, "tool");
    if (!tool) continue;

    if (event.eventType === "tool/started") {
      tools.push({
        kind: "tool",
        id: `tool:${event.seq}`,
        tool,
        label: toolLabel(tool),
        status: "running",
        createdAt: event.createdAt * 1000,
      });
      continue;
    }

    if (event.eventType === "tool/result" || event.eventType === "tool/failed" || event.eventType === "tool/blocked") {
      const current = [...tools].reverse().find((item) => item.tool === tool && item.status === "running");
      const status: ToolActivityStatus = event.eventType === "tool/result" ? "completed" : "failed";
      if (current) {
        current.status = status;
      } else {
        tools.push({
          kind: "tool",
          id: `tool:${event.seq}`,
          tool,
          label: toolLabel(tool),
          status,
          createdAt: event.createdAt * 1000,
        });
      }
    }
  }

  const jobItems: ConversationActivityItem[] = jobs.slice(-12).map((job) => ({
    kind: "job",
    id: `job:${job.id}`,
    job,
    label: jobLabel(job.kind),
    status: job.status,
    createdAt: job.createdAt * 1000,
  }));

  return [...tools.slice(-24), ...jobItems].sort((left, right) => left.createdAt - right.createdAt);
}

function summaryField(summary: string, field: string): string | null {
  const match = summary.match(new RegExp(`(?:^|[\s·])${field}=([^\s·]+)`));
  return match?.[1] ?? null;
}

function toolLabel(tool: string): string {
  if (tool.includes("read_file") || tool.includes("file_fetch")) return "Read file";
  if (tool.includes("file_write") || tool.includes("file_put") || tool.includes("patch_apply")) return "Edit files";
  if (tool.includes("workspace_exec")) return "Run command";
  if (tool.includes("git_review")) return "Review changes";
  if (tool.includes("git_commit")) return "Commit changes";
  if (tool.includes("git_push")) return "Push changes";
  if (tool.includes("pull_merge")) return "Merge pull request";
  if (tool.includes("pull_create")) return "Create pull request";
  return humanizeActivity(tool);
}

function jobLabel(kind: string): string {
  return humanizeActivity(kind);
}

function humanizeActivity(value: string): string {
  const normalized = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Task";
}

function BangCommandRow({ entry }: { entry: BangCommandEntry }) {
  const running = entry.status === "running";
  const succeeded = entry.status === "completed";
  const Icon = running ? LoaderCircle : succeeded ? Check : CircleX;
  const status = running ? "Running" : succeeded ? "Done" : "Failed";
  const result = entry.result;
  return (
    <article className="ml-10 max-w-[760px] overflow-hidden rounded-[12px] border border-border/70 bg-card" aria-label="Shell command output">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-2.5">
        <Icon className={`size-3.5 shrink-0 ${running ? "animate-spin text-muted-foreground" : succeeded ? "text-success" : "text-danger"}`} aria-hidden="true" />
        <Command className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground" title={entry.command}>! {entry.command}</code>
        <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
      </div>
      {entry.error ? <p className="whitespace-pre-wrap px-3 py-2.5 text-[11px] leading-5 text-danger">{entry.error}</p> : null}
      {result?.stdout ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-5 text-foreground">{result.stdout}</pre> : null}
      {result?.stderr ? <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-3 py-2.5 font-mono text-[11px] leading-5 ${result.success === false ? "text-danger" : "text-foreground"}`}>{result.stderr}</pre> : null}
      {result && result.status === "completed" && !result.stdout && !result.stderr && !entry.error ? <p className="px-3 py-2.5 text-[10px] text-muted-foreground">Command completed with no output.</p> : null}
      {result ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/50 px-3 py-2 text-[9px] text-muted-foreground">
          {result.exitCode !== undefined ? <span>exit {result.exitCode}</span> : null}
          {result.sandbox ? <span>{result.sandbox}</span> : null}
          {result.sandboxEnforcement ? <span>confinement {result.sandboxEnforcement}</span> : null}
          {result.timedOut ? <span>timed out</span> : null}
          {result.truncated ? <span>output truncated</span> : null}
        </div>
      ) : null}
    </article>
  );
}

function ToolActivityRow({ item }: { item: Extract<ConversationActivityItem, { kind: "tool" }> }) {
  const Icon = item.status === "running" ? LoaderCircle : item.status === "completed" ? Check : CircleX;
  return (
    <div className="ml-10 flex max-w-[680px] items-center gap-2.5 rounded-[10px] border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      <Icon className={`size-3.5 shrink-0 ${item.status === "running" ? "animate-spin text-muted-foreground" : item.status === "completed" ? "text-success" : "text-danger"}`} aria-hidden="true" />
      <Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.label}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{item.status === "running" ? "Running" : item.status === "completed" ? "Done" : "Failed"}</span>
    </div>
  );
}

function JobActivityRow({
  item,
  busy,
  onCancel,
}: {
  item: Extract<ConversationActivityItem, { kind: "job" }>;
  busy: boolean;
  onCancel(): void;
}) {
  const active = item.job.status === "active" || item.job.status === "pending";
  return (
    <div className="ml-10 flex max-w-[680px] items-center gap-2.5 rounded-[10px] border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      {active ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.label}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{humanizeActivity(item.status)}</span>
      {active ? <ActionButton variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{busy ? "Stopping…" : "Cancel"}</ActionButton> : null}
    </div>
  );
}

type WorkspaceOptionName = "id" | "name" | "access" | "remote" | "branch";

type WorkspaceCommandParseResult =
  | {
      ok: true;
      action: string;
      positionals: string[];
      options: Partial<Record<WorkspaceOptionName, string>>;
      switches: Set<"pick">;
    }
  | { ok: false; error: string };

function parseWorkspaceCommand(value: string): WorkspaceCommandParseResult {
  const tokens = tokenizeSlashCommand(value);
  if (tokens[0] !== "/workspace") return { ok: false, error: "Workspace command must start with /workspace." };
  const action = (tokens[1] ?? "help").toLowerCase();
  const positionals: string[] = [];
  const options: Partial<Record<WorkspaceOptionName, string>> = {};
  const switches = new Set<"pick">();
  const optionNames = new Set<WorkspaceOptionName>(["id", "name", "access", "remote", "branch"]);

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--pick") {
      switches.add("pick");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2) as WorkspaceOptionName;
    if (!optionNames.has(name)) return { ok: false, error: `Unknown workspace option “${token}”. Use /workspace help.` };
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) return { ok: false, error: `Workspace option “${token}” requires a value.` };
    options[name] = next;
    index += 1;
  }

  return { ok: true, action, positionals, options, switches };
}

function tokenizeSlashCommand(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of value.trim().matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function workspaceAccess(value: string | undefined): WorkspaceAccess | null {
  if (value === "read-write" || value === "read-only") return value;
  return null;
}

function bangComposerValue(value: string): string {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("!")) return value;
  return trimmed.slice(1).trimStart();
}

function extractBangCommand(value: string): string | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("!")) return null;
  return trimmed.slice(1).trim();
}

function commandError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function permissionForRun(run: DesktopHarnessRunView | null): PermissionPresetId | null {
  if (!run) return null;
  if (run.sandbox === "danger-full-access") return "full-access";
  if (run.profile === "read-only-analysis" && run.sandbox === "read-only") return "read-only";
  if (run.profile === "guarded-durable" && run.sandbox === "workspace-write") return "guarded";
  if (run.profile === "interactive-local" && run.sandbox === "workspace-write") return "workspace-write";
  return null;
}

function isCodexCompatibleRun(run: DesktopHarnessRunView): boolean {
  return run.status === "running"
    && run.freshnessState === "current"
    && !runRequiresOperatorResolution(run);
}

function runRequiresOperatorResolution(run: DesktopHarnessRunView): boolean {
  return run.closedLoop.recoveryStatus === "needed"
    || run.closedLoop.recoveryStatus === "in-progress"
    || run.pendingApprovals > 0
    || run.uncertainMutations > 0;
}
