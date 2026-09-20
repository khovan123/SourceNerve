import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, CircleX, Command, Copy, FolderOpen, LoaderCircle, Maximize2, Minimize2, ShieldCheck } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { DesktopRuntimeEvent, GitTransportValidation, ManagedWorkspaceView, WorkspaceAccess } from "../../shared/desktop-api";
import type {
  DesktopHarnessCodexActivityView,
  DesktopHarnessCodexConversationMessage,
  DesktopHarnessCodexConversationSummary,
  DesktopHarnessCodexReviewLoopView,
  DesktopHarnessCodexSetupView,
  DesktopHarnessCodexStatusView,
  DesktopHarnessCodexUsageView,
  DesktopHarnessCommandView,
  DesktopHarnessEventView,
  DesktopHarnessJobView,
  DesktopHarnessRunView,
  DesktopHarnessSkillActivityView,
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
const CODEX_STREAM_HYDRATION_MS = 750;
const COMPOSER_LINE_HEIGHT_PX = 24;
const COMPOSER_VERTICAL_PADDING_PX = 12;
const COMPOSER_MAX_ROWS = 9;
const COMPOSER_EXPANDED_MIN_ROWS = 12;
const COMPOSER_EXPANDED_VIEWPORT_RATIO = 0.55;
const HARNESS_OPERATOR_GATE_ERROR = "Resolve the current Harness approval, recovery, or uncertain mutation before continuing.";
const HARNESS_PERMISSION_GATE_ERROR = "Resolve the current Harness approval, recovery, or uncertain mutation before changing permission.";
const USER_PROMPT_PREVIEW_LINES = 5;
const USER_PROMPT_PREVIEW_MAX_HEIGHT_REM = 7.5;

type ChatGptReviewResultView = {
  state: "done" | "blocked";
  iterations: number;
  title: string;
  review: string;
  noCodeExecution: boolean;
};

type PermissionPresetId = "read-only" | "workspace-write" | "guarded" | "full-access";
type HarnessAgentId = "codex" | "chat-gpt" | "goal" | "loop";
type HarnessAgentBaseId = "codex" | "chat-gpt";
type HarnessAgentModelKey = "codex" | "chat-gpt";
type WorkspaceAgentModelDefaults = Record<string, Partial<Record<HarnessAgentModelKey, string>>>;

const HARNESS_AGENT_OPTIONS: Array<{ id: HarnessAgentBaseId; label: string; description: string }> = [
  { id: "codex", label: "Codex", description: "Native Codex thread executes directly under Harness." },
  { id: "chat-gpt", label: "ChatGPT", description: "ChatGPT Web acts directly through Harness tools; native Codex is not used." },
];

const PERMISSION_PRESETS: Array<{ id: PermissionPresetId; label: string; profile: string; sandbox: "read-only" | "workspace-write" | "danger-full-access"; danger?: boolean }> = [
  { id: "read-only", label: "Read only", profile: "read-only-analysis", sandbox: "read-only" },
  { id: "workspace-write", label: "Workspace write", profile: "interactive-local", sandbox: "workspace-write" },
  { id: "guarded", label: "Guarded", profile: "guarded-durable", sandbox: "workspace-write" },
  { id: "full-access", label: "Full sandbox", profile: "interactive-local", sandbox: "danger-full-access", danger: true },
];

const PERMISSION_STORAGE_KEY = "sourcenerve:harness-permission:v1";
const AGENT_STORAGE_KEY = "sourcenerve:harness-agent:v1";
const AGENT_MODEL_STORAGE_KEY = "sourcenerve:harness-agent-model:v1";
const CHATGPT_CONVERSATION_STORAGE_KEY = "sourcenerve:chatgpt-conversation:v1";

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

type SkillTurnEntry = {
  id: string;
  runId: string;
  workspace: string;
  status: "pending" | "selected" | "failed";
  createdAt: number;
  turnId?: string;
  activity?: DesktopHarnessSkillActivityView;
  error?: string;
};

type CodexProgressRuntimeEvent = Extract<DesktopRuntimeEvent, { type: "codex-progress" }>;

type CodexTraceItem = Omit<CodexProgressRuntimeEvent, "type"> & {
  id: string;
  source?: "codex" | "chatgpt";
  position?: number;
  createdAt: number;
  updatedAt: number;
};

type ChatGptLiveTool = {
  id: string;
  itemId?: string;
  label: string;
  stage: string;
  input?: string;
  output?: string;
  durationMs?: number;
};


const SOURCENERVE_SLASH_COMMANDS: SlashCommandItem[] = [
  { command: "/new", label: "New conversation", requiresArgument: false },
  { command: "/resume", label: "Resume conversation", requiresArgument: false },
  { command: "/status", label: "Show native Codex plan and rate-limit reset status", requiresArgument: false },
  { command: "/usage", label: "Show native Codex token usage", requiresArgument: false },
  { command: "/agents", label: "Choose Codex or ChatGPT as the active agent", requiresArgument: false },
  { command: "/model", label: "Show or change the model for the active agent", requiresArgument: false },
  { command: "/model auto", label: "Use the default model for the active agent", requiresArgument: false },
  { command: "/model web", label: "Use the model currently selected inside ChatGPT Web", requiresArgument: false },
  { command: "/goal", label: "Use ChatGPT Goal mode for the next repository goal", requiresArgument: false },
  { command: "/loop", label: "Use ChatGPT Loop mode for bounded continuous checks", requiresArgument: false },
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
  const [skillTurns, setSkillTurns] = useState<SkillTurnEntry[]>([]);
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeSelectionIndex, setResumeSelectionIndex] = useState(0);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionSelectionIndex, setPermissionSelectionIndex] = useState(0);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentSelectionIndex, setAgentSelectionIndex] = useState(0);
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [codexStatus, setCodexStatus] = useState<DesktopHarnessCodexStatusView | null>(null);
  const [codexUsage, setCodexUsage] = useState<DesktopHarnessCodexUsageView | null>(null);
  const [codexInfoPanel, setCodexInfoPanel] = useState<"status" | "usage" | null>(null);
  const [busy, setBusy] = useState<"setup" | "install" | "login" | "new-run" | "permission" | "workspace" | "run" | "clear" | "resume" | "codex-info" | "command" | "send" | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [activePromptRunId, setActivePromptRunId] = useState<string | null>(null);
  const activePromptRunIdRef = useRef<string | null>(null);
  const [activeChatGptTaskId, setActiveChatGptTaskId] = useState<string | null>(null);
  const activeChatGptTaskIdRef = useRef<string | null>(null);
  const [activePromptStartedAt, setActivePromptStartedAt] = useState<number | null>(null);
  const [promptCancelling, setPromptCancelling] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceNotice, setWorkspaceNotice] = useState<string | null>(null);
  const [workspaceAgentDefaults, setWorkspaceAgentDefaults] = useState<Record<string, HarnessAgentId>>(() => loadWorkspaceAgentDefaults());
  const [workspaceAgentModels, setWorkspaceAgentModels] = useState<WorkspaceAgentModelDefaults>(() => loadWorkspaceAgentModelDefaults());
  const [reviewLoopPhase, setReviewLoopPhase] = useState<string | null>(null);
  const [chatGptLiveTools, setChatGptLiveTools] = useState<ChatGptLiveTool[]>([]);
  const [chatGptLiveDiff, setChatGptLiveDiff] = useState("");
  const [timelineActivities, setTimelineActivities] = useState<DesktopHarnessCodexActivityView[]>([]);
  const [codexTraceItems, setCodexTraceItems] = useState<CodexTraceItem[]>([]);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft | null>(null);
  const [workspaceFieldErrors, setWorkspaceFieldErrors] = useState<Record<string, string>>({});
  const [workspaceCheck, setWorkspaceCheck] = useState<{ workspace: ManagedWorkspaceView; result: GitTransportValidation } | null>(null);
  const [workspaceListOpen, setWorkspaceListOpen] = useState(false);
  const [workspaceHelpOpen, setWorkspaceHelpOpen] = useState(false);
  const [workspacePermissionDefaults, setWorkspacePermissionDefaults] = useState<Record<string, PermissionPresetId>>(() => loadWorkspacePermissionDefaults());
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerCanExpand, setComposerCanExpand] = useState(false);
  const commandSurfaceRef = useRef<HTMLDivElement | null>(null);
  const approvalPanelRef = useRef<HTMLDivElement | null>(null);
  const resumeMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);
  const messageViewportRef = useRef<HTMLDivElement | null>(null);
  const messageTailRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelledPromptRunsRef = useRef(new Set<string>());

  useEffect(() => { void refreshSetup(); }, []);

  useEffect(() => {
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state" && event.component === "harness" && event.state.startsWith("chatgpt-review-")) {
        const payload = parseChatGptAgentStateRuntimeEvent(event);
        if (payload && activePromptRunIdRef.current === payload.runId) {
          setReviewLoopPhase(event.state.slice("chatgpt-review-".length));
          if (payload.taskId) {
            activeChatGptTaskIdRef.current = payload.taskId;
            setActiveChatGptTaskId(payload.taskId);
          }
        }
      }
      if (event.type === "chatgpt-progress" && activePromptRunIdRef.current === event.runId) {
        const activeTaskId = activeChatGptTaskIdRef.current;
        if (!activeTaskId || activeTaskId === event.taskId) {
          if (!activeTaskId) {
            activeChatGptTaskIdRef.current = event.taskId;
            setActiveChatGptTaskId(event.taskId);
          }
          if (event.kind !== "reasoning") {
            setTimelineActivities((current) => applyRuntimeActivityEvent(current, event));
          }
          if (event.kind === "tool") setChatGptLiveTools((current) => mergeChatGptLiveTool(current, event));
          else if (event.kind === "diff") setChatGptLiveDiff((current) => mergeChatGptLiveDiff(current, event));
        }
      }
      if (event.type === "codex-progress" && activePromptRunIdRef.current === event.runId) {
        setTimelineActivities((current) => applyRuntimeActivityEvent(current, event));
        setCodexTraceItems((current) => applyCodexProgressEvent(current, event));
      }
      const payload = parseSkillSelectionRuntimeEvent(event);
      if (!payload) return;
      setSkillTurns((current) => applySkillSelectionRuntimeEvent(current, payload));
    });
  }, []);

  useEffect(() => {
    setRunPanelOpen(false);
    setAgentPanelOpen(false);
    setCodexInfoPanel(null);
  }, [selectedWorkspaceId, selectedRunId]);

  useEffect(() => {
    setError(null);
    setWorkspaceNotice(null);
    setReviewLoopPhase(null);
    setChatGptLiveTools([]);
    setChatGptLiveDiff("");
    setTimelineActivities([]);
    setCodexTraceItems([]);
    setMessages([]);
    setSkillTurns([]);
    setCurrentThreadId(null);
    setApprovals([]);
    setBangCommands([]);
    setResumeOpen(false);
    setResumeSelectionIndex(0);
    setPermissionOpen(false);
    setPermissionSelectionIndex(0);
    setAgentPickerOpen(false);
    setAgentSelectionIndex(0);
    setConversationSummaries([]);
    setWorkspaceDraft(null);
    setWorkspaceCheck(null);
    setWorkspaceListOpen(false);
    setWorkspaceHelpOpen(false);
    setWorkspaceFieldErrors({});
    activePromptRunIdRef.current = null;
    setActivePromptRunId(null);
    activeChatGptTaskIdRef.current = null;
    setActiveChatGptTaskId(null);
    setActivePromptStartedAt(null);
    setPromptCancelling(false);
    cancelledPromptRunsRef.current.clear();
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
  const runPermission = permissionForRun(conversationRun);
  const desiredPermission = workspacePermissionDefaults[workspaceId] ?? runPermission ?? "workspace-write";
  const desiredPermissionPreset = PERMISSION_PRESETS.find((preset) => preset.id === desiredPermission) ?? PERMISSION_PRESETS[1];
  const compatibleRun = conversationRun && isCodexCompatibleRun(conversationRun) && runPermission === desiredPermission ? conversationRun : null;
  const activePermission = desiredPermission;
  const selectedAgent = workspaceAgentDefaults[workspaceId] ?? "codex";
  const selectedAgentModel = selectedModelForAgent(workspaceAgentModels, workspaceId, selectedAgent);
  const selectedCodexModel = codexModelForAgent(workspaceAgentModels, workspaceId, selectedAgent);
  const chatGptDirectAgentActive = selectedAgent === "chat-gpt";
  const chatGptAgentActive = chatGptDirectAgentActive || selectedAgent === "goal" || selectedAgent === "loop";
  const chatGptLoopMode = selectedAgent === "goal" ? "goal" : selectedAgent === "loop" ? "loop" : "review";
  const nativeCodexRequiredForSelectedAgent = !chatGptDirectAgentActive;
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
  const slashMenuVisible = slashSuggestions.length > 0 && promptIsSlashCommand && !resumeOpen && !permissionOpen && !agentPickerOpen;
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
    if (!agentPickerOpen) return;
    const option = agentMenuRef.current?.querySelector<HTMLElement>(`#agent-option-${agentSelectionIndex}`);
    option?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [agentPickerOpen, agentSelectionIndex]);

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
  const activeChatGptTurnId = activeChatGptTaskId ? `chatgpt-review:${activeChatGptTaskId}` : null;
  const assistantMessageTurnIds = useMemo(() => new Set(messages
    .filter((message) => message.role === "assistant" && message.turnId)
    .map((message) => message.turnId!)), [messages]);
  const persistedTraceItems = useMemo(() => timelineActivities
    .filter((activity) => {
      if (activity.source !== "chatgpt") return true;
      if (activity.kind === "reasoning") return false;
      if (activity.kind === "response"
        && activity.turnId !== activeChatGptTurnId
        && assistantMessageTurnIds.has(activity.turnId)) return false;
      if (isStaleChatGptNativeExecutionFailure(activity) && assistantMessageTurnIds.has(activity.turnId)) return false;
      return true;
    })
    .map(activityViewToTraceItem), [activeChatGptTurnId, assistantMessageTurnIds, timelineActivities]);
  const liveTraceIds = useMemo(() => new Set(persistedTraceItems.map((entry) => entry.id)), [persistedTraceItems]);
  const mergedTraceItems = useMemo(() => [
    ...persistedTraceItems,
    ...codexTraceItems.filter((entry) => !liveTraceIds.has(entry.id)),
  ], [persistedTraceItems, codexTraceItems, liveTraceIds]);
  const visibleTraceItems = mergedTraceItems;
  const activePromptTraceCount = useMemo(() => {
    if (!activePromptRunId || activePromptStartedAt === null) return 0;
    return visibleTraceItems.filter((entry) => (
      entry.runId === activePromptRunId
      && entry.source !== "chatgpt"
      && entry.createdAt >= activePromptStartedAt
    )).length;
  }, [activePromptRunId, activePromptStartedAt, visibleTraceItems]);
  const activeChatGptResponseText = useMemo(() => {
    if (!activePromptRunId || !activeChatGptTurnId) return "";
    return visibleTraceItems.find((entry) => (
      entry.source === "chatgpt"
      && entry.runId === activePromptRunId
      && entry.turnId === activeChatGptTurnId
      && entry.kind === "response"
      && Boolean(entry.text?.trim())
    ))?.text?.trim() ?? "";
  }, [activeChatGptTurnId, activePromptRunId, visibleTraceItems]);
  const feedItems = useMemo(() => moveCompletedChatGptFileGroupsAfterResponses(
    buildConversationFeed(messages, activityItems, bangCommands, skillTurns, visibleTraceItems),
    activeChatGptTurnId,
  ), [activeChatGptTurnId, messages, activityItems, bangCommands, skillTurns, visibleTraceItems]);
  const latestFeedItem = feedItems[feedItems.length - 1] ?? null;
  const activeJobs = jobs.filter((job) => job.status === "active" || job.status === "pending");
  const runningToolCount = activityItems.filter((item) => item.kind === "tool" && item.status === "running").length;
  const hasChatGptLiveProgress = Boolean(chatGptLiveTools.length > 0 || chatGptLiveDiff);
  const rawVisibleError = error ?? externalError ?? null;
  const operatorGateRun = conversationRun && runRequiresOperatorResolution(conversationRun) ? conversationRun : null;
  const operatorGateFromError = isHarnessOperatorGateError(rawVisibleError);
  const operatorGatePanelRun = operatorGateRun ?? (operatorGateFromError ? conversationRun : null);
  const operatorGateActive = Boolean(operatorGateRun || operatorGateFromError);
  const visibleError = operatorGateFromError ? null : rawVisibleError;
  const commandSurfaceActive = Boolean(
    operatorGateActive
      || visibleError
      || workspaceNotice
      || codexInfoPanel
      || runPanelOpen
      || agentPanelOpen
      || workspaceDraft
      || workspaceCheck
      || workspaceListOpen
      || workspaceHelpOpen,
  );
  const messageAutoScrollKey = [
    latestFeedItem ? conversationFeedItemKey(latestFeedItem) : "empty",
    String(feedItems.length),
    busy ?? "idle",
    operatorGateActive ? "operator-gate" : "",
    operatorGatePanelRun?.id ?? "",
    visibleError ?? "",
    workspaceNotice ?? "",
    String(approvals.length),
    String(runningToolCount),
    String(activeJobs.length),
    chatGptLiveTools.map((tool) => `${tool.id}:${tool.stage}:${tool.input?.slice(-40) ?? ""}:${tool.output?.slice(-80) ?? ""}`).join("|"),
    chatGptLiveDiff.slice(-160),
    promptCancelling ? "cancelling" : "ready",
  ].join("|");

  useEffect(() => {
    if (!commandSurfaceActive) return;
    const frame = window.requestAnimationFrame(() => {
      commandSurfaceRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    commandSurfaceActive,
    operatorGateActive,
    operatorGatePanelRun?.id,
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
    if (approvals.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      approvalPanelRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [approvals.length, operatorGateActive]);

  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(() => {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
      messageTailRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageAutoScrollKey]);

  useEffect(() => {
    const run = selectedWorkspaceRun;
    if (!run) {
      // A missing selected run can be transient after a native execution or
      // recovery error. Keep the visible thread/history; only workspace
      // switches, /new, clear, and explicit resume reset conversation state.
      setApprovals([]);
      setHydrating(false);
      return undefined;
    }
    let cancelled = false;
    setHydrating(true);
    const storedConversationId = readChatGptConversationId(run.workspace);
    void window.sourcenerveDesktop.getHarnessCodexConversation({
      runId: run.id,
      ...(storedConversationId ? { conversationId: storedConversationId } : {}),
    }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // Hydration/native errors are inline status, not conversation resets.
        // Keep the visible thread/history so a recovery or usage-limit error
        // cannot blank the open conversation.
        setError(result.error.message);
        setHydrating(false);
        return;
      }
      if (result.value.runId === run.id && result.value.workspace === run.workspace) {
        const nextThreadId = result.value.threadId ?? null;
        setMessages((current) => mergeHydratedConversationMessages(currentThreadId, nextThreadId, current, result.value.messages));
        setTimelineActivities(result.value.activities ?? []);
        setCurrentThreadId(nextThreadId);
        if (result.value.conversationId) persistChatGptConversationId(run.workspace, result.value.conversationId);
        syncConversationBusyNotice(run.id, result.value.busy === true, result.value.busyReason);
      }
      setHydrating(false);
    });
    return () => { cancelled = true; };
  }, [selectedWorkspaceRun?.id, selectedWorkspaceRun?.workspace, chatGptDirectAgentActive]);

  useEffect(() => {
    const run = selectedWorkspaceRun;
    if (!run || run.status !== "running") {
      setApprovals([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      await loadPendingApprovals(run, { cancelled: () => cancelled });
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, APPROVAL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedWorkspaceRun?.id, selectedWorkspaceRun?.status]);

  async function loadPendingApprovals(
    run: DesktopHarnessRunView,
    options: { cancelled?: () => boolean; reportError?: boolean } = {},
  ): Promise<void> {
    if (run.status !== "running") {
      if (!options.cancelled?.()) setApprovals([]);
      return;
    }
    const result = await window.sourcenerveDesktop.listHarnessApprovals({
      runId: run.id,
      status: "pending",
      limit: 100,
    });
    if (options.cancelled?.()) return;
    if (result.ok) {
      setApprovals(result.value);
    } else if (options.reportError) {
      setError(result.error.message);
    }
  }

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
    const storedConversationId = readChatGptConversationId(run.workspace);
    const result = await window.sourcenerveDesktop.getHarnessCodexConversation({
      runId: run.id,
      ...(storedConversationId ? { conversationId: storedConversationId } : {}),
    });
    if (!result.ok) {
      if (reportError) setError(result.error.message);
      return;
    }
    if (result.value.runId !== run.id || result.value.workspace !== run.workspace) {
      if (reportError) setError("Harness conversation no longer matches the selected run.");
      return;
    }
    const nextThreadId = result.value.threadId ?? null;
    setMessages((current) => mergeHydratedConversationMessages(currentThreadId, nextThreadId, current, result.value.messages));
    setTimelineActivities(result.value.activities ?? []);
    setCurrentThreadId(nextThreadId);
    if (result.value.conversationId) persistChatGptConversationId(run.workspace, result.value.conversationId);
    syncConversationBusyNotice(run.id, result.value.busy === true, result.value.busyReason);
  }

  function syncConversationBusyNotice(runId: string, nativeBusy: boolean, busyReason?: string): void {
    const busyBelongsToCurrentPrompt = activePromptRunIdRef.current === runId;
    if (chatGptDirectAgentActive || busyBelongsToCurrentPrompt || !nativeBusy) {
      setWorkspaceNotice((current) => current && isNativeThreadBusyNotice(current) ? null : current);
      return;
    }
    setWorkspaceNotice(busyReason ?? nativeThreadBusyNotice());
  }

  function startStreamingConversationHydration(
    run: DesktopHarnessRunView,
    optimisticMessage: DesktopHarnessCodexConversationMessage,
  ): () => void {
    let stopped = false;
    let inFlight = false;

    const hydrateStreamingMessages = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const storedConversationId = readChatGptConversationId(run.workspace);
        const result = await window.sourcenerveDesktop.getHarnessCodexConversation({
          runId: run.id,
          ...(storedConversationId ? { conversationId: storedConversationId } : {}),
        });
        if (stopped || !result.ok) return;
        if (result.value.runId !== run.id || result.value.workspace !== run.workspace) return;
        setCurrentThreadId(result.value.threadId ?? null);
        if (result.value.conversationId) persistChatGptConversationId(run.workspace, result.value.conversationId);
        setTimelineActivities(result.value.activities ?? []);
        setMessages((current) => mergeStreamingConversationMessages(current, result.value.messages, optimisticMessage));
        syncConversationBusyNotice(run.id, result.value.busy === true, result.value.busyReason);
      } finally {
        inFlight = false;
      }
    };

    void hydrateStreamingMessages();
    const interval = window.setInterval(() => {
      void hydrateStreamingMessages();
    }, CODEX_STREAM_HYDRATION_MS);

    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
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
    setSkillTurns([]);
    setCurrentThreadId(null);
    setApprovals([]);
    setResumeOpen(false);
    setPermissionOpen(false);
    setRunPanelOpen(false);
    setAgentPanelOpen(false);
    setWorkspaceNotice(`Cleared ${result.value.deleted} conversation${result.value.deleted === 1 ? "" : "s"} from “${workspaceName}”. Harness audit runs are kept.`);
    setBusy(null);
    await onChanged();
  }

  async function createConversation(showBusy = true, selectCreatedRun = true, resetTranscript = true): Promise<DesktopHarnessRunView | null> {
    if (!workspaceId) return null;
    if (showBusy) setBusy("new-run");
    setError(null);
    setResumeOpen(false);
    setPermissionOpen(false);
    const result = await window.sourcenerveDesktop.beginHarnessRun({
      workspace: workspaceId,
      profile: desiredPermissionPreset.profile,
      sandbox: desiredPermissionPreset.sandbox,
    });
    if (!result.ok) {
      setError(result.error.message);
      if (showBusy) setBusy(null);
      return null;
    }
    if (resetTranscript) {
      setMessages([]);
      setSkillTurns([]);
      setCurrentThreadId(null);
      setApprovals([]);
    }
    if (selectCreatedRun) {
      await onChanged();
      await onRunSelected(result.value.id);
    }
    if (showBusy) setBusy(null);
    return result.value;
  }

  async function ensureRun(options: { requiresNativeThread: boolean }): Promise<DesktopHarnessRunView | null> {
    if (compatibleRun) return compatibleRun;
    if (conversationRun && runRequiresOperatorResolution(conversationRun)) {
      setError(HARNESS_OPERATOR_GATE_ERROR);
      return null;
    }
    if (!options.requiresNativeThread) {
      // Direct ChatGPT owns execution through Harness MCP. It needs a current
      // Harness run, but must never resume or wait on a native Codex thread.
      return createConversation(false, false, false);
    }
    if (currentThreadId) return resumeSelectedThreadForPrompt(currentThreadId);
    if (hydrating) {
      setError("Wait for the selected conversation to finish restoring before sending a prompt.");
      return null;
    }
    // Only /new creates a new native Codex conversation when a restored thread
    // already exists. A normal prompt without a restored thread may still create
    // the first conversation for a workspace.
    return createConversation(false, false, false);
  }

  async function resumeSelectedThreadForPrompt(threadId: string): Promise<DesktopHarnessRunView | null> {
    if (!workspaceId) return null;
    const storedConversationId = readChatGptConversationId(workspaceId);
    const resumed = await window.sourcenerveDesktop.resumeHarnessCodexConversation({
      workspace: workspaceId,
      threadId,
      ...(storedConversationId ? { conversationId: storedConversationId } : {}),
      profile: desiredPermissionPreset.profile,
      sandbox: desiredPermissionPreset.sandbox,
    });
    if (!resumed.ok) {
      setError(resumed.error.message);
      return null;
    }
    setMessages((current) => mergeConversationMessages(current, resumed.value.messages));
    if (resumed.value.conversationId) persistChatGptConversationId(workspaceId, resumed.value.conversationId);
    setCurrentThreadId(resumed.value.threadId ?? threadId);
    syncConversationBusyNotice(resumed.value.runId, resumed.value.busy === true, resumed.value.busyReason);
    const run = await window.sourcenerveDesktop.getHarnessRun({ runId: resumed.value.runId });
    if (!run.ok) {
      setError(run.error.message);
      return null;
    }
    return run.value;
  }

  async function resumeNativeConversation(summary: DesktopHarnessCodexConversationSummary): Promise<void> {
    if (!workspaceId || busy !== null) return;
    setBusy("resume");
    setError(null);
    setWorkspaceNotice(null);
    setMessages([]);
    setSkillTurns([]);
    setApprovals([]);
    setPermissionOpen(false);
    try {
      const threadId = summary.threadId;
      const storedConversationId = readChatGptConversationId(workspaceId);
      const conversationId = summary.conversationId ?? storedConversationId;
      const result = await window.sourcenerveDesktop.resumeHarnessCodexConversation({
        workspace: workspaceId,
        ...(threadId ? { threadId } : {}),
        ...(conversationId ? { conversationId } : {}),
        profile: desiredPermissionPreset.profile,
        sandbox: desiredPermissionPreset.sandbox,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setMessages(sanitizeConversationMessages(result.value.messages));
      setTimelineActivities(result.value.activities ?? []);
      if (result.value.conversationId) persistChatGptConversationId(workspaceId, result.value.conversationId);
      setCurrentThreadId(result.value.threadId ?? threadId ?? null);
      syncConversationBusyNotice(result.value.runId, result.value.busy === true, result.value.busyReason);
      setResumeOpen(false);
      await onChanged();
      await onRunSelected(result.value.runId);
    } finally {
      setBusy(null);
    }
  }

  function rememberWorkspacePermission(workspace: string, presetId: PermissionPresetId): void {
    setWorkspacePermissionDefaults((current) => {
      const next = { ...current, [workspace]: presetId };
      saveWorkspacePermissionDefaults(next);
      return next;
    });
  }

  async function applyPermission(preset: (typeof PERMISSION_PRESETS)[number]): Promise<void> {
    const workspace = readyWorkspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) {
      setError("Choose a ready workspace before changing permission.");
      return;
    }
    if (desiredPermission === preset.id && conversationRun && permissionForRun(conversationRun) === preset.id) {
      setPermissionOpen(false);
      setPrompt("");
      return;
    }
    if (conversationRun && runRequiresOperatorResolution(conversationRun)) {
      setError(HARNESS_PERMISSION_GATE_ERROR);
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

    rememberWorkspacePermission(workspace.id, preset.id);
    setMessages([]);
    setSkillTurns([]);
    setCurrentThreadId(null);
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
    setAgentPickerOpen(false);
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
      resetChatGptConversationId(workspaceId);
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
        resetChatGptConversationId(workspaceId);
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

    if (command === "/agents" || command === "/agent") {
      closeInlineCommandPanels();
      setError(null);
      setWorkspaceNotice(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      const requested = normalizeAgentCommand(argument || "");
      if (!requested) {
        setPrompt("");
        const currentIndex = HARNESS_AGENT_OPTIONS.findIndex((item) => item.id === (selectedAgent === "chat-gpt" ? "chat-gpt" : "codex"));
        setAgentSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
        setAgentPickerOpen(true);
        return true;
      }
      if (requested === "codex" || requested === "chat-gpt") {
        selectHarnessAgent(requested);
        return true;
      }
      setError("Unknown agent. Use /agents codex or /agents chat-gpt. Use /goal or /loop for Goal/Loop modes.");
      return true;
    }
    if (command === "/goal" || command === "/loop") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      if (argument) {
        setError(`Use ${command} <prompt> to run immediately, or bare ${command} to select the mode for the next prompt.`);
        return true;
      }
      selectHarnessAgent(command === "/goal" ? "goal" : "loop");
      return true;
    }
    if (command === "/model") {
      closeInlineCommandPanels();
      setPrompt("");
      setError(null);
      setResumeOpen(false);
      setPermissionOpen(false);
      const requested = normalizeModelCommand(argument || "");
      if (!requested) {
        setWorkspaceNotice(`Current model for ${agentLabel(selectedAgent)}: ${selectedAgentModel}. Codex: /model auto or /model <codex-model-id>. ChatGPT: /model web uses the model selected inside ChatGPT Web.`);
        return true;
      }
      applyAgentModelSelection(requested);
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


  function selectHarnessAgent(agent: HarnessAgentId): void {
    if (!workspaceId) {
      setError("Choose a workspace before selecting an agent.");
      return;
    }
    setWorkspaceAgentDefaults((current) => {
      const next = { ...current, [workspaceId]: agent };
      saveWorkspaceAgentDefaults(next);
      return next;
    });
    setReviewLoopPhase(null);
    setWorkspaceNotice(agent === "codex"
      ? `Codex agent selected. Model: ${modelLabelForAgent(workspaceAgentModels, workspaceId, agent)}.`
      : agent === "chat-gpt"
        ? "ChatGPT agent selected. ChatGPT Web will act directly through Harness tools. Native Codex will not run."
        : `${agentLabel(agent)} mode selected. ChatGPT Web will plan/review while Harness keeps native Codex execution verified.`);
  }

  function chooseHarnessAgentFromPicker(agent: HarnessAgentBaseId): void {
    setAgentPickerOpen(false);
    setAgentSelectionIndex(0);
    setPrompt("");
    selectHarnessAgent(agent);
  }

  function applyAgentModelSelection(model: string): void {
    if (!workspaceId) return;
    const key = modelKeyForAgent(selectedAgent);
    if (key === "chat-gpt" && model !== "web") {
      setError("ChatGPT Web model is selected inside ChatGPT. Use /model web, then choose the concrete model in the ChatGPT window.");
      return;
    }
    const normalized = key === "chat-gpt" ? "web" : model;
    setWorkspaceAgentModels((current) => {
      const nextWorkspace = { ...(current[workspaceId] ?? {}) };
      if (normalized === "auto" && key === "codex") delete nextWorkspace.codex;
      else nextWorkspace[key] = normalized;
      const next = { ...current, [workspaceId]: nextWorkspace };
      saveWorkspaceAgentModelDefaults(next);
      return next;
    });
    setWorkspaceNotice(`Model for ${agentLabel(selectedAgent)} set to ${key === "chat-gpt" ? "ChatGPT Web current model" : normalized === "auto" ? "auto" : normalized}.`);
  }

  function chooseSlashSuggestion(item: SlashCommandItem): void {
    setSlashSelectionIndex(0);
    if (item.command === "/agents") {
      setPrompt("");
      const currentIndex = HARNESS_AGENT_OPTIONS.findIndex((agent) => agent.id === (selectedAgent === "chat-gpt" ? "chat-gpt" : "codex"));
      setAgentSelectionIndex(currentIndex >= 0 ? currentIndex : 0);
      setAgentPickerOpen(true);
      return;
    }
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

  function beginSkillTurn(id: string, runId: string, workspace: string, createdAt: number): void {
    setSkillTurns((current) => [...current, { id, runId, workspace, status: "pending", createdAt }]);
  }

  function selectPreparedSkillTurn(id: string, activity: DesktopHarnessSkillActivityView): void {
    setSkillTurns((current) => applyPreparedSkillActivity(current, id, activity));
  }

  function completeSkillTurn(id: string, activity: DesktopHarnessSkillActivityView | undefined, turnId: string): void {
    setSkillTurns((current) => finalizeSkillTurn(current, id, activity, turnId));
  }

  function failSkillTurn(id: string, error: string): void {
    setSkillTurns((current) => current.map((entry) => entry.id === id && entry.status === "pending"
      ? { ...entry, status: "failed", error }
      : entry));
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


  async function cancelActivePrompt(): Promise<void> {
    if (busy !== "send" || !activePromptRunId || promptCancelling) return;
    const runId = activePromptRunId;
    setPromptCancelling(true);
    setError(null);
    cancelledPromptRunsRef.current.add(runId);
    const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId });
    if (!result.ok) {
      cancelledPromptRunsRef.current.delete(runId);
      setError(result.error.message);
      setPromptCancelling(false);
      return;
    }
    setWorkspaceNotice("Cancelling prompt…");
    await onChanged();
  }

  function focusPendingApprovals(): void {
    approvalPanelRef.current?.scrollIntoView({ block: "nearest" });
  }

  async function refreshOperatorGateState(): Promise<void> {
    if (busy !== null) return;
    setBusy("run");
    setError(null);
    setWorkspaceNotice(null);
    try {
      await onRefreshRun();
      const run = operatorGatePanelRun ?? conversationRun;
      if (run) await loadPendingApprovals(run, { reportError: true });
    } finally {
      setBusy(null);
    }
  }

  async function cancelOperatorGateRun(): Promise<void> {
    const run = operatorGatePanelRun ?? conversationRun;
    if (busy !== null || !run || run.status !== "running") return;
    if (!window.confirm("Cancel this Harness run?")) return;
    setBusy("run");
    setError(null);
    setWorkspaceNotice(null);
    try {
      const result = await window.sourcenerveDesktop.cancelHarnessRun({ runId: run.id });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setApprovals([]);
      await onChanged();
      setWorkspaceNotice("Harness run cancelled. You can start a new prompt now.");
    } finally {
      setBusy(null);
    }
  }

  async function send(): Promise<void> {
    let text = prompt.trim();
    if (!text || busy !== null) return;
    setError(null);
    setWorkspaceNotice(null);

    if (operatorGateActive) {
      setError(HARNESS_OPERATOR_GATE_ERROR);
      await refreshOperatorGateState();
      return;
    }

    const inlineModePrompt = parseInlineChatGptModeCommand(text);
    const promptAgentOverride = inlineModePrompt?.agent ?? null;
    if (inlineModePrompt) {
      text = inlineModePrompt.prompt;
    } else if (await executeSlashCommand(text)) return;
    if (promptIsBangCommand) {
      await executeBangCommand(text);
      return;
    }

    const effectiveAgent = promptAgentOverride ?? selectedAgent;
    const effectiveSelectedCodexModel = codexModelForAgent(workspaceAgentModels, workspaceId, effectiveAgent);
    const effectiveChatGptDirectAgentActive = effectiveAgent === "chat-gpt";
    const effectiveChatGptAgentActive = effectiveChatGptDirectAgentActive || effectiveAgent === "goal" || effectiveAgent === "loop";
    const effectiveChatGptLoopMode = effectiveAgent === "goal" ? "goal" : effectiveAgent === "loop" ? "loop" : "review";
    const effectiveNativeCodexRequiredForSelectedAgent = !effectiveChatGptDirectAgentActive;

    closeInlineCommandPanels();
    setBusy("send");
    setResumeOpen(false);

    if (effectiveNativeCodexRequiredForSelectedAgent) {
      const currentSetup = setup ?? await refreshSetup(false);
      if (!currentSetup?.installed || !currentSetup.authenticated || currentSetup.accountType !== "chatgpt") {
        setError("Install the native runtime and connect ChatGPT before starting a Harness conversation.");
        setBusy(null);
        return;
      }
    } else if (conversationRun?.status === "running") {
      const nativeState = await window.sourcenerveDesktop.getHarnessCodexConversation({
        runId: conversationRun.id,
      });
      if (!nativeState.ok) {
        setError(`Cannot verify the native Codex writer state before handing this workspace to ChatGPT: ${nativeState.error.message}`);
        setBusy(null);
        return;
      }
      if (nativeState.value.busy === true) {
        setError("Native Codex is still actively writing this conversation. Cancel or wait for that turn to finish before handing the workspace to ChatGPT.");
        setWorkspaceNotice("Active native Codex writer detected. Direct ChatGPT is paused to avoid concurrent workspace writes.");
        setBusy(null);
        return;
      }
    }

    const run = await ensureRun({ requiresNativeThread: effectiveNativeCodexRequiredForSelectedAgent });
    if (!run) {
      setError((current) => current ?? "Add a ready read-write workspace before starting a Harness conversation.");
      setBusy(null);
      return;
    }

    const shouldSelectPromptRun = run.id !== selectedRunId;
    if (effectiveNativeCodexRequiredForSelectedAgent) {
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
    }

    const promptCreatedAt = Date.now();
    const optimisticMessageId = `user:${window.crypto.randomUUID()}`;
    const optimistic: DesktopHarnessCodexConversationMessage = {
      id: optimisticMessageId,
      role: "user",
      text,
      createdAt: new Date(promptCreatedAt).toISOString(),
    };
    const chatGptPendingMessageId = effectiveChatGptDirectAgentActive ? `assistant:${window.crypto.randomUUID()}` : null;
    const chatGptPendingTurnId = effectiveChatGptDirectAgentActive && chatGptPendingMessageId ? `chatgpt-direct:${chatGptPendingMessageId}` : undefined;
    const chatGptPendingMessage: DesktopHarnessCodexConversationMessage | null = effectiveChatGptDirectAgentActive && chatGptPendingMessageId
      ? {
        id: chatGptPendingMessageId,
        role: "assistant",
        text: "",
        createdAt: new Date(promptCreatedAt + 1).toISOString(),
        turnId: chatGptPendingTurnId,
      }
      : null;
    setMessages((current) => [...current, optimistic]);
    setPrompt("");
    setReviewLoopPhase(effectiveChatGptAgentActive ? "planning" : null);
    if (effectiveChatGptAgentActive) {
        setChatGptLiveTools([]);
      setChatGptLiveDiff("");
      activeChatGptTaskIdRef.current = null;
      setActiveChatGptTaskId(null);
    }

    if (effectiveChatGptAgentActive) {
      setActivePromptStartedAt(promptCreatedAt);
      activePromptRunIdRef.current = run.id;
      setActivePromptRunId(run.id);
      setWorkspaceNotice(effectiveChatGptDirectAgentActive
        ? null
        : `${agentLabel(effectiveAgent)} is planning in ChatGPT Web and will independently review each verified Codex iteration.`);
      setPromptCancelling(false);
      const stopStreamingHydration = effectiveChatGptDirectAgentActive ? (() => undefined) : startStreamingConversationHydration(run, optimistic);
      const reviewed = await window.sourcenerveDesktop.runHarnessCodexReviewLoop({
        runId: run.id,
        prompt: text,
        maxIterations: effectiveChatGptLoopMode === "review" ? 4 : effectiveChatGptLoopMode === "goal" ? 8 : 12,
        mode: effectiveChatGptLoopMode,
        ...(effectiveChatGptDirectAgentActive ? { conversationId: ensureChatGptConversationId(workspaceId) } : {}),
        ...(effectiveSelectedCodexModel ? { model: effectiveSelectedCodexModel } : {}),
      });
      stopStreamingHydration();
      const promptWasCancelled = cancelledPromptRunsRef.current.delete(run.id);
      if (!reviewed.ok) {
        const directTransportFailure = effectiveChatGptDirectAgentActive
          && !promptWasCancelled
          && isChatGptDirectTransportFailure(reviewed.error.message);
        const failureText = promptWasCancelled
          ? "Prompt cancelled."
          : formatChatGptDirectFailureTranscriptMessage(reviewed.error.message);
        setError(promptWasCancelled ? null : directTransportFailure ? failureText : effectiveChatGptDirectAgentActive ? null : reviewed.error.message);
        setReviewLoopPhase(null);
        setWorkspaceNotice(promptWasCancelled && !effectiveChatGptDirectAgentActive ? "Prompt cancelled." : null);
        if (directTransportFailure) {
          setPrompt(text);
          setMessages((current) => current.filter((message) => message.id !== optimistic.id && message.id !== chatGptPendingMessage?.id));
        }
        if (chatGptPendingMessage && !directTransportFailure) {
          if (shouldSelectPromptRun) await onRunSelected(run.id);
          setMessages((current) => mergeConversationMessages(current, [optimistic, {
            ...chatGptPendingMessage,
            text: failureText,
          }]));
        } else {
          if (!directTransportFailure) await hydrateConversation(run, false);
          if (shouldSelectPromptRun) await onRunSelected(run.id);
        }
        activePromptRunIdRef.current = null;
        setActivePromptRunId(null);
        activeChatGptTaskIdRef.current = null;
        setActiveChatGptTaskId(null);
        setActivePromptStartedAt(null);
        setPromptCancelling(false);
        setBusy(null);
              setChatGptLiveTools([]);
        setChatGptLiveDiff("");
        await onChanged();
        return;
      }

      cancelledPromptRunsRef.current.delete(run.id);
      if (reviewed.value.turn?.threadId) setCurrentThreadId(reviewed.value.turn.threadId);
      const formattedReview = formatChatGptReviewLoopResult(reviewed.value.state, reviewed.value.iterations, reviewed.value.review, text);
      const chatGptReviewMessage: DesktopHarnessCodexConversationMessage = {
        id: chatGptPendingMessage?.id ?? `assistant:${reviewed.value.taskId}`,
        role: "assistant",
        text: effectiveChatGptDirectAgentActive
          ? formatChatGptDirectTranscriptMessage(reviewed.value, text)
          : formatChatGptReviewTranscriptMessage(formattedReview, agentLabel(effectiveAgent)),
        createdAt: chatGptPendingMessage?.createdAt ?? new Date().toISOString(),
        turnId: `chatgpt-review:${reviewed.value.taskId}`,
      };
      setReviewLoopPhase(reviewed.value.state);
      setWorkspaceNotice(null);
      if (!effectiveChatGptDirectAgentActive) await hydrateConversation(run, false);
      if (shouldSelectPromptRun) await onRunSelected(run.id);
      setMessages((current) => mergeConversationMessages(
        current,
        effectiveChatGptDirectAgentActive ? [optimistic, chatGptReviewMessage] : [chatGptReviewMessage],
      ));
      activePromptRunIdRef.current = null;
      setActivePromptRunId(null);
      activeChatGptTaskIdRef.current = null;
      setActiveChatGptTaskId(null);
      setActivePromptStartedAt(null);
      setPromptCancelling(false);
      setBusy(null);
        setChatGptLiveTools([]);
      setChatGptLiveDiff("");
      await onChanged();
      return;
    }

    const skillTurnId = `skills:${window.crypto.randomUUID()}`;
    beginSkillTurn(skillTurnId, run.id, run.workspace, promptCreatedAt + 1);

    const prepared = await window.sourcenerveDesktop.prepareHarnessCodexTurn({
      runId: run.id,
      prompt: text,
    });
    if (!prepared.ok) {
      failSkillTurn(skillTurnId, prepared.error.message);
      setError(prepared.error.message);
      setBusy(null);
      return;
    }
    selectPreparedSkillTurn(skillTurnId, prepared.value.skillActivity);
    await waitForRendererPaint();

    setActivePromptStartedAt(promptCreatedAt);
    activePromptRunIdRef.current = run.id;
    setActivePromptRunId(run.id);
    setWorkspaceNotice((current) => current && isNativeThreadBusyNotice(current) ? null : current);
    setPromptCancelling(false);
    const stopStreamingHydration = startStreamingConversationHydration(run, optimistic);
    const result = await window.sourcenerveDesktop.runHarnessCodexTurn({
      runId: run.id,
      prompt: text,
      preparationId: prepared.value.preparationId,
      ...(selectedCodexModel ? { model: selectedCodexModel } : {}),
    });
    stopStreamingHydration();
    const promptWasCancelled = cancelledPromptRunsRef.current.delete(run.id);
    if (!result.ok) {
      if (promptWasCancelled) {
        setWorkspaceNotice("Prompt cancelled.");
        failSkillTurn(skillTurnId, "Skill selection stopped because the prompt was cancelled.");
      } else if (isHarnessOperatorGateError(result.error.message)) {
        setError(HARNESS_OPERATOR_GATE_ERROR);
        failSkillTurn(skillTurnId, "Skill selection stopped because Harness is waiting for operator resolution.");
      } else {
        setError(result.error.message);
        failSkillTurn(skillTurnId, result.error.message);
      }
      await hydrateConversation(run, false);
      if (shouldSelectPromptRun) await onRunSelected(run.id);
      activePromptRunIdRef.current = null;
      setActivePromptRunId(null);
      setActivePromptStartedAt(null);
      setPromptCancelling(false);
      setBusy(null);
      await onChanged();
      return;
    }

    cancelledPromptRunsRef.current.delete(run.id);
    setCurrentThreadId(result.value.threadId);
    if (result.value.response?.trim()) {
      const completedMessage: DesktopHarnessCodexConversationMessage = {
        id: `assistant:${result.value.turnId}`,
        role: "assistant",
        text: result.value.response,
        createdAt: new Date().toISOString(),
        turnId: result.value.turnId,
      };
      setMessages((current) => mergeConversationMessages(current, [completedMessage]));
    }
    await hydrateConversation(run, false);
    completeSkillTurn(skillTurnId, result.value.skillActivity, result.value.turnId);
    if (shouldSelectPromptRun) await onRunSelected(run.id);
    activePromptRunIdRef.current = null;
    setActivePromptRunId(null);
    setActivePromptStartedAt(null);
    setPromptCancelling(false);
    setBusy(null);
    await onChanged();
  }

  const nativeHydrationBlocking = nativeCodexRequiredForSelectedAgent && hydrating;
  const composerDisabled = busy !== null || nativeHydrationBlocking || operatorGateActive;
  const sendBlockedByRun = Boolean(conversationRun && runRequiresOperatorResolution(conversationRun) && !promptIsSlashCommand && !promptIsBangCommand);
  const sendBlockedBySetup = !promptIsSlashCommand && (!selectedReadyWorkspace || (!promptIsBangCommand && nativeCodexRequiredForSelectedAgent && !setupReady));
  const bangCommandReady = !promptIsBangCommand || Boolean(bangCommandText);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Harness conversation">
      {(nativeCodexRequiredForSelectedAgent && !setupReady) || readyWorkspaces.length === 0 ? (
        <div className="shrink-0 border-b border-border bg-card px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {!setup?.installed ? <ActionButton onClick={() => void installCodex()} disabled={busy !== null || setup?.canInstall === false}>{busy === "install" ? "Installing…" : "Install Codex"}</ActionButton> : null}
            {setup?.installed && !setupReady ? <ActionButton onClick={() => void loginCodex()} disabled={busy !== null}>{busy === "login" ? "Connecting…" : "Connect ChatGPT"}</ActionButton> : null}
            <ActionButton variant="secondary" onClick={() => void refreshSetup()} disabled={busy !== null}>Check runtime</ActionButton>
          </div>
        </div>
      ) : null}

      <div ref={messageViewportRef} className="min-h-0 flex-1 overflow-auto bg-background">
        <div className="mx-auto w-full max-w-[1040px] space-y-4 px-5 py-7 lg:px-8">
          {nativeHydrationBlocking ? <p className="text-center text-xs text-muted-foreground">Restoring conversation…</p> : null}
          {!hydrating
            && feedItems.length === 0
            && codexInfoPanel === null
            && !runPanelOpen
            && !agentPanelOpen
            && !workspaceDraft
            && !workspaceCheck
            && !workspaceListOpen
            && !workspaceHelpOpen
            && !operatorGateActive
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
          ) : feedItems.map((item, index) => item.kind === "message" ? (
            <ConversationMessageRow
              key={item.message.id}
              message={item.message}
              continuation={assistantStreamContinuation(feedItems, index)}
            />
          ) : item.kind === "skill" ? (
            <SkillTurnRow key={item.entry.id} entry={item.entry} />
          ) : item.kind === "codex-group" ? (
            <ClaudeCodexTraceGroup
              key={item.id}
              entries={item.entries}
              hideSummary={Boolean(activeChatGptTurnId && item.entries[0]?.source === "chatgpt" && item.entries[0]?.turnId === activeChatGptTurnId)}
            />
          ) : item.kind === "codex-trace" ? (
            <ClaudeCodexTraceRow key={item.entry.id} entry={item.entry} />
          ) : item.kind === "tool" ? (
            <ToolActivityRow key={item.id} item={item} />
          ) : item.kind === "job" ? (
            <JobActivityRow key={item.id} item={item} busy={jobBusy === item.job.id} onCancel={() => void cancelInlineJob(item.job)} />
          ) : (
            <BangCommandRow key={item.entry.id} entry={item.entry} />
          ))}

          {commandSurfaceActive ? (
            <div ref={commandSurfaceRef} className="space-y-3" aria-label="Command output">
              {operatorGateActive ? (
                <HarnessOperatorGateInlinePanel
                  run={operatorGatePanelRun}
                  approvalCount={approvals.length || operatorGatePanelRun?.pendingApprovals || 0}
                  busy={busy === "run"}
                  onRefresh={() => void refreshOperatorGateState()}
                  onCancel={() => void cancelOperatorGateRun()}
                  onFocusApprovals={focusPendingApprovals}
                />
              ) : null}
              {visibleError ? <CommandNoticeInlinePanel tone="danger" title="Command failed" message={visibleError} onClose={() => setError(null)} /> : null}
              {workspaceNotice ? (
                <CommandNoticeInlinePanel
                  tone={workspaceNoticeTone(workspaceNotice)}
                  title={workspaceNoticeTitle(workspaceNotice)}
                  message={workspaceNotice}
                  onClose={() => setWorkspaceNotice(null)}
                />
              ) : null}

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
            <div ref={approvalPanelRef} id="pending-harness-approvals" className="space-y-3 rounded-[14px] border border-warning/35 bg-warning/5 p-4" role="status" aria-label="Pending Harness approvals">
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

          {busy === "send" && activePromptRunId && approvals.length === 0 && activePromptTraceCount === 0 && !activeChatGptResponseText && (hasChatGptLiveProgress || (runningToolCount === 0 && activeJobs.length === 0)) ? (
            <ChatGptLiveProgressRow
              tools={chatGptLiveTools}
              diff={chatGptLiveDiff}
              cancelling={promptCancelling}
              onCancel={() => void cancelActivePrompt()}
            />
          ) : null}
          <div ref={messageTailRef} className="h-px" aria-hidden="true" />
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
                <p className="px-3 py-4 text-xs text-muted-foreground">No saved conversations found in this workspace.</p>
              ) : (
                <div
                  ref={resumeMenuRef}
                  className="max-h-72 overflow-auto p-1.5"
                  role="listbox"
                  aria-label="Saved conversations"
                  aria-activedescendant={`resume-conversation-option-${activeResumeSelectionIndex}`}
                >
                  {resumeItems.map((summary, index) => {
                    const run = summary.run;
                    const current = Boolean(summary.runId && summary.runId === selectedRunId);
                    const selected = index === activeResumeSelectionIndex;
                    return (
                      <button
                        key={summary.conversationId ?? summary.threadId ?? `${summary.runId ?? "conversation"}:${summary.updatedAt}`}
                        id={`resume-conversation-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`relative flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors ${selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-muted/55"}`}
                        onMouseEnter={() => setResumeSelectionIndex(index)}
                        onClick={() => void resumeNativeConversation(summary)}
                      >
                        {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-[12px] font-semibold ${selected ? "text-primary" : "text-foreground"}`}>{summary.title}</span>
                          {summary.preview && summary.preview !== summary.title ? <span className="mt-1 block truncate text-[11px] text-muted-foreground">{summary.preview}</span> : null}
                          <span className="mt-1.5 block text-[10px] text-muted-foreground">
                            {summary.source === "chatgpt" ? "ChatGPT" : "Native Codex"}{summary.model ? ` · ${summary.model}` : ""} · {humanizeActivity(summary.status)} · {new Date(summary.updatedAt).toLocaleString()}
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

          {agentPickerOpen ? (
            <div className="mb-2 overflow-hidden rounded-[12px] border border-border bg-card shadow-[0_10px_30px_var(--sn-shadow)]">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <div>
                  <p className="text-xs font-semibold text-foreground">Choose agent</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">Select which agent handles new prompts.</p>
                </div>
                <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setAgentPickerOpen(false)}>Close</button>
              </div>
              <div
                ref={agentMenuRef}
                className="p-1.5"
                role="listbox"
                aria-label="Agents"
                aria-activedescendant={`agent-option-${agentSelectionIndex}`}
              >
                {HARNESS_AGENT_OPTIONS.map((agent, index) => {
                  const selected = index === agentSelectionIndex;
                  const current = selectedAgent === agent.id;
                  const Icon = agent.id === "codex" ? Command : Bot;
                  return (
                    <button
                      key={agent.id}
                      id={`agent-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`relative flex min-h-[52px] w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left transition-colors ${selected ? "bg-[var(--sn-sidebar-active)] text-foreground shadow-[inset_0_0_0_1px_var(--border)]" : "hover:bg-muted/55"}`}
                      onMouseEnter={() => setAgentSelectionIndex(index)}
                      onClick={() => chooseHarnessAgentFromPicker(agent.id)}
                    >
                      {selected ? <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" /> : null}
                      <Icon className={`size-3.5 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs font-semibold ${selected ? "text-primary" : "text-foreground"}`}>{agent.label}</span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">{agent.description}</span>
                      </span>
                      {current ? <span className="status-pill shrink-0">Current</span> : null}
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

          <div className="mb-2 flex flex-wrap items-center justify-between gap-3 px-1 text-[10px] text-muted-foreground">
            <span>
              Agent: <span className="font-medium text-foreground">{agentLabel(selectedAgent)}</span>
              <span className="mx-1">·</span>
              Model: <span className="font-medium text-foreground">{selectedAgentModel}</span>
            </span>
            <span>
              {chatGptAgentActive
                ? (reviewLoopPhase ? `${agentLabel(selectedAgent)}: ${reviewLoopPhase}` : chatGptDirectAgentActive ? "ChatGPT Web → Harness verify" : `${agentLabel(selectedAgent)} Web → native Codex execution → Harness verify`)
                : "Native Codex agent"} · use /agents, /model, /goal, /loop
            </span>
          </div>

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
                if (agentPickerOpen && nextPrompt.trim() !== "/agents") setAgentPickerOpen(false);
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
                  if (item) void resumeNativeConversation(item);
                  return;
                }
                if (agentPickerOpen && event.key === "ArrowDown") {
                  event.preventDefault();
                  setAgentSelectionIndex((current) => (current + 1) % HARNESS_AGENT_OPTIONS.length);
                  return;
                }
                if (agentPickerOpen && event.key === "ArrowUp") {
                  event.preventDefault();
                  setAgentSelectionIndex((current) => (current - 1 + HARNESS_AGENT_OPTIONS.length) % HARNESS_AGENT_OPTIONS.length);
                  return;
                }
                if (agentPickerOpen && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const agent = HARNESS_AGENT_OPTIONS[agentSelectionIndex] ?? HARNESS_AGENT_OPTIONS[0];
                  if (agent) chooseHarnessAgentFromPicker(agent.id);
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
                if (event.key === "Escape" && (resumeOpen || permissionOpen || agentPickerOpen)) {
                  event.preventDefault();
                  setResumeOpen(false);
                  setPermissionOpen(false);
                  setAgentPickerOpen(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
                placeholder={operatorGateActive ? "Harness is waiting for approval, recovery, or cancellation…" : nativeHydrationBlocking ? "Restoring conversation…" : promptIsBangCommand ? "Run command in workspace…" : "Message Harness…"}
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

function ConversationMessageRow({
  message,
  continuation,
}: {
  message: DesktopHarnessCodexConversationMessage;
  continuation: boolean;
}) {
  if (message.role === "user") {
    return (
      <article className="w-full" aria-label="User message">
        <div className="ml-auto max-w-[82%] rounded-[12px] border border-border/45 bg-muted/35 px-4 py-3 text-foreground">
          <CollapsibleUserPrompt text={message.text} />
        </div>
      </article>
    );
  }

  return (
    <article className={`w-full ${continuation ? "!mt-1" : ""}`} aria-label="Assistant response">
      <HarnessMarkdown text={message.text} />
    </article>
  );
}

function CollapsibleUserPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = userPromptShouldCollapse(text);

  if (!collapsible) {
    return <p className="whitespace-pre-wrap text-[14px] leading-6">{text}</p>;
  }

  return (
    <div className="space-y-2" aria-label="Collapsible user prompt">
      <div
        className="relative overflow-hidden transition-[max-height] duration-200"
        style={expanded ? undefined : { maxHeight: `${USER_PROMPT_PREVIEW_MAX_HEIGHT_REM}rem` }}
      >
        <p className="whitespace-pre-wrap text-[14px] leading-6">{text}</p>
        {!expanded ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-muted/35 via-muted/25 to-transparent" aria-hidden="true" /> : null}
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-0 py-1 text-[13px] text-muted-foreground transition hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span>{expanded ? "Show less" : "Show more"}</span>
        <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
}

function userPromptShouldCollapse(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return false;
  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > USER_PROMPT_PREVIEW_LINES) return true;
  return normalized.length > 520;
}
function assistantStreamContinuation(feedItems: ConversationFeedItem[], index: number): boolean {
  const current = feedItems[index];
  if (!current || current.kind !== "message" || current.message.role !== "assistant") return false;

  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = feedItems[previousIndex];
    if (previous.kind !== "message") continue;
    if (previous.message.role !== "assistant") return false;

    if (current.message.turnId && previous.message.turnId) {
      return current.message.turnId === previous.message.turnId;
    }
    if (current.message.turnId || previous.message.turnId) return false;

    // Older persisted/native history may not carry turnId. The app-server gives
    // all agentMessage items from one turn the same createdAt, so use that as a
    // bounded compatibility fallback instead of repeating the Harness header.
    return current.message.createdAt === previous.message.createdAt;
  }

  return false;
}

function ChatGptLiveProgressRow({
  tools,
  diff,
  cancelling,
  onCancel,
}: {
  tools: ChatGptLiveTool[];
  diff: string;
  cancelling: boolean;
  onCancel(): void;
}) {
  const failedTools = tools.filter((tool) => /failed|blocked|error/i.test(tool.stage)).length;
  const diffStats = diff ? unifiedDiffStats(diff) : { additions: 0, deletions: 0 };
  const liveSummary = tools.length > 0 || diffStats.additions > 0 || diffStats.deletions > 0
    ? [
      tools.length > 0 ? `Used ${tools.length} tool${tools.length === 1 ? "" : "s"}` : "",
      diffStats.additions > 0 ? `+${diffStats.additions}` : "",
      diffStats.deletions > 0 ? `-${diffStats.deletions}` : "",
      failedTools > 0 ? `(${failedTools} failed)` : "",
    ].filter(Boolean).join(" ")
    : "";
  return (
    <div className="space-y-2" aria-label="Live ChatGPT progress">
      {liveSummary ? <div className={`text-[13px] ${failedTools ? "text-danger" : "text-muted-foreground"}`}>{liveSummary}</div> : null}
      <div className="flex items-center justify-between gap-4 pt-1">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground" role="status" aria-live="polite">
          <span>Thinking</span>
          <span className="inline-flex items-end gap-1" aria-hidden="true">
            <span className="size-1.5 rounded-full bg-current animate-bounce [animation-duration:0.9s] [animation-delay:-0.30s]" />
            <span className="size-1.5 rounded-full bg-current animate-bounce [animation-duration:0.9s] [animation-delay:-0.15s]" />
            <span className="size-1.5 rounded-full bg-current animate-bounce [animation-duration:0.9s]" />
          </span>
        </div>
        <ActionButton variant="ghost" size="sm" onClick={onCancel} disabled={cancelling} aria-label="Cancel running prompt">
          {cancelling ? "Cancelling…" : "Cancel"}
        </ActionButton>
      </div>
    </div>
  );
}

function claudeLiveToolSummary(tool: ChatGptLiveTool): string {
  if (/failed|blocked|error/i.test(tool.stage)) return `${tool.label} (failed)`;
  return tool.label;
}


function chatGptLiveToolStableId(label: string, event: Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" }>): string {
  const subject = event.functionName || label;
  const details = event.parameters || event.input || "";
  return `chatgpt-tool:${stableTraceKey(subject)}:${stableTraceKey(details).slice(0, 36)}`;
}

function stableTraceKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

function mergeChatGptLiveDiff(
  current: string,
  event: Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" }>,
): string {
  if (!current.trim()) return event.text;
  const filePath = event.filePath ?? extractUnifiedDiffPaths(event.text)[0] ?? "";
  if (!filePath) return event.text;
  const incoming = splitUnifiedDiffByFile(event.text).find((section) => section.path === filePath)?.diff ?? event.text;
  let replaced = false;
  const merged = splitUnifiedDiffByFile(current).map((section) => {
    if (section.path !== filePath) return section.diff;
    replaced = true;
    return incoming;
  });
  if (!replaced) merged.push(incoming);
  return merged.filter(Boolean).join("\n");
}

function mergeChatGptLiveTool(
  current: ChatGptLiveTool[],
  event: Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" }>,
): ChatGptLiveTool[] {
  const [rawLabel] = event.text.split(/\s+·\s+/, 2);
  const label = rawLabel?.trim() || "Harness tool";
  const stage = event.stage ?? event.text.split(/\s+·\s+/, 2)[1]?.trim() ?? "started";
  const stableId = event.itemId ?? chatGptLiveToolStableId(label, event);
  let index = current.findIndex((tool) => tool.id === stableId || Boolean(event.itemId && tool.itemId === event.itemId));
  if (index < 0) {
    const parameters = event.parameters ?? event.input ?? "";
    for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) {
      const tool = current[candidate]!;
      const unfinished = !/result|completed|failed|blocked|error|success/i.test(tool.stage);
      const compatibleInput = !parameters || !tool.input || tool.input === parameters;
      if (tool.label === label && unfinished && compatibleInput) {
        index = candidate;
        break;
      }
    }
  }
  if (index < 0) {
    return [...current, {
      id: stableId,
      ...(event.itemId ? { itemId: event.itemId } : {}),
      label,
      stage,
      ...(event.input ? { input: event.input } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    }].slice(-24);
  }
  const previous = current[index]!;
  const next = [...current];
  next[index] = {
    ...previous,
    ...(event.itemId ? { itemId: event.itemId } : previous.itemId ? { itemId: previous.itemId } : {}),
    label,
    stage: strongestChatGptLiveToolStage(previous.stage, stage),
    ...(event.input ? { input: event.input } : previous.input ? { input: previous.input } : {}),
    ...(event.output ? { output: event.output } : previous.output ? { output: previous.output } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : previous.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
  };
  return next.slice(-24);
}

function strongestChatGptLiveToolStage(left: string, right: string): string {
  const failed = (value: string) => /failed|blocked|error/i.test(value);
  const completed = (value: string) => /result|completed|success/i.test(value);
  const streaming = (value: string) => /stream/i.test(value);
  if (failed(left) || failed(right)) return failed(right) ? right : left;
  if (completed(left) || completed(right)) return completed(right) ? right : left;
  if (streaming(left) || streaming(right)) return streaming(right) ? right : left;
  return right;
}

function ClaudeCodexTraceGroup({ entries, hideSummary = false }: { entries: CodexTraceItem[]; hideSummary?: boolean }) {
  const displayEntries = entries.flatMap(expandCodexTraceEntryForDisplay);
  const compactEntries = compactCodexTraceDisplayEntries(displayEntries);
  const fileOnly = compactEntries.length > 0 && compactEntries.every((entry) => entry.kind === "file" && entry.diff);
  if (hideSummary && !fileOnly) {
    return (
      <div className="overflow-hidden rounded-[10px] border border-border/55 bg-background/35" aria-label="Live activity rows">
        {compactEntries.map((entry, index) => (
          <ClaudeCodexActivityRow key={entry.id} entry={entry} divided={index > 0} />
        ))}
      </div>
    );
  }
  if (fileOnly) {
    const combinedDiff = compactEntries.map((entry) => entry.diff ?? "").filter(Boolean).join("\n");
    const fileCount = new Set(compactEntries.flatMap((entry) => entry.diff ? extractUnifiedDiffPaths(entry.diff) : [])).size || compactEntries.length;
    return (
      <details className="group w-full" aria-label="Changed files group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
          <span>{`Edited ${fileCount} file${fileCount === 1 ? "" : "s"}`}</span>
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        </summary>
        <ClaudeFileDiffList diff={combinedDiff} />
      </details>
    );
  }
  if (compactEntries.length === 1) return <ClaudeCodexTraceRow entry={compactEntries[0]!} />;
  const failed = compactEntries.filter((entry) => entry.stage === "failed").length;
  const running = compactEntries.some((entry) => entry.stage === "started" || entry.stage === "streaming");
  return (
    <details className="group w-full" aria-label="Codex activity group">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 text-[13px] ${failed ? "text-danger" : "text-muted-foreground hover:text-foreground"}`}>
        {running ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
        <ClaudeTraceGroupSummary entries={compactEntries} />
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-2 overflow-hidden rounded-[10px] border border-border/55 bg-background/35">
        {compactEntries.map((entry, index) => (
          <ClaudeCodexActivityRow key={entry.id} entry={entry} divided={index > 0} />
        ))}
      </div>
    </details>
  );
}

function compactCodexTraceDisplayEntries(entries: CodexTraceItem[]): CodexTraceItem[] {
  const byKey = new Map<string, CodexTraceItem>();
  const orderedKeys: string[] = [];
  for (const entry of entries) {
    const key = codexTraceDisplayKey(entry);
    const previous = byKey.get(key);
    if (!previous) orderedKeys.push(key);
    byKey.set(key, mergeCodexTraceDisplayEntry(previous, entry));
  }
  return orderedKeys.map((key) => byKey.get(key)!).filter(Boolean);
}

function mergeCodexTraceDisplayEntry(previous: CodexTraceItem | undefined, incoming: CodexTraceItem): CodexTraceItem {
  if (!previous) return incoming;
  return {
    ...previous,
    ...incoming,
    id: previous.id,
    createdAt: previous.createdAt,
    updatedAt: Math.max(previous.updatedAt, incoming.updatedAt),
    text: incoming.text ?? previous.text,
    output: incoming.output ?? previous.output,
    diff: incoming.diff ?? previous.diff,
    command: incoming.command ?? previous.command,
    functionName: incoming.functionName ?? previous.functionName,
    parameters: incoming.parameters ?? previous.parameters,
    filePath: incoming.filePath ?? previous.filePath,
    additions: incoming.additions ?? previous.additions,
    deletions: incoming.deletions ?? previous.deletions,
    durationMs: incoming.durationMs ?? previous.durationMs,
    exitCode: incoming.exitCode ?? previous.exitCode,
    status: incoming.status ?? previous.status,
    stage: strongestTraceStage(previous.stage, incoming.stage),
  };
}

function codexTraceDisplayKey(entry: CodexTraceItem): string {
  if (entry.kind === "file") {
    const paths = entry.diff ? extractUnifiedDiffPaths(entry.diff) : [];
    return `file:${entry.filePath ?? paths[0] ?? entry.itemId ?? entry.id}`;
  }
  if (entry.kind === "command") return `command:${entry.command ?? entry.itemId ?? entry.id}`;
  if (entry.kind === "tool") return `tool:${entry.functionName ?? entry.label}:${entry.parameters ?? entry.itemId ?? ""}`;
  return `${entry.kind}:${entry.itemId ?? entry.id}`;
}

function strongestTraceStage(left: CodexTraceItem["stage"], right: CodexTraceItem["stage"]): CodexTraceItem["stage"] {
  if (left === "failed" || right === "failed") return "failed";
  if (left === "completed" || right === "completed") return "completed";
  if (left === "streaming" || right === "streaming") return "streaming";
  return "started";
}

function ClaudeTraceGroupSummary({ entries }: { entries: CodexTraceItem[] }) {
  const stats = codexTraceGroupStats(entries);
  return (
    <span>
      {stats.label}
      {stats.additions > 0 || stats.deletions > 0 ? (
        <>
          {" "}<span className="text-success">+{stats.additions}</span>{" "}<span className="text-danger">-{stats.deletions}</span>
        </>
      ) : null}
      {stats.failed > 0 ? <span className="text-danger"> {`(${stats.failed} failed)`}</span> : null}
    </span>
  );
}

function ClaudeCodexActivityRow({ entry, divided }: { entry: CodexTraceItem; divided: boolean }) {
  const failed = entry.stage === "failed";
  const running = entry.stage === "started" || entry.stage === "streaming";
  const expandable = traceEntryExpandable(entry);
  const row = (
    <div className={`flex min-h-11 items-center gap-2 px-3 py-2 text-[12px] transition-colors hover:bg-muted/25 ${divided ? "border-t border-border/45" : ""}`}>
      {running ? <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
      <span className={`min-w-0 flex-1 ${failed ? "text-danger" : "text-muted-foreground"}`}><ClaudeTraceRowLabel entry={entry} /></span>
      <span className={`shrink-0 text-[10px] ${failed ? "text-danger" : running ? "text-warning" : "text-muted-foreground/65"}`}>{traceStageLabel(entry.stage)}</span>
      {entry.durationMs !== undefined ? <span className="shrink-0 text-[10px] text-muted-foreground/65">{formatDuration(entry.durationMs)}</span> : null}
      {expandable ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-open/activity:rotate-90" aria-hidden="true" /> : null}
    </div>
  );
  if (!expandable) return row;
  return (
    <details className="group/activity">
      <summary className="cursor-pointer list-none">{row}</summary>
      <div className="border-t border-border/35 px-3 py-2.5">
        <ClaudeActivityDetails entry={entry} />
      </div>
    </details>
  );
}

function ClaudeTraceRowLabel({ entry }: { entry: CodexTraceItem }) {
  if (entry.kind !== "file" || !entry.diff) return <>{codexTraceSummary(entry)}</>;
  const stats = unifiedDiffStats(entry.diff);
  const subject = codexTraceSummary(entry).replace(/\s+\+\d+\s+-\d+$/, "");
  return <>{subject} <span className="text-success">+{stats.additions}</span> <span className="text-danger">-{stats.deletions}</span></>;
}

function codexTraceGroupStats(entries: CodexTraceItem[]): { label: string; additions: number; deletions: number; failed: number } {
  const commands = entries.filter((entry) => entry.kind === "command").length;
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const tools = entries.filter((entry) => entry.kind === "tool").length;
  const failed = entries.filter((entry) => entry.stage === "failed").length;
  const uniqueFiles = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const entry of fileEntries) {
    if (!entry.diff) continue;
    const stats = unifiedDiffStats(entry.diff);
    additions += stats.additions;
    deletions += stats.deletions;
    for (const path of extractUnifiedDiffPaths(entry.diff)) uniqueFiles.add(path);
  }
  const files = uniqueFiles.size || fileEntries.length;
  let label = "";
  if (files > 0) {
    label = `Edited ${files} file${files === 1 ? "" : "s"}`;
    if (commands > 0) label += `, ran ${commands} command${commands === 1 ? "" : "s"}`;
    if (tools > 0) label += `, used ${tools} tool${tools === 1 ? "" : "s"}`;
  } else if (commands > 0) {
    label = `Ran ${commands} command${commands === 1 ? "" : "s"}`;
    if (tools > 0) label += `, used ${tools} tool${tools === 1 ? "" : "s"}`;
  } else if (tools > 0) {
    label = `Used ${tools} tool${tools === 1 ? "" : "s"}`;
  } else {
    label = `Ran ${entries.length} action${entries.length === 1 ? "" : "s"}`;
  }
  return { label, additions, deletions, failed };
}

function codexTraceGroupSummary(entries: CodexTraceItem[]): string {
  const stats = codexTraceGroupStats(entries);
  const changes = stats.additions > 0 || stats.deletions > 0 ? ` +${stats.additions} -${stats.deletions}` : "";
  return `${stats.label}${changes}${stats.failed > 0 ? ` (${stats.failed} failed)` : ""}`;
}

function ClaudeCodexTraceRow({ entry }: { entry: CodexTraceItem }) {
  if (entry.kind === "response") {
    if (!entry.text?.trim()) return null;
    return (
      <article className="w-full" aria-label="Streaming assistant response">
        <HarnessMarkdown text={entry.text} />
      </article>
    );
  }

  if (entry.kind === "reasoning") {
    if (!entry.text?.trim()) return null;
    return (
      <article className="w-full rounded-[10px] border border-border/45 bg-muted/15 px-3 py-2.5" aria-label="Reasoning summary">
        <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-muted-foreground/70">
          <span>Reasoning</span>
          <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground">{entry.text}</p>
      </article>
    );
  }

  const failed = entry.stage === "failed";
  const running = entry.stage === "started" || entry.stage === "streaming";
  const summary = codexTraceSummary(entry);
  const expandable = traceEntryExpandable(entry);
  const header = (
    <div className={`flex min-h-11 items-center gap-2 rounded-[10px] border border-border/55 bg-background/35 px-3 py-2 text-[12px] transition-colors hover:bg-muted/25 ${failed ? "text-danger" : "text-muted-foreground"}`}>
      {running ? <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1"><ClaudeTraceRowLabel entry={entry} /></span>
      <span className={`shrink-0 text-[10px] ${failed ? "text-danger" : running ? "text-warning" : "text-muted-foreground/65"}`}>{traceStageLabel(entry.stage)}</span>
      {entry.durationMs !== undefined ? <span className="shrink-0 text-[10px] text-muted-foreground/65">{formatDuration(entry.durationMs)}</span> : null}
      {expandable ? <ChevronRight className="size-3.5 shrink-0 transition-transform group-open/activity:rotate-90" aria-hidden="true" /> : null}
    </div>
  );
  if (!expandable) return header;
  return (
    <details className="group/activity w-full" aria-label="Execution activity">
      <summary className="cursor-pointer list-none">{header}</summary>
      <div className="mt-1.5 rounded-[10px] border border-border/45 bg-background/25 p-3">
        <ClaudeActivityDetails entry={entry} />
      </div>
    </details>
  );
}

function traceEntryExpandable(entry: CodexTraceItem): boolean {
  return Boolean(entry.command || entry.parameters || entry.output || entry.diff || entry.functionName || entry.filePath || entry.status || entry.exitCode !== undefined || entry.durationMs !== undefined);
}

function traceStageLabel(stage: CodexTraceItem["stage"]): string {
  if (stage === "started") return "running";
  if (stage === "streaming") return "streaming";
  if (stage === "failed") return "failed";
  return "success";
}

function ClaudeActivityDetails({ entry }: { entry: CodexTraceItem }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 text-[10px] text-muted-foreground sm:grid-cols-2">
        {entry.functionName ? <div><span className="font-semibold text-foreground">Tool</span><p className="mt-0.5 break-all font-mono">{entry.functionName}</p></div> : null}
        {entry.filePath ? <div><span className="font-semibold text-foreground">Path</span><p className="mt-0.5 break-all font-mono">{entry.filePath}</p></div> : null}
        <div><span className="font-semibold text-foreground">Started</span><p className="mt-0.5">{new Date(entry.createdAt).toLocaleString()}</p></div>
        <div><span className="font-semibold text-foreground">Status</span><p className="mt-0.5">{traceStageLabel(entry.stage)}{entry.durationMs !== undefined ? ` · ${formatDuration(entry.durationMs)}` : ""}{entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ""}</p></div>
      </div>
      {entry.parameters ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Input</p>
          <ClaudeOutputBlock text={entry.parameters} copyLabel="Copy input" />
        </div>
      ) : null}
      {entry.kind === "command" && entry.command ? <ClaudeCommandOutput entry={entry} /> : null}
      {entry.kind === "file" && entry.diff ? <ClaudeFileDiffOutput diff={entry.diff} /> : null}
      {entry.kind !== "command" && entry.kind !== "file" && entry.output ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Output</p>
          <ClaudeOutputBlock text={entry.output} copyLabel="Copy output" />
        </div>
      ) : null}
      {entry.kind === "file" && !entry.diff && entry.output ? <ClaudeOutputBlock text={entry.output} copyLabel="Copy file output" /> : null}
    </div>
  );
}

function ClaudeCommandOutput({ entry }: { entry: CodexTraceItem }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-300">
      {entry.command ? (
        <div className="flex items-start gap-2 border-b border-zinc-800 px-3 py-2 font-mono text-[11px] text-zinc-200">
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            <span className="mr-2 text-muted-foreground">$</span>{entry.command}
          </div>
          <button
            type="button"
            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
            onClick={() => { void navigator.clipboard?.writeText(entry.command ?? ""); }}
            aria-label="Copy command"
            title="Copy command"
          >
            <Copy className="size-3" aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {entry.output ? <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-zinc-400">{entry.output}</pre> : null}
      {entry.stage !== "started" || entry.exitCode !== undefined || entry.durationMs !== undefined ? (
        <div className="flex gap-3 border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-500">
          {entry.exitCode !== undefined ? <span>exit {entry.exitCode}</span> : null}
          {entry.durationMs !== undefined ? <span>{formatDuration(entry.durationMs)}</span> : null}
          {entry.status ? <span>{humanizeActivity(entry.status)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ClaudeFileDiffList({ diff }: { diff: string }) {
  const sections = splitUnifiedDiffByFile(diff);
  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-border/55 bg-background/35" aria-label="Changed files">
      {sections.map((section, index) => {
        const stats = unifiedDiffStats(section.diff);
        const path = section.path || extractUnifiedDiffPaths(section.diff)[0] || `Changed file ${index + 1}`;
        return (
          <details key={`${path}:${index}`} className="group/file border-t border-border/45 first:border-t-0">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted/25">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90" title={path}>{path}</span>
              <span className="shrink-0 text-success">+{stats.additions}</span>
              <span className="shrink-0 text-danger">-{stats.deletions}</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-open/file:rotate-90" aria-hidden="true" />
            </summary>
            <div className="border-t border-border/35 p-2">
              <ClaudeDiffBlock diff={section.diff} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

function ClaudeFileDiffOutput({ diff }: { diff: string }) {
  const sections = splitUnifiedDiffByFile(diff);
  if (sections.length > 1) return <ClaudeFileDiffList diff={diff} />;
  const section = sections[0];
  const path = section?.path || extractUnifiedDiffPaths(diff)[0] || "";
  const sectionDiff = section?.diff ?? diff;
  return (
    <div className="space-y-2.5">
      {path ? <p className="truncate text-[11px] text-muted-foreground" title={path}>{path}</p> : null}
      <ClaudeDiffBlock diff={sectionDiff} />
    </div>
  );
}

function ClaudeOutputBlock({ text, copyLabel = "Copy output" }: { text: string; copyLabel?: string }) {
  return (
    <div className="relative overflow-hidden rounded-[10px] border border-zinc-800 bg-zinc-950 text-zinc-300">
      <button
        type="button"
        className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-[6px] border border-zinc-800 bg-zinc-900/90 text-zinc-400 transition-colors hover:text-zinc-100"
        onClick={() => { void navigator.clipboard?.writeText(text); }}
        aria-label={copyLabel}
        title={copyLabel}
      >
        <Copy className="size-3" aria-hidden="true" />
      </button>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 pr-12 font-mono text-[11px] leading-[1.55]">{text}</pre>
    </div>
  );
}

function ClaudeDiffBlock({ diff }: { diff: string }) {
  const lines = parseUnifiedDiff(diff);
  return (
    <div className="relative max-h-[520px] overflow-auto rounded-[10px] border border-zinc-800 bg-zinc-950 font-mono text-[11px] leading-[1.55] text-zinc-300" aria-label="Unified diff output">
      <button
        type="button"
        className="sticky right-2 top-2 z-20 float-right mr-2 mt-2 grid size-7 place-items-center rounded-[6px] border border-zinc-800 bg-zinc-900/90 text-zinc-400 transition-colors hover:text-zinc-100"
        onClick={() => { void navigator.clipboard?.writeText(diff); }}
        aria-label="Copy diff"
        title="Copy diff"
      >
        <Copy className="size-3" aria-hidden="true" />
      </button>
      {lines.map((line, index) => {
        if (line.hidden) return null;
        const tone = line.kind === "add"
          ? "bg-emerald-950/55 text-emerald-300"
          : line.kind === "delete"
            ? "bg-red-950/55 text-red-300"
            : line.kind === "hunk"
              ? "bg-zinc-900 text-zinc-400"
              : "text-zinc-400";
        return (
          <div key={`${index}:${line.text}`} className={`grid min-w-max grid-cols-[48px_minmax(0,1fr)] ${tone}`}>
            <span className="select-none border-r border-border/30 px-2 py-px text-right text-[10px] opacity-65">{line.lineNumber ?? ""}</span>
            <span className="whitespace-pre px-3 py-px">{line.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

type ParsedDiffLine = { text: string; kind: "add" | "delete" | "context" | "hunk"; lineNumber?: number; hidden?: boolean };

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return diff.replace(/\r\n/g, "\n").split("\n").map((text) => {
    const hunk = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      newLine = Number.parseInt(hunk[2]!, 10);
      return { text, kind: "hunk" as const, hidden: true };
    }
    if (/^(?:diff --git|index\s|---\s|\+\+\+\s)/.test(text)) return { text, kind: "context" as const, hidden: true };
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const lineNumber = newLine || undefined;
      newLine += 1;
      return { text, kind: "add" as const, ...(lineNumber ? { lineNumber } : {}) };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const lineNumber = oldLine || undefined;
      oldLine += 1;
      return { text, kind: "delete" as const, ...(lineNumber ? { lineNumber } : {}) };
    }
    if (oldLine > 0 || newLine > 0) {
      const lineNumber = newLine || oldLine || undefined;
      oldLine += 1;
      newLine += 1;
      return { text, kind: "context" as const, ...(lineNumber ? { lineNumber } : {}) };
    }
    return { text, kind: "context" as const };
  });
}

function claudeDiffSummary(diff: string): string {
  const { additions, deletions } = unifiedDiffStats(diff);
  const uniquePaths = extractUnifiedDiffPaths(diff);
  const subject = uniquePaths.length === 1 ? `Edited ${basenamePath(uniquePaths[0]!)}` : uniquePaths.length > 1 ? `Edited ${uniquePaths.length} files` : "Edited files";
  return `${subject} +${additions} -${deletions}`;
}

function unifiedDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function extractUnifiedDiffPaths(diff: string): string[] {
  const paths = [...diff.matchAll(/(?:^|\n)(?:\+\+\+|---)\s+(?:[ab]\/)?([^\n]+)/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value) && value !== "/dev/null");
  return [...new Set(paths)];
}

function expandCodexTraceEntryForDisplay(entry: CodexTraceItem): CodexTraceItem[] {
  if (entry.kind !== "file" || !entry.diff) return [entry];
  const sections = splitUnifiedDiffByFile(entry.diff);
  if (sections.length <= 1) return [entry];
  return sections.map((section, index) => ({
    ...entry,
    id: `${entry.id}:file:${index}`,
    label: section.path ? `Edited ${basenamePath(section.path)}` : entry.label,
    diff: section.diff,
  }));
}

function splitUnifiedDiffByFile(diff: string): Array<{ path: string; diff: string }> {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ path: string; diff: string }> = [];
  let current: string[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;

  const normalizeDiffPath = (value: string): string | null => {
    const trimmed = value.trim().split("\t", 1)[0]?.trim() ?? "";
    if (!trimmed || trimmed === "/dev/null") return null;
    return trimmed.replace(/^[ab]\//, "");
  };

  const flush = () => {
    if (current.length === 0) return;
    const path = newPath ?? oldPath ?? "";
    sections.push({ path, diff: current.join("\n") });
    current = [];
    oldPath = null;
    newPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) flush();
      current.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      if (current.some((candidate) => candidate.startsWith("--- "))) flush();
      oldPath = normalizeDiffPath(line.slice(4));
      current.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = normalizeDiffPath(line.slice(4));
      current.push(line);
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  flush();

  if (sections.length === 0) {
    const fallbackPath = extractUnifiedDiffPaths(diff)[0] ?? "";
    return [{ path: fallbackPath, diff }];
  }
  return sections;
}

function codexTraceSummary(entry: CodexTraceItem): string {
  if (entry.kind === "file") return entry.diff ? claudeDiffSummary(entry.diff).replace(/^Edited files/, entry.label) : entry.label;
  if (entry.kind === "command") return `${entry.label}${entry.stage === "failed" ? " (failed)" : ""}`;
  return `${entry.label}${entry.stage === "failed" ? " (failed)" : ""}`;
}

function claudeToolLine(value: string): string {
  const [label, status] = value.split(/\s+·\s+/, 2);
  if (!status || status === "result" || status === "completed") return label ?? value;
  if (status === "started" || status === "approved" || status === "requested") return label ?? value;
  return `${label ?? value} (${status})`;
}

function basenamePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function applyRuntimeActivityEvent(
  current: DesktopHarnessCodexActivityView[],
  event: Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" | "codex-progress" }>,
): DesktopHarnessCodexActivityView[] {
  const incoming = runtimeEventToActivityView(event);
  if (!incoming) return current;
  const index = current.findIndex((activity) => activity.id === incoming.id);
  if (index < 0) return [...current, incoming].sort(compareActivityOrder).slice(-12_000);

  const previous = current[index]!;
  const appendDelta = event.type === "codex-progress" && event.stage === "streaming";
  const next: DesktopHarnessCodexActivityView = {
    ...previous,
    ...incoming,
    createdAt: previous.createdAt,
    position: previous.position,
    text: incoming.text
      ? appendDelta && (incoming.kind === "reasoning" || incoming.kind === "response")
        ? boundedTraceText(`${previous.text ?? ""}${incoming.text}`)
        : incoming.text
      : previous.text,
    output: incoming.output
      ? appendDelta
        ? boundedTraceText(`${previous.output ?? ""}${incoming.output}`)
        : incoming.output
      : previous.output,
    diff: incoming.diff ?? previous.diff,
    command: incoming.command ?? previous.command,
    functionName: incoming.functionName ?? previous.functionName,
    parameters: incoming.parameters ?? previous.parameters,
    filePath: incoming.filePath ?? previous.filePath,
    additions: incoming.additions ?? previous.additions,
    deletions: incoming.deletions ?? previous.deletions,
  };
  const copy = [...current];
  copy[index] = next;
  return copy.sort(compareActivityOrder);
}

function runtimeEventToActivityView(
  event: Extract<DesktopRuntimeEvent, { type: "chatgpt-progress" | "codex-progress" }>,
): DesktopHarnessCodexActivityView | null {
  if (!event.activityId || event.position === undefined) return null;
  const timestamp = new Date(event.createdAt ?? Date.now()).toISOString();
  if (event.type === "codex-progress") {
    return {
      id: event.activityId,
      source: "codex",
      runId: event.runId,
      workspace: event.workspace,
      ...(event.threadId ? { threadId: event.threadId } : {}),
      turnId: event.turnId,
      itemId: event.itemId,
      kind: event.kind,
      stage: event.stage,
      label: event.label,
      createdAt: timestamp,
      updatedAt: timestamp,
      position: event.position,
      ...(event.text ? { text: event.text } : {}),
      ...(event.command ? { command: event.command } : {}),
      ...(event.cwd ? { cwd: event.cwd } : {}),
      ...(event.functionName ? { functionName: event.functionName } : {}),
      ...(event.parameters ? { parameters: event.parameters } : {}),
      ...(event.output ? { output: event.output } : {}),
      ...(event.diff ? { diff: event.diff } : {}),
      ...(event.filePath ? { filePath: event.filePath } : {}),
      ...(event.additions !== undefined ? { additions: event.additions } : {}),
      ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
      ...(event.status ? { status: event.status } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
  }

  const kind: DesktopHarnessCodexActivityView["kind"] = event.kind === "diff" ? "file" : event.kind;
  const stage: DesktopHarnessCodexActivityView["stage"] = event.kind === "response"
    ? event.generating === false ? "completed" : "streaming"
    : /failed|blocked|error/i.test(event.stage ?? "") ? "failed"
      : /result|completed|success/i.test(event.stage ?? "") ? "completed"
        : /stream/i.test(event.stage ?? "") ? "streaming"
          : event.kind === "reasoning" || event.kind === "diff" ? "completed" : "started";
  const label = event.kind === "response"
    ? "Response"
    : event.kind === "reasoning"
      ? event.text.trim().split("\n", 1)[0]?.slice(0, 180) || "Working"
      : event.kind === "diff"
        ? event.filePath ? `Edited ${basenamePath(event.filePath)}` : "Changed files"
        : event.text.split(/\s+·\s+/, 1)[0]?.trim() || event.functionName || "Tool call";
  return {
    id: event.activityId,
    source: "chatgpt",
    runId: event.runId,
    workspace: event.workspace,
    turnId: `chatgpt-review:${event.taskId}`,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    kind,
    stage,
    label,
    createdAt: timestamp,
    updatedAt: timestamp,
    position: event.position,
    ...(event.kind === "response" || event.kind === "reasoning" ? { text: event.text } : {}),
    ...(event.functionName ? { functionName: event.functionName } : {}),
    ...(event.parameters ?? event.input ? { parameters: event.parameters ?? event.input } : {}),
    ...(event.output ? { output: event.output } : {}),
    ...(event.kind === "diff" ? { diff: event.text } : {}),
    ...(event.filePath ? { filePath: event.filePath } : {}),
    ...(event.additions !== undefined ? { additions: event.additions } : {}),
    ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
    ...(event.stage ? { status: event.stage } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
  };
}

function compareActivityOrder(left: DesktopHarnessCodexActivityView, right: DesktopHarnessCodexActivityView): number {
  if (left.position !== right.position) return left.position - right.position;
  return left.createdAt.localeCompare(right.createdAt);
}

function isStaleChatGptNativeExecutionFailure(activity: DesktopHarnessCodexActivityView): boolean {
  if (activity.source !== "chatgpt" || activity.kind !== "tool") return false;
  if (!/failed|blocked|error/i.test(activity.stage)) return false;
  const text = `${activity.text ?? ""}
${activity.output ?? ""}
${activity.parameters ?? ""}`;
  return /Harness native execution requires a current running run/i.test(text);
}

function activityViewToTraceItem(activity: DesktopHarnessCodexActivityView): CodexTraceItem {
  return {
    id: activity.id,
    source: activity.source,
    runId: activity.runId,
    workspace: activity.workspace,
    ...(activity.threadId ? { threadId: activity.threadId } : {}),
    turnId: activity.turnId,
    itemId: activity.itemId ?? activity.id,
    kind: activity.kind,
    stage: activity.stage,
    label: activity.label,
    ...(activity.text ? { text: activity.text } : {}),
    ...(activity.command ? { command: activity.command } : {}),
    ...(activity.cwd ? { cwd: activity.cwd } : {}),
    ...(activity.functionName ? { functionName: activity.functionName } : {}),
    ...(activity.parameters ? { parameters: activity.parameters } : {}),
    ...(activity.output ? { output: activity.output } : {}),
    ...(activity.diff ? { diff: activity.diff } : {}),
    ...(activity.filePath ? { filePath: activity.filePath } : {}),
    ...(activity.additions !== undefined ? { additions: activity.additions } : {}),
    ...(activity.deletions !== undefined ? { deletions: activity.deletions } : {}),
    ...(activity.status ? { status: activity.status } : {}),
    ...(activity.exitCode !== undefined ? { exitCode: activity.exitCode } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
    position: activity.position,
    createdAt: new Date(activity.createdAt).getTime(),
    updatedAt: new Date(activity.updatedAt).getTime(),
  };
}

function applyCodexProgressEvent(current: CodexTraceItem[], event: CodexProgressRuntimeEvent): CodexTraceItem[] {
  const now = Date.now();
  const { type: _runtimeType, ...progress } = event;
  const id = `codex:${event.runId}:${event.turnId}:${event.itemId}:${event.kind}`;
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) {
    const next: CodexTraceItem = { ...progress, id, createdAt: now, updatedAt: now };
    return [...current, next].slice(-240);
  }

  const previous = current[index]!;
  const appendOutput = event.stage === "streaming" && event.output;
  const appendText = (event.kind === "reasoning" || event.kind === "response") && event.stage === "streaming" && event.text;
  const next: CodexTraceItem = {
    ...previous,
    ...progress,
    label: ((event.kind === "command" && event.label === "Ran command") || (event.kind === "file" && event.label === "Edited file")) && previous.label !== event.label ? previous.label : event.label,
    id,
    createdAt: previous.createdAt,
    updatedAt: now,
    ...(appendText ? { text: boundedTraceText(`${previous.text ?? ""}${event.text ?? ""}`) } : event.text ? { text: event.text } : previous.text ? { text: previous.text } : {}),
    ...(appendOutput ? { output: boundedTraceText(`${previous.output ?? ""}${event.output ?? ""}`) } : event.output ? { output: event.output } : previous.output ? { output: previous.output } : {}),
    ...(event.diff ? { diff: event.diff } : previous.diff ? { diff: previous.diff } : {}),
    ...(event.command ? { command: event.command } : previous.command ? { command: previous.command } : {}),
  };
  const copy = [...current];
  copy[index] = next;
  return copy;
}

function boundedTraceText(value: string): string {
  return value.length <= 120_000 ? value : `${value.slice(value.length - 119_999)}…`;
}

function HarnessMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-[14px] leading-[1.7] text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_a]:break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border/70 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:break-words [&_code]:rounded-[4px] [&_code]:bg-muted/55 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-primary [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-[15px] [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-border/60 [&_li]:my-0.5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2.5 [&_pre]:my-3 [&_pre]:max-h-[520px] [&_pre]:overflow-auto [&_pre]:rounded-[9px] [&_pre]:border [&_pre]:border-border/55 [&_pre]:bg-background/55 [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-[11px] [&_pre]:leading-[1.55] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_table]:w-full [&_table]:border-collapse [&_table]:text-[12px] [&_td]:border [&_td]:border-border/60 [&_td]:px-2.5 [&_td]:py-2 [&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/35 [&_th]:px-2.5 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-[10px]">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const inlineCommandControlClass = "h-9 w-full rounded-[9px] border border-border bg-background px-2.5 text-xs text-foreground outline-none transition focus:border-foreground/35 disabled:cursor-not-allowed disabled:opacity-50";

function CommandNoticeInlinePanel({
  tone,
  title,
  message,
  onClose,
}: {
  tone: "success" | "danger" | "warning";
  title: string;
  message: string;
  onClose(): void;
}) {
  const toneClass = tone === "danger"
    ? "border-danger/30 bg-danger/5"
    : tone === "warning"
      ? "border-warning/35 bg-warning/5"
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

function HarnessOperatorGateInlinePanel({
  run,
  approvalCount,
  busy,
  onRefresh,
  onCancel,
  onFocusApprovals,
}: {
  run: DesktopHarnessRunView | null;
  approvalCount: number;
  busy: boolean;
  onRefresh(): void;
  onCancel(): void;
  onFocusApprovals(): void;
}) {
  const hasPendingApproval = approvalCount > 0;
  const canCancel = Boolean(run && run.status === "running");
  const message = hasPendingApproval
    ? "Resolve the pending Harness approval before continuing. The approval card is shown below."
    : run?.uncertainMutations
      ? "Harness paused because a mutation outcome is uncertain. Refresh state or cancel the run before sending another prompt."
      : run?.closedLoop.recoveryStatus === "needed" || run?.closedLoop.recoveryStatus === "in-progress"
        ? "Harness paused because recovery is required. Refresh state or cancel the run before sending another prompt."
        : "Harness paused before the next prompt. Refresh state or cancel the run before continuing.";

  return (
    <section className="rounded-[14px] border border-warning/35 bg-warning/5 p-4" role="status" aria-label="Harness is waiting">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">Harness is waiting</p>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">{message}</p>
          {run ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="status-pill">{humanizeActivity(run.status)}</span>
              <span className="status-pill">{humanizeActivity(run.recoveryState)}</span>
              <span className="status-pill">approvals {approvalCount}</span>
              <span className="status-pill">uncertain {run.uncertainMutations}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <ActionButton variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh state"}
        </ActionButton>
        <ActionButton variant="destructive" size="sm" onClick={onCancel} disabled={busy || !canCancel}>Cancel run</ActionButton>
        {hasPendingApproval ? <ActionButton variant="ghost" size="sm" onClick={onFocusApprovals} disabled={busy}>Show approval</ActionButton> : null}
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
  | { kind: "skill"; createdAt: number; entry: SkillTurnEntry }
  | { kind: "command"; createdAt: number; entry: BangCommandEntry }
  | { kind: "codex-trace"; createdAt: number; entry: CodexTraceItem }
  | { kind: "codex-group"; id: string; createdAt: number; entries: CodexTraceItem[] }
  | ConversationActivityItem;

function conversationFeedItemKey(item: ConversationFeedItem): string {
  if (item.kind === "message") return `message:${item.message.id}`;
  if (item.kind === "skill") return `skill:${item.entry.id}:${item.entry.status}:${item.entry.activity?.selectedSkillKeys.join(",") ?? ""}`;
  if (item.kind === "command") return `command:${item.entry.id}`;
  if (item.kind === "codex-trace") return `codex-trace:${item.entry.id}`;
  if (item.kind === "codex-group") return `codex-group:${item.id}`;
  return `${item.kind}:${item.id}`;
}

function buildConversationFeed(
  messages: DesktopHarnessCodexConversationMessage[],
  activity: ConversationActivityItem[],
  commands: BangCommandEntry[],
  skills: SkillTurnEntry[],
  codexTrace: CodexTraceItem[],
): ConversationFeedItem[] {
  const hasNativeTrace = codexTrace.length > 0;
  const visibleActivity = hasNativeTrace ? activity.filter((item) => item.kind !== "tool") : activity;
  const tracedResponseTurns = new Set(codexTrace.filter((entry) => entry.kind === "response" && entry.text?.trim()).map((entry) => entry.turnId));
  const visibleMessages = messages.filter((message) => !(message.role === "assistant" && message.turnId && tracedResponseTurns.has(message.turnId)));
  const sorted: ConversationFeedItem[] = [
    ...visibleMessages.map((message) => ({ kind: "message" as const, createdAt: new Date(message.createdAt).getTime(), message })),
    ...skills.map((entry) => ({ kind: "skill" as const, createdAt: entry.createdAt, entry })),
    ...visibleActivity,
    ...commands.map((entry) => ({ kind: "command" as const, createdAt: entry.createdAt, entry })),
    ...codexTrace.map((entry) => ({ kind: "codex-trace" as const, createdAt: entry.createdAt, entry })),
  ].sort((left, right) => {
    if (left.kind === "codex-trace" && right.kind === "codex-trace" && left.entry.position !== undefined && right.entry.position !== undefined) {
      return left.entry.position - right.entry.position;
    }
    return left.createdAt - right.createdAt;
  });

  const grouped: ConversationFeedItem[] = [];
  for (const item of sorted) {
    if (item.kind !== "codex-trace" || item.entry.kind === "reasoning" || item.entry.kind === "response") {
      grouped.push(item);
      continue;
    }
    const previous = grouped[grouped.length - 1];
    if (previous?.kind === "codex-group" && previous.entries[0]?.turnId === item.entry.turnId) {
      previous.entries.push(item.entry);
      continue;
    }
    grouped.push({ kind: "codex-group", id: `codex-group:${item.entry.turnId}:${item.entry.id}`, createdAt: item.createdAt, entries: [item.entry] });
  }
  return grouped;
}

function moveCompletedChatGptFileGroupsAfterResponses(
  items: ConversationFeedItem[],
  activeChatGptTurnId: string | null,
): ConversationFeedItem[] {
  const completedTurns = new Map<string, Array<Extract<ConversationFeedItem, { kind: "codex-group" }>>>();
  for (const item of items) {
    if (item.kind !== "codex-group" || item.entries.length === 0) continue;
    const turnId = item.entries[0]!.turnId;
    if (turnId === activeChatGptTurnId) continue;
    if (!item.entries.every((entry) => entry.source === "chatgpt" && entry.kind === "file")) continue;
    const groups = completedTurns.get(turnId) ?? [];
    groups.push(item);
    completedTurns.set(turnId, groups);
  }
  if (completedTurns.size === 0) return items;

  let next = [...items];
  for (const [turnId, groups] of completedTurns) {
    const groupSet = new Set(groups);
    const entries = groups.flatMap((group) => group.entries);
    const createdAt = Math.min(...groups.map((group) => group.createdAt));
    next = next.filter((item) => !(item.kind === "codex-group" && groupSet.has(item)));
    let insertAfter = -1;
    for (let index = 0; index < next.length; index += 1) {
      const item = next[index]!;
      if (item.kind === "message" && item.message.role === "assistant" && item.message.turnId === turnId) insertAfter = index;
      if (item.kind === "codex-trace" && item.entry.source === "chatgpt" && item.entry.kind === "response" && item.entry.turnId === turnId) insertAfter = index;
    }
    const mergedGroup: Extract<ConversationFeedItem, { kind: "codex-group" }> = {
      kind: "codex-group",
      id: `chatgpt-files:${turnId}`,
      createdAt,
      entries,
    };
    next.splice(insertAfter >= 0 ? insertAfter + 1 : next.length, 0, mergedGroup);
  }
  return next;
}

function mergeHydratedConversationMessages(
  currentThreadId: string | null,
  nextThreadId: string | null,
  current: DesktopHarnessCodexConversationMessage[],
  hydrated: DesktopHarnessCodexConversationMessage[],
): DesktopHarnessCodexConversationMessage[] {
  const sanitizedHydrated = sanitizeConversationMessages(hydrated);
  if (sanitizedHydrated.length === 0) return sanitizeConversationMessages(current);
  if (currentThreadId && nextThreadId && currentThreadId !== nextThreadId) {
    const rendererOwned = sanitizeConversationMessages(current).filter(isRendererOwnedConversationMessage);
    return rendererOwned.length > 0 ? mergeConversationMessages(sanitizedHydrated, rendererOwned) : sanitizedHydrated;
  }
  if (current.length === 0) return sanitizedHydrated;
  return mergeConversationMessages(current, sanitizedHydrated);
}

function isRendererOwnedConversationMessage(message: DesktopHarnessCodexConversationMessage): boolean {
  if (message.role === "user" && message.id.startsWith("user:")) return true;
  return Boolean(message.turnId?.startsWith("chatgpt-review:") || message.turnId?.startsWith("chatgpt-direct:"));
}

function mergeConversationMessages(
  current: DesktopHarnessCodexConversationMessage[],
  incoming: DesktopHarnessCodexConversationMessage[],
): DesktopHarnessCodexConversationMessage[] {
  const merged = new Map<string, DesktopHarnessCodexConversationMessage>();
  for (const message of sanitizeConversationMessages(current)) merged.set(message.id, message);
  for (const rawMessage of sanitizeConversationMessages(incoming)) {
    const message = rawMessage;
    const existingSameId = merged.get(message.id);
    let normalizedMessage = existingSameId ? { ...message, createdAt: existingSameId.createdAt } : message;
    const incomingDedupeText = normalizeConversationTextForDedupe(message.text);
    for (const existing of [...merged.values()]) {
      if (existing.id === message.id) continue;
      const sameTurn = existing.turnId !== undefined && existing.turnId === message.turnId;
      const promotesOptimisticMessage = existing.turnId === undefined && message.turnId !== undefined;
      const sameTranscriptText = existing.text === message.text || normalizeConversationTextForDedupe(existing.text) === incomingDedupeText;
      if (existing.role === message.role && sameTranscriptText && (sameTurn || promotesOptimisticMessage)) {
        if (promotesOptimisticMessage && existing.role === "user") {
          normalizedMessage = { ...message, createdAt: existing.createdAt };
        }
        merged.delete(existing.id);
      }
    }
    merged.set(normalizedMessage.id, normalizedMessage);
  }
  return [...merged.values()].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function sanitizeConversationMessages(messages: DesktopHarnessCodexConversationMessage[]): DesktopHarnessCodexConversationMessage[] {
  return messages.map((message) => message.role === "assistant"
    ? { ...message, text: stripTransientChatGptStatusText(message.text) }
    : message);
}

function normalizeConversationTextForDedupe(value: string): string {
  return stripTransientChatGptStatusText(value).replace(/\s+/g, " ").trim();
}

function stripTransientChatGptStatusText(value: string): string {
  let lines = value.replace(/\r\n/g, "\n").split("\n");
  const transientStatus = /^(?:Thinking|Reasoning|Thought for\s+\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)?)$/i;
  const hasMeaningfulContentAfter = (start: number) => lines.slice(start).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !transientStatus.test(trimmed);
  });

  let changed = true;
  while (changed) {
    changed = false;
    while (lines.length > 0 && !lines[0]!.trim()) {
      lines = lines.slice(1);
      changed = true;
    }
    if (lines.length > 1 && transientStatus.test(lines[0]!.trim()) && hasMeaningfulContentAfter(1)) {
      lines = lines.slice(1);
      changed = true;
    }
  }
  return lines.join("\n").trim();
}

function mergeStreamingConversationMessages(
  current: DesktopHarnessCodexConversationMessage[],
  streamed: DesktopHarnessCodexConversationMessage[],
  optimisticMessage: DesktopHarnessCodexConversationMessage,
): DesktopHarnessCodexConversationMessage[] {
  const base = current.some((message) => message.id === optimisticMessage.id) ? current : [...current, optimisticMessage];
  return mergeConversationMessages(base, streamed);
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
  const failed = entry.status === "failed" || entry.result?.success === false;
  const result = entry.result;
  return (
    <details className="group w-full" aria-label="Shell command output">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 text-[13px] ${failed ? "text-danger" : "text-muted-foreground hover:text-foreground"}`}>
        {running ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
        <span>Ran command{failed ? " (failed)" : ""}</span>
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-2 overflow-hidden rounded-[10px] border border-border/55 bg-background/55">
        <div className="border-b border-border/45 px-3 py-2 font-mono text-[11px] text-foreground">
          <span className="mr-2 text-muted-foreground">$</span>{entry.command}
        </div>
        {entry.error ? <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-danger">{entry.error}</pre> : null}
        {result?.stdout ? <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-muted-foreground">{result.stdout}</pre> : null}
        {result?.stderr ? <pre className={`max-h-[420px] overflow-auto whitespace-pre-wrap break-words border-t border-border/40 px-3 py-2.5 font-mono text-[11px] leading-[1.55] ${failed ? "text-danger" : "text-muted-foreground"}`}>{result.stderr}</pre> : null}
        {result && result.status === "completed" && !result.stdout && !result.stderr && !entry.error ? <p className="px-3 py-2.5 text-[11px] text-muted-foreground">Command completed with no output.</p> : null}
        {result ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">
            {result.exitCode !== undefined ? <span>exit {result.exitCode}</span> : null}
            {result.timedOut ? <span>timed out</span> : null}
            {result.truncated ? <span>output truncated</span> : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SkillTurnRow({ entry }: { entry: SkillTurnEntry }) {
  const selected = entry.activity?.selectedSkillKeys ?? [];
  const installed = [
    ...(entry.activity?.npmInstalled ?? []),
    ...(entry.activity?.pluginAutoInstalled ?? []),
  ];
  const Icon = entry.status === "pending" ? LoaderCircle : entry.status === "failed" ? CircleX : Check;
  const title = entry.status === "pending"
    ? "Selecting skills…"
    : entry.status === "failed"
      ? "Skill selection failed"
      : "Selected skills";
  return (
    <div className="ml-10 max-w-[760px] rounded-[10px] border border-border/60 bg-muted/20 px-3 py-2.5" aria-label="Harness turn skills">
      <div className="flex items-center gap-2.5">
        <Icon className={`size-3.5 shrink-0 ${entry.status === "pending" ? "animate-spin text-muted-foreground" : entry.status === "failed" ? "text-danger" : "text-success"}`} aria-hidden="true" />
        <span className="text-[11px] font-semibold text-foreground">{title}</span>
        {entry.turnId ? <span className="sr-only">for turn {entry.turnId}</span> : null}
      </div>
      {selected.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selected.map((skill) => <code key={skill} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">{skill}</code>)}
        </div>
      ) : null}
      {installed.length > 0 ? <p className="mt-1.5 text-[10px] text-muted-foreground">Installed this turn: {formatSkillList(installed)}.</p> : null}
      {entry.error ? <p className="mt-1.5 text-[10px] leading-4 text-danger">{entry.error}</p> : null}
    </div>
  );
}

function ToolActivityRow({ item }: { item: Extract<ConversationActivityItem, { kind: "tool" }> }) {
  const running = item.status === "running";
  const failed = item.status === "failed";
  return (
    <details className="group w-full" aria-label="Harness tool activity">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 text-[13px] ${failed ? "text-danger" : "text-muted-foreground hover:text-foreground"}`}>
        {running ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
        <span>{item.label}{failed ? " (failed)" : ""}</span>
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-2 rounded-[10px] border border-border/55 bg-background/40 px-3 py-2 text-[11px] text-muted-foreground">
        <code>{item.tool}</code>
        <span className="ml-2">· {item.status}</span>
      </div>
    </details>
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
    <div className="flex w-full items-center gap-2 text-[13px] text-muted-foreground">
      {active ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
      <span>{item.label} · {humanizeActivity(item.status)}</span>
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

function nativeThreadBusyNotice(): string {
  return "This Codex conversation is still finishing a previous turn. Your next prompt will wait until the native thread is writable.";
}

function isNativeThreadBusyNotice(message: string): boolean {
  return message === nativeThreadBusyNotice()
    || message === "Codex conversation is still finishing a previous turn. New prompts will wait until the native thread is writable.";
}

function isChatGptPlanningNotice(message: string): boolean {
  return /agent is planning in ChatGPT Web/.test(message);
}

function workspaceNoticeTone(message: string): "success" | "warning" {
  return isNativeThreadBusyNotice(message) || isChatGptPlanningNotice(message) ? "warning" : "success";
}

function workspaceNoticeTitle(message: string): string {
  if (isNativeThreadBusyNotice(message)) return "Waiting for previous turn";
  if (isChatGptPlanningNotice(message)) return "Working";
  return "Done";
}

type SkillSelectionRuntimePayload = {
  runId: string;
  workspace: string;
  activity: DesktopHarnessSkillActivityView;
};

type ChatGptAgentStateRuntimePayload = {
  taskId?: string;
  runId: string;
};

function parseChatGptAgentStateRuntimeEvent(event: import("../../shared/desktop-api").DesktopRuntimeEvent): ChatGptAgentStateRuntimePayload | null {
  if (event.type !== "state" || event.component !== "harness" || !event.state.startsWith("chatgpt-review-") || !event.message) return null;
  try {
    const value = JSON.parse(event.message) as Partial<ChatGptAgentStateRuntimePayload>;
    if (!value || typeof value.runId !== "string") return null;
    return { ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}), runId: value.runId };
  } catch {
    return null;
  }
}

function parseSkillSelectionRuntimeEvent(event: import("../../shared/desktop-api").DesktopRuntimeEvent): SkillSelectionRuntimePayload | null {
  if (event.type !== "state" || event.component !== "harness" || event.state !== "skills-selected" || !event.message) return null;
  try {
    const value = JSON.parse(event.message) as Partial<SkillSelectionRuntimePayload>;
    if (!value || typeof value.runId !== "string" || typeof value.workspace !== "string" || !isSkillActivity(value.activity)) return null;
    return { runId: value.runId, workspace: value.workspace, activity: value.activity };
  } catch {
    return null;
  }
}

function isSkillActivity(value: unknown): value is DesktopHarnessSkillActivityView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Partial<DesktopHarnessSkillActivityView>;
  return [activity.npmSearches, activity.npmInstalled, activity.pluginAutoInstalled, activity.selectedSkillKeys]
    .every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

function applySkillSelectionRuntimeEvent(current: SkillTurnEntry[], payload: SkillSelectionRuntimePayload): SkillTurnEntry[] {
  const index = [...current].map((entry, entryIndex) => ({ entry, entryIndex }))
    .reverse()
    .find(({ entry }) => entry.runId === payload.runId && entry.workspace === payload.workspace && entry.status === "pending")?.entryIndex;
  if (index === undefined) return current;
  const keep = payload.activity.selectedSkillKeys.length > 0;
  if (!keep) return current.filter((_, entryIndex) => entryIndex !== index);
  const next = [...current];
  next[index] = { ...next[index], status: "selected", activity: payload.activity, error: undefined };
  return next;
}

function applyPreparedSkillActivity(
  current: SkillTurnEntry[],
  id: string,
  activity: DesktopHarnessSkillActivityView,
): SkillTurnEntry[] {
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) return current;
  if (activity.selectedSkillKeys.length === 0) return current.filter((entry) => entry.id !== id);
  const next = [...current];
  next[index] = { ...next[index], status: "selected", activity, error: undefined };
  return next;
}

function waitForRendererPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function finalizeSkillTurn(
  current: SkillTurnEntry[],
  id: string,
  activity: DesktopHarnessSkillActivityView | undefined,
  turnId: string,
): SkillTurnEntry[] {
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) return current;
  if (!activity) return current.filter((entry) => entry.id !== id);
  const keep = activity.selectedSkillKeys.length > 0;
  if (!keep) return current.filter((entry) => entry.id !== id);
  const next = [...current];
  next[index] = { ...next[index], status: "selected", activity, turnId, error: undefined };
  return next;
}

function formatSkillList(values: readonly string[]): string {
  const unique = [...new Set(values.filter((value) => value.trim().length > 0))];
  if (unique.length === 0) return "none";
  const shown = unique.slice(0, 6);
  const suffix = unique.length > shown.length ? `, +${unique.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

function commandError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatChatGptReviewLoopResult(state: "done" | "blocked", iterations: number, rawReview: string, userPrompt: string): ChatGptReviewResultView {
  const noCodeExecution = iterations === 0;
  const review = noCodeExecution
    ? (extractChatGptUserAnswer(rawReview) || fallbackNoCodeChatGptAnswer(userPrompt, state))
    : (stripChatGptControlBlock(rawReview)
      || (state === "done" ? "ChatGPT review completed successfully." : "ChatGPT review blocked before any repository change could be verified."));
  return {
    state,
    iterations,
    noCodeExecution,
    title: noCodeExecution
      ? (state === "done" ? "No code execution" : "Blocked before execution")
      : `${state === "done" ? "Done" : "Blocked"} · ${iterations} verified iteration${iterations === 1 ? "" : "s"}`,
    review,
  };
}

function formatChatGptReviewTranscriptMessage(result: ChatGptReviewResultView, agentName: string): string {
  if (result.noCodeExecution) return result.review;
  const title = result.state === "done" ? `${agentName} review complete` : `${agentName} review blocked`;
  return `**${title}**

${result.review}`;
}

function formatChatGptDirectTranscriptMessage(result: DesktopHarnessCodexReviewLoopView, userPrompt: string): string {
  // A blocked direct ChatGPT control state can still carry a complete user-facing ANSWER.
  // True transport/control failures are handled by formatChatGptDirectFailureTranscriptMessage.
  const userAnswer = extractChatGptUserAnswer(result.review);
  if (userAnswer) return userAnswer;
  return (result.state === "done" ? result.turn?.response?.trim() ?? "" : "")
    || (result.state === "blocked" ? extractChatGptBlockedReason(result.review) : "")
    || fallbackNoCodeChatGptAnswer(userPrompt, result.state);
}

function extractChatGptUserAnswer(rawReview: string): string {
  const text = rawReview.replace(/\r\n/g, "\n");
  const answerMatch = text.match(/^ANSWER:\s*([\s\S]*?)(?=\n(?:STATE|TASK_ID|ITERATION|SUMMARY|REVIEW|REASON|PLAN|RESULT):|\n\[\/C2C\]|$)/mi);
  const candidate = answerMatch?.[1]?.trim() ?? "";
  if (!candidate) return "";
  const stripped = stripChatGptControlBlock(candidate);
  if (!stripped || looksLikeInternalReviewProse(stripped)) return "";
  return stripped;
}

function extractChatGptBlockedReason(rawReview: string): string {
  const text = rawReview.replace(/\r\n/g, "\n");
  const reasonMatch = text.match(/^REASON:\s*([\s\S]*?)(?=\n(?:STATE|TASK_ID|ITERATION|SUMMARY|REVIEW|ANSWER|PLAN|RESULT|PROOF|DETAIL|NEEDS):|\n\[\/C2C\]|$)/mi);
  const detailMatch = text.match(/^DETAIL:\s*([\s\S]*?)(?=\n(?:STATE|TASK_ID|ITERATION|SUMMARY|REVIEW|ANSWER|PLAN|RESULT|PROOF|NEEDS):|\n\[\/C2C\]|$)/mi);
  const reason = userVisibleChatGptBlockedText(reasonMatch?.[1]?.trim() ?? "");
  const detail = userVisibleChatGptBlockedText(detailMatch?.[1]?.trim() ?? "");
  return [reason, detail].filter(Boolean).join(" — ");
}

function userVisibleChatGptBlockedText(value: string): string {
  const stripped = stripChatGptControlBlock(value);
  if (!stripped || looksLikeInternalReviewProse(stripped)) return "";
  return stripped;
}

function fallbackNoCodeChatGptAnswer(userPrompt: string, state: "done" | "blocked"): string {
  if (state === "blocked") return "I couldn’t start yet. Please check the ChatGPT review connector and try again.";
  const normalized = userPrompt.trim().toLowerCase();
  if (/^(hi+|hello+|hey+|yo+|sup|h+i+\s+bro+|h+i+\s*.*)$/i.test(normalized)) return "Hi! What would you like me to work on?";
  if (promptLooksLikeRepositoryAnalysis(userPrompt)) {
    return "ChatGPT Web completed the turn but did not return a usable analysis. Please retry; the response must include concrete findings, affected files/components, evidence inspected, and recommended next steps.";
  }
  return "I’m ready. What would you like me to work on?";
}

function promptLooksLikeRepositoryAnalysis(prompt: string): boolean {
  return /\b(?:analy[sz]e|analysis|review|inspect|audit|scan|find issues?|source code|repo|repository|codebase)\b/i.test(prompt);
}


function isChatGptDirectTransportFailure(message: string): boolean {
  return /ChatGPT Web connection was interrupted while waiting for the complete answer|Chrome extension command timed out waiting for a stable ChatGPT control reply|stable_response_(?:idle|hard)_timeout|without conversation progress|before returning a stable control message|could not be submitted|not submitted|send button|composer|timed out/i.test(message.trim());
}

function formatChatGptDirectFailureTranscriptMessage(message: string): string {
  const cleaned = message.trim();
  if (/Chrome extension command timed out waiting for a stable ChatGPT control reply|stable_response_(?:idle|hard)_timeout|without conversation progress|before returning a stable control message/i.test(cleaned)) {
    return "ChatGPT Web executed the turn but SourceNerve did not receive the final control reply. Check the ChatGPT tab for a final [C2C] response, then retry after the app update; SourceNerve will keep live activity rows while the browser is still streaming.";
  }
  if (/timed out/i.test(cleaned)) {
    return "ChatGPT Web did not return a response in time. Check that the ChatGPT window is signed in and that the SourceNerve Harness connector is available, then try again.";
  }
  if (/without a SourceNerve \[C2C\] control block|control block/i.test(cleaned)) {
    return "ChatGPT replied, but it did not return a SourceNerve control response. Check the SourceNerve Harness connector in ChatGPT and try again.";
  }
  if (/harness run not found|HARNESS_RUN_ID|correlation id/i.test(cleaned)) {
    return "ChatGPT Web could not verify the Desktop Harness run. I reset that turn; start a new Harness prompt so SourceNerve can bind a fresh run.";
  }
  if (/not submitted|send button|composer/i.test(cleaned)) {
    return "I could not submit the prompt to ChatGPT Web. Bring the ChatGPT window to a ready composer state and try again.";
  }
  return cleaned || "ChatGPT Web could not complete this turn.";
}

function looksLikeInternalReviewProse(text: string): boolean {
  return /\b(?:requires no repository execution|no repository execution or code changes|workspace .+ was verified|review connector|implementation cycle|no implementation cycle|harness run not found|HARNESS_RUN_ID|harness-run|correlation id|I analyzed (?:the )?(?:current )?(?:source|source code|repository|repo|codebase).*HEAD|analyzed .* at HEAD)\b/i.test(text);
}

function stripChatGptControlBlock(rawReview: string): string {
  const stripped = rawReview
    .replace(/\[\/?C2C\]/gi, " ")
    .replace(/\bSTATE:\s*(?:PLAN|DONE|BLOCKED)\b/gi, " ")
    .replace(/\bTASK_ID:\s*\S+/gi, " ")
    .replace(/\bITERATION:\s*\d+/gi, " ")
    .replace(/\b(?:SUMMARY|REVIEW|REASON|PLAN|RESULT|ANSWER):\s*/gi, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : "";
}

function agentLabel(agent: HarnessAgentId): string {
  if (agent === "chat-gpt") return "ChatGPT";
  if (agent === "goal") return "Goal";
  if (agent === "loop") return "Loop";
  return "Codex";
}

function normalizeAgentCommand(value: string): HarnessAgentId | "" {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "chatgpt" || normalized === "chat-gpt" || normalized === "gpt") return "chat-gpt";
  if (normalized === "codex") return "codex";
  if (normalized === "goal") return "goal";
  if (normalized === "loop") return "loop";
  return "";
}

function normalizeModelCommand(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  if (/^(default|auto)$/i.test(normalized)) return "auto";
  if (/^(web|chatgpt|chat-gpt)$/i.test(normalized)) return "web";
  return normalized;
}

function parseInlineChatGptModeCommand(value: string): { agent: "goal" | "loop"; prompt: string } | null {
  const match = value.trimStart().match(/^\/(goal|loop)(?:\s+([\s\S]+))?$/i);
  const prompt = match?.[2]?.trim();
  if (!match || !prompt) return null;
  return { agent: match[1].toLowerCase() as "goal" | "loop", prompt };
}

function modelKeyForAgent(agent: HarnessAgentId): HarnessAgentModelKey {
  return agent === "chat-gpt" ? "chat-gpt" : "codex";
}

function selectedModelForAgent(defaults: WorkspaceAgentModelDefaults, workspaceId: string, agent: HarnessAgentId): string {
  return modelLabelForAgent(defaults, workspaceId, agent);
}

function codexModelForAgent(defaults: WorkspaceAgentModelDefaults, workspaceId: string, agent: HarnessAgentId): string | undefined {
  if (modelKeyForAgent(agent) !== "codex") return undefined;
  const model = defaults[workspaceId]?.codex?.trim();
  return model && model !== "auto" ? model : undefined;
}

function modelLabelForAgent(defaults: WorkspaceAgentModelDefaults, workspaceId: string, agent: HarnessAgentId): string {
  if (modelKeyForAgent(agent) === "chat-gpt") return "ChatGPT Web current model";
  const model = defaults[workspaceId]?.codex?.trim();
  return model && model !== "auto" ? model : "auto";
}

function chatGptConversationStorageKey(workspaceId: string): string {
  return CHATGPT_CONVERSATION_STORAGE_KEY + ":" + workspaceId;
}

function readChatGptConversationId(workspaceId: string): string | undefined {
  if (!workspaceId) return undefined;
  try {
    const existing = window.localStorage.getItem(chatGptConversationStorageKey(workspaceId));
    return existing && isSafeConversationId(existing) ? existing : undefined;
  } catch {
    return undefined;
  }
}

function persistChatGptConversationId(workspaceId: string, conversationId: string): void {
  if (!workspaceId || !isSafeConversationId(conversationId)) return;
  try {
    window.localStorage.setItem(chatGptConversationStorageKey(workspaceId), conversationId);
  } catch {
    // Persistence is best effort; the current run can still continue in memory.
  }
}

function ensureChatGptConversationId(workspaceId: string): string {
  const existing = readChatGptConversationId(workspaceId);
  if (existing) return existing;
  const created = "chatgpt:" + window.crypto.randomUUID();
  persistChatGptConversationId(workspaceId, created);
  return created;
}

function resetChatGptConversationId(workspaceId: string): void {
  if (!workspaceId) return;
  try {
    window.localStorage.setItem(chatGptConversationStorageKey(workspaceId), "chatgpt:" + window.crypto.randomUUID());
  } catch {
    // The current renderer session still starts fresh even if persistence is unavailable.
  }
}

function isSafeConversationId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function loadWorkspaceAgentDefaults(): Record<string, HarnessAgentId> {
  try {
    const raw = window.localStorage.getItem(AGENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, HarnessAgentId> = {};
    for (const [workspace, agent] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof workspace === "string" && workspace.length > 0 && isHarnessAgentId(agent)) result[workspace] = agent;
    }
    return result;
  } catch {
    return {};
  }
}

function saveWorkspaceAgentDefaults(value: Record<string, HarnessAgentId>): void {
  try {
    window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the current UI selection still applies for this session.
  }
}

function loadWorkspaceAgentModelDefaults(): WorkspaceAgentModelDefaults {
  try {
    const raw = window.localStorage.getItem(AGENT_MODEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: WorkspaceAgentModelDefaults = {};
    for (const [workspace, models] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof workspace !== "string" || workspace.length === 0 || !models || typeof models !== "object" || Array.isArray(models)) continue;
      const record = models as Partial<Record<HarnessAgentModelKey, unknown>>;
      const next: Partial<Record<HarnessAgentModelKey, string>> = {};
      if (typeof record.codex === "string" && isSafeModelId(record.codex)) next.codex = record.codex;
      if (record["chat-gpt"] === "web") next["chat-gpt"] = "web";
      result[workspace] = next;
    }
    return result;
  } catch {
    return {};
  }
}

function saveWorkspaceAgentModelDefaults(value: WorkspaceAgentModelDefaults): void {
  try {
    window.localStorage.setItem(AGENT_MODEL_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the current UI selection still applies for this session.
  }
}

function isSafeModelId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isHarnessAgentId(value: unknown): value is HarnessAgentId {
  return value === "codex" || value === "chat-gpt" || value === "goal" || value === "loop";
}

function loadWorkspacePermissionDefaults(): Record<string, PermissionPresetId> {
  try {
    const raw = window.localStorage.getItem(PERMISSION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, PermissionPresetId> = {};
    for (const [workspace, preset] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof workspace === "string" && workspace.length > 0 && isPermissionPresetId(preset)) result[workspace] = preset;
    }
    return result;
  } catch {
    return {};
  }
}

function saveWorkspacePermissionDefaults(value: Record<string, PermissionPresetId>): void {
  try {
    window.localStorage.setItem(PERMISSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage failures; the current run still carries the selected permission.
  }
}

function isPermissionPresetId(value: unknown): value is PermissionPresetId {
  return value === "read-only" || value === "workspace-write" || value === "guarded" || value === "full-access";
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
  if (!isActiveRun(run)) return false;
  return run.closedLoop.recoveryStatus === "needed"
    || run.closedLoop.recoveryStatus === "in-progress"
    || run.pendingApprovals > 0
    || run.uncertainMutations > 0;
}

function isActiveRun(run: DesktopHarnessRunView): boolean {
  return run.status === "running";
}

function isHarnessOperatorGateError(message: string | null): boolean {
  return message === HARNESS_OPERATOR_GATE_ERROR || message === HARNESS_PERMISSION_GATE_ERROR;
}
