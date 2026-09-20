import { createHash, randomUUID } from "node:crypto";

import type { DesktopRuntimeEvent, ManagedWorkspaceView } from "../shared/desktop-api";
import type {
  DesktopHarnessAgentWorkerFamilyCreateInput,
  DesktopHarnessAgentWorkerFamilyGetInput,
  DesktopHarnessAgentWorkerFamilyView,
  DesktopHarnessAgentWorkerRunInput,
  DesktopHarnessAgentWorkerRunView,
  DesktopHarnessAgentWorkerView,
  DesktopHarnessCodexAccountInput,
  DesktopHarnessCodexAccountView,
  DesktopHarnessCodexActivityView,
  DesktopHarnessCodexConversationClearInput,
  DesktopHarnessCodexConversationClearResult,
  DesktopHarnessCodexConversationInput,
  DesktopHarnessCodexConversationListInput,
  DesktopHarnessCodexConversationMessage,
  DesktopHarnessCodexConversationResumeInput,
  DesktopHarnessCodexConversationSummary,
  DesktopHarnessCodexConversationView,
  DesktopHarnessCodexSetupView,
  DesktopHarnessCodexStatusInput,
  DesktopHarnessCodexStatusView,
  DesktopHarnessCodexUsageInput,
  DesktopHarnessCodexUsageView,
  DesktopHarnessCodexTurnInput,
  DesktopHarnessCodexTurnPrepareInput,
  DesktopHarnessCodexTurnPreparationView,
  DesktopHarnessCodexTurnView,
  DesktopHarnessCodexReviewLoopInput,
  DesktopHarnessCodexReviewLoopView,
  DesktopHarnessCommandInput,
  DesktopHarnessCommandView,
  DesktopHarnessContextRouteInput,
  DesktopHarnessContextRouteView,
  DesktopHarnessEventsInput,
  DesktopHarnessRunBeginInput,
  DesktopHarnessJobCancelInput,
  DesktopHarnessJobListInput,
  DesktopHarnessJobView,
  DesktopHarnessRunIdInput,
  DesktopHarnessRunListInput,
  DesktopHarnessRunView,
} from "../shared/harness-api";
import type {
  DesktopHarnessApprovalListInput,
  DesktopHarnessApprovalRespondInput,
  DesktopHarnessApprovalRespondResult,
  DesktopHarnessApprovalView,
} from "../shared/harness-approval-api";
import type {
  DesktopTaskApplyInput,
  DesktopTaskApplyResult,
  DesktopTaskBeginInput,
  DesktopTaskFileReadInput,
  DesktopTaskFileReadResult,
  DesktopTaskBeginResult,
  DesktopTaskBranchInput,
  DesktopTaskBranchResult,
  DesktopTaskCommitInput,
  DesktopTaskCommitResult,
  DesktopTaskListItem,
  DesktopTaskProposalResult,
  DesktopTaskProposeInput,
  DesktopTaskPushResult,
  DesktopTaskReviewResult,
  DesktopTaskSnapshot,
} from "../shared/task-api";
import { parseHarnessApprovalList, parseHarnessApprovalRespond } from "./harness-approval-parser";
import type { CodexHarnessRuntime } from "./codex-harness-runtime";
import type { ConversationActivityStore } from "./conversation-activity-store";
import { AgentWorkerFamilyRegistry, type AgentWorkerFamily, type AgentWorker } from "./agent-worker-family";
import { ChatGptReviewLoop, parseChatGptReviewControlMessage, type ChatGptReviewDriver, type VerifiedCodexExecution } from "./chatgpt-review-loop";
import { CODEX_HARNESS_INTERNAL_RECOVERY_PREFIX } from "./codex-harness-supervision";
import type { CodexCliManager } from "./codex-cli-manager";
import { parseHarnessCommand, parseHarnessContextRoute, parseHarnessEvents, parseHarnessJobCall, parseHarnessJobList, parseHarnessRunBegin, parseHarnessRunList, parseHarnessRunSnapshot } from "./harness-parser";
import type { SourceNerveClient } from "./sourcenerve-client";
import {
  parseTaskApplyResult,
  parseTaskBegin,
  parseTaskBranchResult,
  parseTaskCommitResult,
  parseTaskProposalResult,
  parseTaskPushResult,
  parseTaskReviewResult,
  parseTaskSnapshot,
  parseTaskView,
} from "./task-parser";
import type { DesktopTaskRegistry } from "./task-registry";
import { isSafeBranch } from "./task-policy";
import type { WorkspaceManager } from "./workspace-manager";
import { promptNeedsAutomaticSkills } from "./workspace-skill-policy";

const MAX_LISTED_TASKS = 50;
const LIST_CONCURRENCY = 6;
const MAX_COMPLETION_NOTIFICATION_KEYS = 128;
const MAX_CODEX_ACTIVE_SKILLS = 2;
const MAX_CODEX_RECOVERY_ATTEMPTS = 2;
const CODEX_TURN_PREPARATION_TTL_MS = 5 * 60_000;
const MAX_CODEX_TURN_PREPARATIONS = 64;
const NATIVE_VERIFICATION_TIMEOUT_MS = 600_000;
const MAX_RECOVERY_CONTEXT_BYTES = 24 * 1024;
const CHATGPT_PROGRESS_POLL_MS = 900;
const MAX_CHATGPT_DIFF_PROGRESS_BYTES = 20 * 1024;

export class DesktopTaskManager {
  private readonly beginKeys = new Map<string, string>();
  private readonly completionNotificationKeys = new Set<string>();
  private readonly harnessJobStatuses = new Map<string, string>();
  private readonly activeChatGptReviewTasks = new Map<string, string>();
  private readonly agentWorkerFamilies = new AgentWorkerFamilyRegistry();
  private readonly preparedCodexTurns = new Map<string, {
    runId: string;
    workspace: string;
    promptHash: string;
    skillKeys: string[];
    skillActivity: DesktopHarnessCodexTurnPreparationView["skillActivity"];
    createdAt: number;
  }>();

  constructor(private readonly options: {
    client: SourceNerveClient;
    workspaceManager: WorkspaceManager;
    registry: DesktopTaskRegistry;
    codex?: Pick<CodexHarnessRuntime, "account" | "status" | "usage" | "run" | "release" | "clearWorkspace" | "listConversations" | "conversation" | "resumeConversation">;
    activityStore?: Pick<ConversationActivityStore, "list" | "conversationId" | "listMessages" | "recordMessage" | "attachThread" | "clearWorkspace"> & Partial<Pick<ConversationActivityStore, "listConversationSummaries" | "listConversationActivities">>;
    codexSetup?: Pick<CodexCliManager, "status" | "install" | "login">;
    chatGptReview?: ChatGptReviewDriver;
    npmSkillPreflight?: (workspaceId: string, prompt: string) => Promise<{ activeSkillKeys: string[]; installed: string[]; searches: string[] }>;
    skillPreflight?: (workspaceId: string, prompt: string) => Promise<{ activeSkillKeys: string[]; autoInstalledPluginIds: string[] }>;
    onEvent?: (event: DesktopRuntimeEvent) => void;
    now?: () => Date;
  }) {}

  async initialize(): Promise<void> {
    await this.options.registry.initialize();
  }

  async list(): Promise<DesktopTaskListItem[]> {
    const references = this.options.registry.snapshot().slice(0, MAX_LISTED_TASKS);
    return mapWithConcurrency(references, LIST_CONCURRENCY, async (reference) => {
      try {
        const snapshot = await this.get(reference.taskId);
        return { ...reference, snapshot };
      } catch (error) {
        return {
          ...reference,
          unavailableReason: safeMessage(error),
        };
      }
    });
  }


  async beginHarnessRun(input: DesktopHarnessRunBeginInput): Promise<DesktopHarnessRunView> {
    const value = await this.options.client.harnessRequest(
      "/api/v1/harness/runs/begin",
      {
        workspace: input.workspace,
        profile: input.profile,
        ...(input.sandbox ? { sandbox: input.sandbox } : {}),
        client_request_id: `desktop:harness:${randomUUID()}`,
      },
    );
    const begun = parseHarnessRunBegin(value);
    if (begun.workspace !== input.workspace) throw new Error("SourceNerve Harness begin workspace mismatch");
    return begun;
  }

  async routeHarnessContext(input: DesktopHarnessContextRouteInput): Promise<DesktopHarnessContextRouteView> {
    const value = await this.options.client.harnessRequest(
      "/api/v1/harness/context/route",
      {
        workspace: input.workspace,
        ...(input.runId ? { run_id: input.runId } : {}),
        query: input.query,
        ...(input.startCycle ? { start_cycle: true } : {}),
      },
    );
    const routed = parseHarnessContextRoute(value, input.query);
    if (routed.workspace !== input.workspace) throw new Error("SourceNerve Harness context route workspace mismatch");
    return routed;
  }

  async listHarnessRuns(input: DesktopHarnessRunListInput = {}): Promise<DesktopHarnessRunView[]> {
    const runs = parseHarnessRunList(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/list",
      { limit: input.limit ?? 50 },
    ));
    await this.releaseTerminalCodexRuns(runs);
    return runs;
  }

  async getHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopHarnessRunView> {
    const run = parseHarnessRunSnapshot(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/get",
      { run_id: input.runId },
    ));
    await this.releaseTerminalCodexRuns([run]);
    return run;
  }

  async listHarnessEvents(input: DesktopHarnessEventsInput) {
    return parseHarnessEvents(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/events",
      { run_id: input.runId, after_seq: input.afterSeq ?? -1, limit: input.limit ?? 200 },
    ));
  }

  async listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopHarnessJobView[]> {
    const jobs = parseHarnessJobList(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/list",
      { run_id: input.runId, limit: input.limit ?? 50 },
    ));
    this.observeHarnessJobTransitions(jobs);
    return jobs;
  }

  async cancelHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopHarnessRunView> {
    const reviewTaskId = this.activeChatGptReviewTasks.get(input.runId);
    if (reviewTaskId) this.options.chatGptReview?.cancel?.(reviewTaskId);
    const run = parseHarnessRunSnapshot(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/cancel",
      { run_id: input.runId },
    ));
    this.activeChatGptReviewTasks.delete(input.runId);
    await this.options.codex?.release(input.runId);
    return run;
  }

  async runHarnessCommand(input: DesktopHarnessCommandInput): Promise<DesktopHarnessCommandView> {
    const command = parseHarnessCommand(await this.options.client.harnessRequest(
      "/api/v1/harness/commands/execute",
      {
        workspace: input.workspace,
        command: input.command,
        request_id: input.requestId,
        ...(input.timeoutMs ? { timeout_ms: input.timeoutMs } : {}),
        ...(input.workdir ? { cwd: input.workdir } : {}),
      },
    ));
    if (command.workspace !== input.workspace || command.command !== input.command || command.requestId !== input.requestId) {
      throw new Error("SourceNerve Harness command response does not match the request");
    }
    return command;
  }

  async getHarnessCodexSetup(): Promise<DesktopHarnessCodexSetupView> {
    if (!this.options.codexSetup) throw new Error("Desktop Codex setup runtime is not initialized");
    return this.options.codexSetup.status();
  }

  async installHarnessCodex(): Promise<DesktopHarnessCodexSetupView> {
    if (!this.options.codexSetup) throw new Error("Desktop Codex setup runtime is not initialized");
    return this.options.codexSetup.install();
  }

  async loginHarnessCodex(): Promise<DesktopHarnessCodexSetupView> {
    if (!this.options.codexSetup) throw new Error("Desktop Codex setup runtime is not initialized");
    return this.options.codexSetup.login();
  }

  async getHarnessCodexAccount(input: DesktopHarnessCodexAccountInput): Promise<DesktopHarnessCodexAccountView> {
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    return this.options.codex.account(input.workspace);
  }

  async getHarnessCodexStatus(input: DesktopHarnessCodexStatusInput): Promise<DesktopHarnessCodexStatusView> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    return this.options.codex.status(input.workspace);
  }

  async getHarnessCodexUsage(input: DesktopHarnessCodexUsageInput): Promise<DesktopHarnessCodexUsageView> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    return this.options.codex.usage(input.workspace, input.runId);
  }

  async getHarnessCodexConversation(input: DesktopHarnessCodexConversationInput): Promise<DesktopHarnessCodexConversationView> {
    const run = await this.getHarnessRun({ runId: input.runId });
    const conversation = this.options.codex
      ? await this.options.codex.conversation(run.id)
      : { runId: run.id, workspace: run.workspace, messages: [] };
    const runActivities = this.options.activityStore?.list({
      workspace: run.workspace,
      runId: run.id,
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
    }) ?? [];
    const requestedDirectMessages = input.conversationId
      ? this.options.activityStore?.listMessages({ workspace: run.workspace, runId: run.id, conversationId: input.conversationId }) ?? []
      : [];
    const inferredConversationId = this.options.activityStore?.conversationId({ workspace: run.workspace, runId: run.id });
    const conversationId = input.conversationId && requestedDirectMessages.length > 0
      ? input.conversationId
      : inferredConversationId;
    const directMessages = conversationId
      ? this.options.activityStore?.listMessages({ workspace: run.workspace, runId: run.id, conversationId }) ?? []
      : this.options.activityStore?.listMessages({ workspace: run.workspace, runId: run.id }) ?? [];
    const directActivities = conversationId
      ? this.options.activityStore?.listConversationActivities?.({
        workspace: run.workspace,
        conversationId,
      }) ?? []
      : [];
    return {
      ...conversation,
      ...(conversationId ? { conversationId } : {}),
      messages: mergeConversationHistoryMessages(conversation.messages, directMessages),
      activities: mergeConversationActivities(runActivities, directActivities),
    };
  }

  async listHarnessCodexConversations(input: DesktopHarnessCodexConversationListInput): Promise<DesktopHarnessCodexConversationSummary[]> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    const nativeConversations = this.options.codex ? await this.options.codex.listConversations(input.workspace) : [];
    const native = nativeConversations.map((conversation) => {
      const conversationId = conversation.runId
        ? this.options.activityStore?.conversationId({ workspace: input.workspace, runId: conversation.runId })
        : undefined;
      return {
        ...conversation,
        ...(conversationId ? { conversationId } : {}),
      };
    });
    const direct = this.options.activityStore?.listConversationSummaries?.(input.workspace) ?? [];
    const directByConversationId = new Map(direct.flatMap((conversation) =>
      conversation.conversationId ? [[conversation.conversationId, conversation] as const] : []
    ));
    const mergedNative = native.map((conversation) => {
      const logical = conversation.conversationId ? directByConversationId.get(conversation.conversationId) : undefined;
      if (!logical) return conversation;
      directByConversationId.delete(conversation.conversationId!);
      return {
        ...conversation,
        source: "chatgpt" as const,
        title: logical.title,
        preview: logical.preview,
        createdAt: logical.createdAt < conversation.createdAt ? logical.createdAt : conversation.createdAt,
        updatedAt: logical.updatedAt > conversation.updatedAt ? logical.updatedAt : conversation.updatedAt,
        model: logical.model ?? conversation.model,
      };
    });
    return [
      ...mergedNative,
      ...direct.filter((conversation) => !conversation.conversationId || directByConversationId.has(conversation.conversationId)),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async resumeHarnessCodexConversation(input: DesktopHarnessCodexConversationResumeInput): Promise<DesktopHarnessCodexConversationView> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    if (!input.threadId && !input.conversationId) {
      throw new Error("A native thread id or ChatGPT conversation id is required to resume a conversation");
    }
    const codex = this.options.codex;
    if (input.threadId && !codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    const available = input.threadId && codex ? await codex.listConversations(input.workspace) : [];
    const selected = input.threadId ? available.find((conversation) => conversation.threadId === input.threadId) : undefined;
    if (input.threadId && !selected) {
      throw new Error("Codex conversation does not belong to the selected workspace");
    }

    const sourceRunId = selected?.runId;
    const inferredConversationId = sourceRunId
      ? this.options.activityStore?.conversationId({ workspace: input.workspace, runId: sourceRunId })
      : undefined;
    const conversationId = inferredConversationId ?? input.conversationId;

    const run = await this.beginHarnessRun({
      workspace: input.workspace,
      profile: input.profile ?? "interactive-local",
      sandbox: input.sandbox ?? "workspace-write",
    });
    try {
      if (!input.threadId) {
        const directMessages = this.options.activityStore?.listMessages({
          workspace: input.workspace,
          runId: sourceRunId ?? run.id,
          ...(conversationId ? { conversationId } : {}),
        }) ?? [];
        const directActivities = conversationId
          ? this.options.activityStore?.listConversationActivities?.({
            workspace: input.workspace,
            conversationId,
            ...(sourceRunId ? { runId: sourceRunId } : {}),
          }) ?? []
          : [];
        return {
          runId: run.id,
          workspace: input.workspace,
          ...(conversationId ? { conversationId } : {}),
          messages: directMessages,
          activities: directActivities,
        };
      }

      if (!codex) throw new Error("Desktop Codex Harness runtime is not initialized");
      const conversation = await codex.resumeConversation({ runId: run.id, threadId: input.threadId });
      this.options.activityStore?.attachThread(run.id, input.threadId);
      const activities = this.options.activityStore?.list({
        workspace: input.workspace,
        runId: run.id,
        threadId: input.threadId,
      }) ?? [];
      const directMessages = this.options.activityStore?.listMessages({
        workspace: input.workspace,
        runId: sourceRunId ?? run.id,
        ...(conversationId ? { conversationId } : {}),
      }) ?? [];
      const directActivities = conversationId
        ? this.options.activityStore?.listConversationActivities?.({
          workspace: input.workspace,
          conversationId,
          ...(sourceRunId ? { runId: sourceRunId } : {}),
        }) ?? []
        : [];
      return {
        ...conversation,
        ...(conversationId ? { conversationId } : {}),
        messages: mergeConversationHistoryMessages(conversation.messages, directMessages),
        activities: mergeConversationActivities(activities, directActivities),
      };
    } catch (error) {
      await this.cancelHarnessRun({ runId: run.id }).catch(() => undefined);
      throw error;
    }
  }

  async clearHarnessCodexConversations(input: DesktopHarnessCodexConversationClearInput): Promise<DesktopHarnessCodexConversationClearResult> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    const conversations = this.options.codex ? await this.options.codex.listConversations(input.workspace) : [];
    await this.options.codex?.clearWorkspace(input.workspace);
    this.options.activityStore?.clearWorkspace(input.workspace);
    return { workspace: input.workspace, deleted: conversations.length };
  }

  async prepareHarnessCodexTurn(input: DesktopHarnessCodexTurnPrepareInput): Promise<DesktopHarnessCodexTurnPreparationView> {
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    const run = await this.getHarnessRun({ runId: input.runId });
    await this.routeHarnessContext({
      workspace: run.workspace,
      runId: run.id,
      query: input.prompt,
      startCycle: true,
    });
    if (!this.options.npmSkillPreflight) {
      throw new Error("Mandatory npm Skills CLI preflight is not initialized");
    }
    const npmSkillPreflight = await this.options.npmSkillPreflight(run.workspace, input.prompt);
    const pluginSkillPreflight = promptNeedsAutomaticSkills(input.prompt) && this.options.skillPreflight
      ? await this.options.skillPreflight(run.workspace, input.prompt)
      : null;
    const skillKeys = [...new Set([
      ...npmSkillPreflight.activeSkillKeys,
      ...(pluginSkillPreflight?.activeSkillKeys ?? []),
    ])].slice(0, MAX_CODEX_ACTIVE_SKILLS);
    const skillActivity = {
      npmSearches: [...new Set(npmSkillPreflight.searches)].sort(),
      npmInstalled: [...new Set(npmSkillPreflight.installed)].sort(),
      pluginAutoInstalled: [...new Set(pluginSkillPreflight?.autoInstalledPluginIds ?? [])].sort(),
      selectedSkillKeys: skillKeys,
    };
    this.prunePreparedCodexTurns();
    const preparationId = randomUUID();
    this.preparedCodexTurns.set(preparationId, {
      runId: run.id,
      workspace: run.workspace,
      promptHash: createHash("sha256").update(input.prompt).digest("hex"),
      skillKeys,
      skillActivity,
      createdAt: Date.now(),
    });
    this.options.onEvent?.({
      type: "state",
      component: "harness",
      state: "skills-selected",
      message: JSON.stringify({ runId: run.id, workspace: run.workspace, activity: skillActivity }),
    });
    return { runId: run.id, workspace: run.workspace, preparationId, skillActivity };
  }

  async runHarnessCodexTurn(input: DesktopHarnessCodexTurnInput): Promise<DesktopHarnessCodexTurnView> {
    return (await this.runHarnessCodexTurnVerified(input)).turn;
  }

  async runHarnessCodexReviewLoop(input: DesktopHarnessCodexReviewLoopInput): Promise<DesktopHarnessCodexReviewLoopView> {
    if (!this.options.chatGptReview) throw new Error("ChatGPT control plane is not initialized");
    const run = await this.getHarnessRun({ runId: input.runId });
    if (run.status !== "running" || run.freshnessState !== "current") {
      throw new Error("ChatGPT agent requires a current running Harness run");
    }
    if (this.activeChatGptReviewTasks.has(run.id)) throw new Error("ChatGPT agent is already active for this Harness run");

    const mode = input.mode ?? "review";
    if (mode === "review") return this.runHarnessChatGptDirectAgent({ ...input, mode }, run);

    let executedCodexIterations = 0;
    const progressMonitor = { stop: null as (() => void) | null };
    const loop = new ChatGptReviewLoop({
      driver: this.options.chatGptReview,
      execute: async (request) => {
        const executed = await this.runHarnessCodexTurnVerified({ ...request, ...(input.model ? { model: input.model } : {}) });
        executedCodexIterations += 1;
        return executed;
      },
      onEvent: (event) => {
        this.activeChatGptReviewTasks.set(event.runId, event.taskId);
        if (!progressMonitor.stop) {
          progressMonitor.stop = this.startChatGptProgressMonitor({ taskId: event.taskId, runId: event.runId, workspace: event.workspace });
        }
        const progressText = chatGptStageProgressText(event.state, event.iteration, mode);
        if (progressText) {
          this.emitChatGptProgress({
            taskId: event.taskId,
            runId: event.runId,
            workspace: event.workspace,
            kind: "reasoning",
            text: progressText,
          });
        }
        this.options.onEvent?.({
          type: "state",
          component: "harness",
          state: `chatgpt-review-${event.state}`,
          message: JSON.stringify(event),
        });
      },
    });

    try {
      return await loop.run({ ...input, workspace: run.workspace, mode });
    } catch (error) {
      if (executedCodexIterations === 0) {
        await this.cancelAbandonedChatGptPlanningRun(run.id, error).catch(() => undefined);
      }
      throw error;
    } finally {
      progressMonitor.stop?.();
      this.activeChatGptReviewTasks.delete(run.id);
    }
  }

  private async runHarnessChatGptDirectAgent(
    input: DesktopHarnessCodexReviewLoopInput & { mode: "review" },
    run: DesktopHarnessRunView,
  ): Promise<DesktopHarnessCodexReviewLoopView> {
    const driver = this.options.chatGptReview;
    if (!driver) throw new Error("ChatGPT control plane is not initialized");
    const taskId = `sn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const turnId = `chatgpt-review:${taskId}`;
    this.options.activityStore?.recordMessage({
      id: `user:chatgpt:${taskId}`,
      role: "user",
      text: input.prompt,
      createdAt: new Date().toISOString(),
      turnId,
      runId: run.id,
      workspace: run.workspace,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    this.activeChatGptReviewTasks.set(run.id, taskId);
    this.emitChatGptAgentState({ taskId, runId: run.id, workspace: run.workspace, iteration: 0, state: "planning", mode: input.mode });
    this.emitChatGptProgress({ taskId, runId: run.id, workspace: run.workspace, kind: "reasoning", text: chatGptStageProgressText("planning", 0, input.mode) });
    const stopProgressMonitor = this.startChatGptProgressMonitor({ taskId, runId: run.id, workspace: run.workspace });
    try {
      const raw = await driver.begin({
        taskId,
        runId: run.id,
        workspace: run.workspace,
        goal: buildChatGptDirectAgentGoal(input.prompt),
        mode: input.mode,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      });
      const control = parseChatGptDirectAgentReply(raw, taskId);
      if (control.state === "BLOCKED") {
        this.options.activityStore?.recordMessage({
          id: `assistant:${taskId}`,
          role: "assistant",
          text: directChatGptTranscriptText(control.text, "blocked"),
          createdAt: new Date().toISOString(),
          turnId,
          runId: run.id,
          workspace: run.workspace,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        });
        this.emitChatGptAgentState({ taskId, runId: run.id, workspace: run.workspace, iteration: 0, state: "blocked", mode: input.mode });
        return { taskId, runId: run.id, workspace: run.workspace, state: "blocked", mode: input.mode, iterations: 0, review: control.text };
      }

      this.emitChatGptAgentState({ taskId, runId: run.id, workspace: run.workspace, iteration: 0, state: "verifying", mode: input.mode });
      this.emitChatGptProgress({ taskId, runId: run.id, workspace: run.workspace, kind: "reasoning", text: chatGptStageProgressText("verifying", 0, input.mode) });
      const verification = await this.runNativeVerification(run.id);
      if (!verification.success) {
        const detail = boundedRecoveryText(verification.stderr || verification.stdout || "verification did not pass", 1024);
        const review = `[C2C]
STATE: BLOCKED
TASK_ID: ${taskId}
ITERATION: 0

REASON:
Harness verification failed after the direct ChatGPT agent turn. No native Codex recovery was attempted.

PROOF:
${verification.proofCommand ?? verification.proofType ?? "repository proof"}

DETAIL:
${detail}`;
        this.options.activityStore?.recordMessage({
          id: `assistant:${taskId}`,
          role: "assistant",
          text: directChatGptTranscriptText(review, "blocked"),
          createdAt: new Date().toISOString(),
          turnId,
          runId: run.id,
          workspace: run.workspace,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        });
        this.emitChatGptAgentState({ taskId, runId: run.id, workspace: run.workspace, iteration: 0, state: "blocked", mode: input.mode });
        return { taskId, runId: run.id, workspace: run.workspace, state: "blocked", mode: input.mode, iterations: 0, review };
      }

      this.options.activityStore?.recordMessage({
        id: `assistant:${taskId}`,
        role: "assistant",
        text: directChatGptTranscriptText(control.text, "done"),
        createdAt: new Date().toISOString(),
        turnId,
        runId: run.id,
        workspace: run.workspace,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      });
      this.emitChatGptAgentState({ taskId, runId: run.id, workspace: run.workspace, iteration: 0, state: "done", mode: input.mode });
      return {
        taskId,
        runId: run.id,
        workspace: run.workspace,
        state: "done",
        mode: input.mode,
        iterations: verification.skipped ? 0 : 1,
        review: control.text,
      };
    } catch (error) {
      await this.cancelAbandonedChatGptPlanningRun(run.id, error).catch(() => undefined);
      throw error;
    } finally {
      stopProgressMonitor();
      this.activeChatGptReviewTasks.delete(run.id);
    }
  }

  private emitChatGptProgress(event: {
    taskId: string;
    runId: string;
    workspace: string;
    kind: "reasoning" | "tool" | "diff";
    text: string;
    stage?: string;
    itemId?: string;
    input?: string;
    output?: string;
    durationMs?: number;
    functionName?: string;
    parameters?: string;
    filePath?: string;
    additions?: number;
    deletions?: number;
  }): void {
    this.options.onEvent?.({ type: "chatgpt-progress", ...event });
  }

  private startChatGptProgressMonitor(input: { taskId: string; runId: string; workspace: string }): () => void {
    let stopped = false;
    let inFlight = false;
    const startedAt = Math.floor(Date.now() / 1000) - 2;
    const eventSeqByRun = new Map<string, number>();
    let lastDiffSha = "";

    const poll = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        let review = null;
        try {
          review = await this.options.client.gitReview(input.workspace);
        } catch {}
        if (!stopped && review && lastDiffSha && review.diffSha256 !== lastDiffSha) {
          lastDiffSha = review.diffSha256;
          const body = review.dirty
            ? review.diff.trim() || review.status.trim() || "Working tree changed"
            : "Working tree is clean.";
          this.emitChatGptProgress({
            ...input,
            kind: "diff",
            text: boundedRecoveryText(body, MAX_CHATGPT_DIFF_PROGRESS_BYTES),
            itemId: `git-diff:${review.diffSha256}`,
          });
        } else if (!stopped && review && !lastDiffSha) {
          lastDiffSha = review.diffSha256;
        }

        const runs = await this.listHarnessRuns({ limit: 50 }).catch(() => []);
        const candidates = runs.filter((candidate) =>
          candidate.workspace === input.workspace
          && (
            candidate.id === input.runId
            || candidate.parentRunId === input.runId
            || (candidate.actor === "external-agent" && candidate.updatedAt >= startedAt)
          )
        );
        for (const candidate of candidates) {
          let afterSeq = eventSeqByRun.get(candidate.id) ?? -1;
          for (let page = 0; page < 8; page += 1) {
            const events = await this.listHarnessEvents({ runId: candidate.id, afterSeq, limit: 200 }).catch(() => []);
            if (events.length === 0) break;
            for (const event of events) {
              afterSeq = Math.max(afterSeq, event.seq);
              eventSeqByRun.set(candidate.id, afterSeq);
              if (event.createdAt < startedAt || !event.eventType.startsWith("tool/")) continue;
              const tool = summaryValue(event.summary, "tool") ?? summaryValue(event.summary, "tool_name") ?? "Harness tool";
              const status = event.eventType.slice("tool/".length);
              const durationValue = summaryValue(event.summary, "duration_ms");
              const durationMs = durationValue && /^\d+$/.test(durationValue) ? Number(durationValue) : undefined;
              const executionId = summaryValue(event.summary, "execution_id");
              this.emitChatGptProgress({
                ...input,
                kind: "tool",
                text: `${humanizeToolProgress(tool)} · ${status}`,
                stage: status,
                ...(executionId ? { itemId: executionId } : {}),
                functionName: tool,
                ...(event.displayInput ? { input: event.displayInput } : {}),
                ...(event.displayInput ? { parameters: event.displayInput } : {}),
                ...(event.displayOutput ? { output: event.displayOutput } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
              });
            }
            if (events.length < 200) break;
          }
        }
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, CHATGPT_PROGRESS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private emitChatGptAgentState(event: {
    taskId: string;
    runId: string;
    workspace: string;
    iteration: number;
    state: "planning" | "executing" | "verifying" | "reviewing" | "done" | "blocked";
    mode: "review" | "goal" | "loop";
  }): void {
    this.activeChatGptReviewTasks.set(event.runId, event.taskId);
    this.options.onEvent?.({
      type: "state",
      component: "harness",
      state: `chatgpt-review-${event.state}`,
      message: JSON.stringify(event),
    });
  }

  private async cancelAbandonedChatGptPlanningRun(runId: string, error: unknown): Promise<void> {
    const reviewTaskId = this.activeChatGptReviewTasks.get(runId);
    if (reviewTaskId) this.options.chatGptReview?.cancel?.(reviewTaskId);
    await this.options.client.harnessRequest(
      "/api/v1/harness/runs/cancel",
      { run_id: runId },
    );
    await this.options.codex?.release(runId);
    this.options.onEvent?.({
      type: "state",
      component: "harness",
      state: "chatgpt-review-planning-cancelled",
      message: JSON.stringify({ runId, reason: safeMessage(error) }),
    });
  }



  async createHarnessAgentWorkerFamily(input: DesktopHarnessAgentWorkerFamilyCreateInput): Promise<DesktopHarnessAgentWorkerFamilyView> {
    const prime = await this.getHarnessRun({ runId: input.primeRunId });
    if (prime.workspace !== input.workspace) throw new Error("Agent worker family workspace must match the prime Harness run");
    if (prime.status !== "running" || prime.freshnessState !== "current") throw new Error("Agent worker family requires a current running prime Harness run");
    return familyView(this.agentWorkerFamilies.create(input));
  }

  async getHarnessAgentWorkerFamily(input: DesktopHarnessAgentWorkerFamilyGetInput): Promise<DesktopHarnessAgentWorkerFamilyView> {
    return familyView(this.agentWorkerFamilies.get(input.familyId));
  }

  async runHarnessAgentWorker(input: DesktopHarnessAgentWorkerRunInput): Promise<DesktopHarnessAgentWorkerRunView> {
    const family = this.agentWorkerFamilies.get(input.familyId);
    const worker = family.workers.find((item) => item.workerRunId === input.workerRunId);
    if (!worker) throw new Error("Agent worker does not belong to this family/incarnation");
    const prime = await this.getHarnessRun({ runId: family.primeRunId });
    if (prime.workspace !== worker.workspace || prime.freshnessState !== "current") throw new Error("Agent worker prime run is no longer current for this workspace");
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");

    const childRun = await this.beginHarnessRun({ workspace: worker.workspace, profile: "interactive-local", sandbox: "workspace-write" });
    const leaseId = `lease_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let claimed = this.agentWorkerFamilies.claim({ familyId: family.familyId, workerRunId: worker.workerRunId, leaseId, childRunId: childRun.id });
    try {
      claimed = this.agentWorkerFamilies.markRunning({ familyId: family.familyId, workerRunId: worker.workerRunId, leaseId });
      const executed = await this.runHarnessCodexTurnVerified({
        runId: childRun.id,
        prompt: buildAgentWorkerPrompt(family, claimed, input.prompt),
      });
      const report = executed.turn.response ?? `Worker ${claimed.ordinal} completed Codex turn ${executed.turn.turnId}.`;
      const reported = this.agentWorkerFamilies.report({ familyId: family.familyId, workerRunId: worker.workerRunId, leaseId, report });
      return { family: familyView(this.agentWorkerFamilies.get(family.familyId)), worker: workerView(reported), childRun, turn: executed.turn };
    } catch (error) {
      this.agentWorkerFamilies.retire({ familyId: family.familyId, workerRunId: worker.workerRunId });
      await this.cancelHarnessRun({ runId: childRun.id }).catch(() => undefined);
      throw error;
    }
  }

  private async runHarnessCodexTurnVerified(input: DesktopHarnessCodexTurnInput): Promise<VerifiedCodexExecution> {
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    const run = await this.getHarnessRun({ runId: input.runId });
    const preparation = input.preparationId
      ? this.consumePreparedCodexTurn({ runId: input.runId, prompt: input.prompt, preparationId: input.preparationId }, run.workspace)
      : this.consumePreparedCodexTurn({
        ...input,
        preparationId: (await this.prepareHarnessCodexTurn({ runId: input.runId, prompt: input.prompt })).preparationId,
      }, run.workspace);
    const { skillKeys, skillActivity } = preparation;

    let result: DesktopHarnessCodexTurnView;
    try {
      result = await this.runSupervisedCodexExecution({
        runId: run.id,
        prompt: input.prompt,
        skillKeys,
        recovery: false,
        ...(input.model ? { model: input.model } : {}),
      });
    } catch (initialError) {
      const category = nativeFailureCategory(initialError);
      if (category === "denied") throw initialError;
      let recoveryError: unknown = initialError;
      let recovered: DesktopHarnessCodexTurnView | null = null;
      for (let attempt = 1; attempt <= MAX_CODEX_RECOVERY_ATTEMPTS; attempt += 1) {
        try {
          recovered = await this.runSupervisedCodexExecution({
            runId: run.id,
            prompt: buildHarnessExecutionRecoveryPrompt(input.prompt, recoveryError, attempt),
            skillKeys,
            recovery: true,
            ...(input.model ? { model: input.model } : {}),
          });
          break;
        } catch (error) {
          recoveryError = error;
          if (nativeFailureCategory(error) === "denied") break;
        }
      }
      if (!recovered) {
        throw new Error(`Harness native execution recovery failed: ${boundedRecoveryText(safeMessage(recoveryError), 512)}`);
      }
      result = recovered;
    }
    let verification = await this.runNativeVerification(run.id);

    for (let attempt = 1; !verification.success && attempt <= MAX_CODEX_RECOVERY_ATTEMPTS; attempt += 1) {
      const recoveryPrompt = buildHarnessRecoveryPrompt(input.prompt, verification, attempt);
      result = await this.runSupervisedCodexExecution({
        runId: run.id,
        prompt: recoveryPrompt,
        skillKeys,
        recovery: true,
        ...(input.model ? { model: input.model } : {}),
      });
      verification = await this.runNativeVerification(run.id);
    }

    if (!verification.success) {
      const proof = verification.proofCommand ?? verification.proofType ?? "repository proof";
      const detail = boundedRecoveryText(verification.stderr || verification.stdout || "verification did not pass", 512);
      throw new Error(`Harness verification failed after recovery attempts (${proof}): ${detail}`);
    }
    const turn: DesktopHarnessCodexTurnView = {
      ...result,
      activeSkills: result.activeSkills.length > 0 ? result.activeSkills : skillKeys,
      skillActivity: {
        ...skillActivity,
        selectedSkillKeys: result.activeSkills.length > 0 ? result.activeSkills : skillActivity.selectedSkillKeys,
      },
    };
    this.options.activityStore?.attachThread(run.id, turn.threadId);
    return {
      turn,
      verification: {
        success: true,
        ...(verification.proofType ? { proofType: verification.proofType } : {}),
        ...(verification.proofCommand ? { proofCommand: verification.proofCommand } : {}),
      },
    };
  }

  private consumePreparedCodexTurn(input: { runId: string; prompt: string; preparationId: string }, workspace: string): {
    skillKeys: string[];
    skillActivity: DesktopHarnessCodexTurnPreparationView["skillActivity"];
  } {
    this.prunePreparedCodexTurns();
    const preparation = this.preparedCodexTurns.get(input.preparationId);
    if (!preparation) throw new Error("Codex turn skill preparation is missing or expired");
    this.preparedCodexTurns.delete(input.preparationId);
    const promptHash = createHash("sha256").update(input.prompt).digest("hex");
    if (preparation.runId !== input.runId || preparation.workspace !== workspace || preparation.promptHash !== promptHash) {
      throw new Error("Codex turn skill preparation no longer matches this prompt");
    }
    return { skillKeys: preparation.skillKeys, skillActivity: preparation.skillActivity };
  }

  private prunePreparedCodexTurns(): void {
    const now = Date.now();
    for (const [id, preparation] of this.preparedCodexTurns) {
      if (now - preparation.createdAt > CODEX_TURN_PREPARATION_TTL_MS) this.preparedCodexTurns.delete(id);
    }
    while (this.preparedCodexTurns.size >= MAX_CODEX_TURN_PREPARATIONS) {
      const oldest = this.preparedCodexTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      this.preparedCodexTurns.delete(oldest);
    }
  }

  private async runSupervisedCodexExecution(input: {
    runId: string;
    prompt: string;
    skillKeys: string[];
    recovery: boolean;
    model?: string;
  }): Promise<DesktopHarnessCodexTurnView> {
    await this.assertNativeLifecycleResponse(
      "/api/v1/harness/native/execution/start",
      { run_id: input.runId },
      input.runId,
    );
    try {
      const result = await this.options.codex!.run({
        runId: input.runId,
        prompt: input.prompt,
        skillKeys: input.skillKeys,
        ...(input.recovery ? { recovery: true } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      await this.assertNativeLifecycleResponse(
        "/api/v1/harness/native/execution/finish",
        { run_id: input.runId, success: true },
        input.runId,
      );
      return result;
    } catch (error) {
      await this.assertNativeLifecycleResponse(
        "/api/v1/harness/native/execution/finish",
        { run_id: input.runId, success: false, error_category: nativeFailureCategory(error) },
        input.runId,
      ).catch(() => undefined);
      throw error;
    }
  }

  private async runNativeVerification(runId: string): Promise<NativeVerificationResult> {
    const value = await this.options.client.harnessRequest(
      "/api/v1/harness/native/verification/run",
      { run_id: runId, timeout_ms: NATIVE_VERIFICATION_TIMEOUT_MS },
    );
    const result = parseNativeVerification(value);
    if (result.runId !== runId) throw new Error("SourceNerve native verification run mismatch");
    return result;
  }

  private async assertNativeLifecycleResponse(path: string, body: object, runId: string): Promise<void> {
    const value = await this.options.client.harnessRequest(path, body);
    if (!isRecordValue(value) || value.run_id !== runId) {
      throw new Error("SourceNerve native Harness lifecycle response is invalid");
    }
  }

  async cancelHarnessJob(input: DesktopHarnessJobCancelInput): Promise<DesktopHarnessJobView> {
    return parseHarnessJobCall(await this.options.client.harnessRequest(
      "/api/v1/harness/jobs/call",
      { run_id: input.runId, operation: "cancel", job_id: input.jobId },
    ));
  }

  async listHarnessApprovals(
    input: DesktopHarnessApprovalListInput,
  ): Promise<DesktopHarnessApprovalView[]> {
    return parseHarnessApprovalList(
      await this.options.client.harnessApprovalRequest(
        "/api/v1/harness/approvals/list",
        {
          run_id: input.runId,
          ...(input.status ? { status: input.status } : {}),
          limit: input.limit ?? 100,
        },
      ),
    );
  }

  async respondHarnessApproval(
    input: DesktopHarnessApprovalRespondInput,
  ): Promise<DesktopHarnessApprovalRespondResult> {
    return parseHarnessApprovalRespond(
      await this.options.client.harnessApprovalRequest(
        "/api/v1/harness/approvals/respond",
        { approval_id: input.approvalId, decision: input.decision },
      ),
    );
  }

  async begin(input: DesktopTaskBeginInput): Promise<DesktopTaskBeginResult> {
    await this.requireManagedWorkspace(input.workspace, true, true);
    const fingerprint = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
    let requestKey = this.beginKeys.get(fingerprint);
    if (!requestKey) {
      requestKey = `desktop:begin:${randomUUID()}`;
      if (this.beginKeys.size >= 16) this.beginKeys.delete(this.beginKeys.keys().next().value ?? "");
      this.beginKeys.set(fingerprint, requestKey);
    }

    const value = await this.options.client.taskRequest("/api/v1/tasks/begin", {
      workspace: input.workspace,
      client_request_id: requestKey,
      ...(input.contextQuery ? { context_query: input.contextQuery } : {}),
    });
    const begun = parseTaskBegin(value);
    if (begun.task.workspace !== input.workspace) throw new Error("SourceNerve task begin workspace mismatch");
    const snapshot = await this.get(begun.task.id);
    await this.options.registry.remember({
      taskId: snapshot.task.id,
      workspace: snapshot.task.workspace,
      createdAt: this.now().toISOString(),
    });
    this.beginKeys.delete(fingerprint);
    this.emit("ready", `Task ${snapshot.task.id} created at ${shortSha(snapshot.task.baseHead)}`);
    return {
      snapshot,
      replayed: begun.replayed,
    };
  }

  async readFile(input: DesktopTaskFileReadInput): Promise<DesktopTaskFileReadResult> {
    const snapshot = await this.get(input.taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, false, false);
    const file = await this.options.client.readWorkspaceFile(snapshot.task.workspace, input.path, 1, 1);
    return { path: file.path, sha256: file.sha256 };
  }

  async remember(taskId: string): Promise<DesktopTaskSnapshot> {
    const snapshot = await this.get(taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, false, false);
    await this.options.registry.remember({
      taskId: snapshot.task.id,
      workspace: snapshot.task.workspace,
      createdAt: this.now().toISOString(),
    });
    return snapshot;
  }

  async get(taskId: string): Promise<DesktopTaskSnapshot> {
    return parseTaskSnapshot(await this.options.client.taskRequest("/api/v1/tasks/get", { task_id: taskId }));
  }

  async cancel(taskId: string): Promise<DesktopTaskSnapshot> {
    const snapshot = await this.get(taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, false, false);
    const cancelled = parseTaskView(await this.options.client.taskRequest("/api/v1/tasks/cancel", { task_id: taskId }));
    if (cancelled.id !== taskId) throw new Error("SourceNerve cancelled a different task");
    this.emit("cancelled", `Task ${taskId} cancelled`);
    return this.get(taskId);
  }

  async checkoutBranch(input: DesktopTaskBranchInput): Promise<DesktopTaskBranchResult> {
    const snapshot = await this.get(input.taskId);
    const workspace = await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    if (!isSafeBranch(input.branch) || input.branch === workspace.defaultBranch) {
      throw new Error(`Feature branch must be safe and different from default branch ${workspace.defaultBranch}`);
    }
    const result = parseTaskBranchResult(await this.options.client.taskRequest("/api/v1/tasks/lifecycle/branch", {
      task_id: input.taskId,
      branch: input.branch,
    }));
    this.emit("branched", `Task ${input.taskId} branch ${result.lifecycle.branch ?? input.branch} ready`);
    return result;
  }

  async propose(input: DesktopTaskProposeInput): Promise<DesktopTaskProposalResult> {
    const snapshot = await this.get(input.taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    if (snapshot.task.status !== "active" || snapshot.lifecycle.phase !== "branched") {
      throw new Error(`Task must be active and branched before proposing a patch (status=${snapshot.task.status}, phase=${snapshot.lifecycle.phase})`);
    }
    const proposalHash = createHash("sha256")
      .update(JSON.stringify({ taskId: input.taskId, expectedFiles: input.expectedFiles, patch: input.patch }), "utf8")
      .digest("hex");
    const result = parseTaskProposalResult(await this.options.client.taskRequest("/api/v1/tasks/proposals/create", {
      task_id: input.taskId,
      idempotency_key: `desktop:proposal:${proposalHash.slice(0, 40)}`,
      expected_files: input.expectedFiles.map((item) => ({ path: item.path, sha256: item.sha256 ?? null })),
      patch: input.patch,
    }));
    if (result.proposal.taskId !== input.taskId) throw new Error("SourceNerve proposal task mismatch");
    this.emit("working", `Patch proposal ${result.proposal.id} validated for ${result.proposal.changedPaths.length} path(s)`);
    return result;
  }

  async apply(input: DesktopTaskApplyInput): Promise<DesktopTaskApplyResult> {
    const snapshot = await this.get(input.taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    const proposal = snapshot.proposals.find((item) => item.id === input.proposalId);
    if (!proposal || proposal.status !== "proposed") throw new Error("Selected task proposal is no longer applicable; refresh the task");
    const result = parseTaskApplyResult(await this.options.client.taskRequest("/api/v1/tasks/proposals/apply", {
      task_id: input.taskId,
      proposal_id: input.proposalId,
    }));
    this.emit("patched", `Task ${input.taskId} patch applied; review the complete delta before commit`);
    return result;
  }

  async review(taskId: string): Promise<DesktopTaskReviewResult> {
    const snapshot = await this.get(taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    const result = parseTaskReviewResult(await this.options.client.taskRequest("/api/v1/tasks/lifecycle/review", { task_id: taskId }));
    this.emit("reviewed", `Task ${taskId} reviewed diff ${shortSha(result.review.diffSha256)}`);
    return result;
  }

  async commit(input: DesktopTaskCommitInput): Promise<DesktopTaskCommitResult> {
    const snapshot = await this.get(input.taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    if (snapshot.lifecycle.phase !== "reviewed") throw new Error(`Task must be reviewed before commit (phase=${snapshot.lifecycle.phase})`);
    const result = parseTaskCommitResult(await this.options.client.taskRequest("/api/v1/tasks/lifecycle/commit", {
      task_id: input.taskId,
      message: input.message,
    }));
    this.emit("committed", `Task ${input.taskId} committed ${shortSha(result.commit.commit)}`);
    return result;
  }

  async push(taskId: string): Promise<DesktopTaskPushResult> {
    const snapshot = await this.get(taskId);
    await this.requireManagedWorkspace(snapshot.task.workspace, true, false);
    if (snapshot.lifecycle.phase !== "committed") throw new Error(`Task must be committed before push (phase=${snapshot.lifecycle.phase})`);
    const result = parseTaskPushResult(await this.options.client.taskRequest("/api/v1/tasks/lifecycle/push", { task_id: taskId }));
    this.emit("pushed", `Task ${taskId} pushed exact commit ${shortSha(result.push.head)}`);
    return result;
  }

  notifyCompleted(taskId: string, head: string): void {
    const key = `${taskId}:${head}`;
    if (this.completionNotificationKeys.has(key)) return;
    if (this.completionNotificationKeys.size >= MAX_COMPLETION_NOTIFICATION_KEYS) {
      const oldest = this.completionNotificationKeys.values().next().value;
      if (oldest) this.completionNotificationKeys.delete(oldest);
    }
    this.completionNotificationKeys.add(key);
    this.emit("completed", `Task ${taskId} completed at ${shortSha(head)}`);
  }

  private async releaseTerminalCodexRuns(runs: readonly DesktopHarnessRunView[]): Promise<void> {
    if (!this.options.codex) return;
    const terminal = runs.filter((run) => run.status !== "running");
    if (terminal.length === 0) return;
    await Promise.all(terminal.map((run) => this.options.codex!.release(run.id).catch(() => undefined)));
  }

  private observeHarnessJobTransitions(jobs: readonly DesktopHarnessJobView[]): void {
    for (const job of jobs) {
      const previous = this.harnessJobStatuses.get(job.id);
      if (this.harnessJobStatuses.has(job.id)) this.harnessJobStatuses.delete(job.id);
      this.harnessJobStatuses.set(job.id, job.status);
      if (previous !== undefined && previous !== "completed" && job.status === "completed") {
        this.options.onEvent?.({
          type: "state",
          component: "harness",
          state: "completed",
          message: `Harness job ${job.id} (${job.kind}) completed`,
        });
      }
    }
    while (this.harnessJobStatuses.size > MAX_COMPLETION_NOTIFICATION_KEYS) {
      const oldest = this.harnessJobStatuses.keys().next().value;
      if (!oldest) break;
      this.harnessJobStatuses.delete(oldest);
    }
  }

  private async requireManagedWorkspace(
    workspaceId: string,
    writable: boolean,
    beginReady: boolean,
  ): Promise<ManagedWorkspaceView> {
    const workspaces = await this.options.workspaceManager.listManagedWorkspaces();
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.validation.state !== "ready") throw new Error(`Workspace ${workspaceId} is not a ready Desktop-managed workspace`);
    if (writable && workspace.access !== "read-write") throw new Error(`Workspace ${workspaceId} is read-only; task mutation actions are unavailable`);
    if (beginReady) {
      if (workspace.branch && workspace.branch !== workspace.defaultBranch) throw new Error(`Workspace ${workspaceId} must be on default branch ${workspace.defaultBranch} before beginning a task`);
    }
    return workspace;
  }

  private emit(state: string, message: string): void {
    this.options.onEvent?.({ type: "state", component: "task", state, message });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}


function familyView(family: AgentWorkerFamily): DesktopHarnessAgentWorkerFamilyView {
  return {
    familyId: family.familyId,
    primeRunId: family.primeRunId,
    incarnation: family.incarnation,
    workers: family.workers.map(workerView),
  };
}

function workerView(worker: AgentWorker): DesktopHarnessAgentWorkerView {
  return {
    workerRunId: worker.workerRunId,
    ordinal: worker.ordinal,
    workspace: worker.workspace,
    status: worker.status,
    ...(worker.leaseId ? { leaseId: worker.leaseId } : {}),
    ...(worker.lastReport ? { lastReport: worker.lastReport } : {}),
    ...(worker.lastChildRunId ? { lastChildRunId: worker.lastChildRunId } : {}),
  };
}

function mergeConversationActivities(
  primaryActivities: DesktopHarnessCodexActivityView[],
  secondaryActivities: DesktopHarnessCodexActivityView[],
): DesktopHarnessCodexActivityView[] {
  const byId = new Map<string, DesktopHarnessCodexActivityView>();
  for (const activity of [...primaryActivities, ...secondaryActivities]) byId.set(activity.id, activity);
  return [...byId.values()].sort((left, right) => left.position - right.position);
}

function mergeConversationHistoryMessages(
  nativeMessages: DesktopHarnessCodexConversationMessage[],
  directMessages: DesktopHarnessCodexConversationMessage[],
): DesktopHarnessCodexConversationMessage[] {
  const byId = new Map<string, DesktopHarnessCodexConversationMessage>();
  const exactMessages = new Set<string>();
  for (const message of [...nativeMessages, ...directMessages]) {
    const exactKey = `${message.role}\u0000${message.createdAt}\u0000${message.text}`;
    if (exactMessages.has(exactKey) && !byId.has(message.id)) continue;
    exactMessages.add(exactKey);
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function directChatGptTranscriptText(raw: string, state: "done" | "blocked"): string {
  const text = raw.replace(/\r\n/g, "\n");
  const field = (name: string) => text.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\n(?:STATE|TASK_ID|ITERATION|SUMMARY|REVIEW|REASON|PLAN|RESULT|ANSWER|PROOF|DETAIL|NEEDS):|\\n\\[/C2C\\]|$)`, "mi"))?.[1]?.trim() ?? "";
  if (state === "done") return field("ANSWER") || "ChatGPT completed the turn.";
  return [field("REASON"), field("DETAIL")].filter(Boolean).join(" — ") || field("ANSWER") || "ChatGPT could not complete the turn.";
}

function parseChatGptDirectAgentReply(raw: string, taskId: string) {
  const expected = { taskId, iterations: { DONE: 0, BLOCKED: 0 } as const };
  // Direct ChatGPT owns the turn and all repository mutations still pass through
  // Harness policy. If the model returns a normal user-facing answer but omits
  // the transport-only C2C wrapper, preserve the answer instead of reporting a
  // false connector failure. Explicit C2C replies remain strict so stale task
  // ids, invalid iterations, and malformed control states are still rejected.
  if (/(?:^|\n)\[C2C\]/.test(raw)) {
    return parseChatGptReviewControlMessage(raw, expected);
  }
  if (!raw.trim()) {
    return parseChatGptReviewControlMessage(raw, expected);
  }
  const answer = raw.trim();
  const synthesized = [
    "[C2C]",
    "STATE: DONE",
    `TASK_ID: ${taskId}`,
    "ITERATION: 0",
    "",
    "ANSWER:",
    answer,
  ].join("\n");
  return parseChatGptReviewControlMessage(synthesized, expected);
}

function buildChatGptDirectAgentGoal(prompt: string): string {
  return boundedRecoveryText([
    "DIRECT CHATGPT AGENT MODE",
    "ChatGPT owns the repository task through SourceNerve/Harness MCP tools. Do not delegate to native Codex and do not ask Codex to execute anything.",
    "Use the SourceNerve Harness connector for the exact WORKSPACE. Treat HARNESS_RUN_ID as a Desktop correlation id only; do not call harness_run_get as a startup precondition and do not block solely because that run id is unavailable or not found. Repository reads, writes, commands, approvals, and provider actions must go through SourceNerve/Harness tool policy only.",
    "After completing the requested work, return DONE. If the connector/tools/approvals are unavailable, return BLOCKED. Do not return PLAN in this mode because there is no Codex executor behind ChatGPT.",
    "ANSWER must be the actual user-facing result, not an acknowledgement. For repository analysis/review prompts, include concrete findings, affected files/components, risks, evidence inspected, and recommended next steps when relevant.",
    "Never return only phrases like: I analyzed the current source, analyzed at HEAD, or no implementation cycle is needed.",
    "For casual chat or prompts that require no repository action, return DONE with ANSWER: as a normal assistant reply.",
    "",
    "USER PROMPT:",
    prompt,
  ].join("\n"), MAX_RECOVERY_CONTEXT_BYTES);
}

function buildAgentWorkerPrompt(family: AgentWorkerFamily, worker: AgentWorker, prompt: string): string {
  return boundedRecoveryText([
    "SourceNerve multi-agent worker execution.",
    `Prime Harness run: ${family.primeRunId}`,
    `Family: ${family.familyId} incarnation ${family.incarnation}`,
    `Worker: ${worker.workerRunId} ordinal ${worker.ordinal}`,
    "",
    "Worker boundary:",
    "- Work only inside the assigned workspace and original operator brief.",
    "- Inspect current repository state before changing files.",
    "- Do not commit, push, merge, or perform provider mutations unless the original operator request explicitly asked for that action.",
    "- Finish with a concise report that can be published back to the prime family.",
    "",
    "WORKER TASK:",
    prompt,
  ].join("\n"), MAX_RECOVERY_CONTEXT_BYTES);
}

interface NativeVerificationResult {
  runId: string;
  skipped: boolean;
  proofType?: string;
  proofSource?: string;
  proofCommand?: string;
  success: boolean;
  exitCode?: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function parseNativeVerification(value: unknown): NativeVerificationResult {
  if (!isRecordValue(value) || typeof value.run_id !== "string" || value.run_id.length === 0 || value.run_id.length > 128) {
    throw new Error("SourceNerve native verification response is invalid");
  }
  if (typeof value.skipped !== "boolean" || typeof value.success !== "boolean" || typeof value.timed_out !== "boolean" || typeof value.truncated !== "boolean") {
    throw new Error("SourceNerve native verification status is invalid");
  }
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string" || value.stdout.length > 300_000 || value.stderr.length > 300_000) {
    throw new Error("SourceNerve native verification output is invalid");
  }
  const optionalText = (field: unknown, max: number): string | undefined => {
    if (field === null || field === undefined) return undefined;
    if (typeof field !== "string" || field.length === 0 || field.length > max || /[\u0000\r\n]/.test(field)) {
      throw new Error("SourceNerve native verification metadata is invalid");
    }
    return field;
  };
  const exitCode = value.exit_code === null || value.exit_code === undefined
    ? undefined
    : Number.isSafeInteger(value.exit_code) ? Number(value.exit_code) : (() => { throw new Error("SourceNerve native verification exit code is invalid"); })();
  return {
    runId: value.run_id,
    skipped: value.skipped,
    proofType: optionalText(value.proof_type, 64),
    proofSource: optionalText(value.proof_source, 512),
    proofCommand: optionalText(value.proof_command, 1024),
    success: value.success,
    exitCode,
    timedOut: value.timed_out,
    stdout: value.stdout,
    stderr: value.stderr,
    truncated: value.truncated,
  };
}

function buildHarnessExecutionRecoveryPrompt(originalPrompt: string, error: unknown, attempt: number): string {
  const parts = [
    CODEX_HARNESS_INTERNAL_RECOVERY_PREFIX,
    `Harness observed a native Codex execution failure (recovery attempt ${attempt}/${MAX_CODEX_RECOVERY_ATTEMPTS}).`,
    `Failure evidence: ${boundedRecoveryText(safeMessage(error), 4 * 1024)}`,
    `Original user request: ${boundedRecoveryText(originalPrompt, 8 * 1024)}`,
    "Recover the interrupted work in the same workspace and thread. Inspect the current repository state before changing anything, continue only the missing work, run relevant checks, and finish with a concise user-facing summary.",
  ];
  return boundedRecoveryText(parts.join("\n\n"), MAX_RECOVERY_CONTEXT_BYTES);
}

function buildHarnessRecoveryPrompt(originalPrompt: string, verification: NativeVerificationResult, attempt: number): string {
  const parts = [
    CODEX_HARNESS_INTERNAL_RECOVERY_PREFIX,
    `Harness deterministic verification failed (recovery attempt ${attempt}/${MAX_CODEX_RECOVERY_ATTEMPTS}).`,
    verification.proofCommand ? `Required proof: ${verification.proofCommand}` : verification.proofType ? `Required proof type: ${verification.proofType}` : "Required repository proof is unavailable.",
    verification.exitCode === undefined ? undefined : `Proof exit code: ${verification.exitCode}`,
    verification.timedOut ? "Proof timed out." : undefined,
    `Failure evidence: ${boundedRecoveryText(verification.stderr || verification.stdout || "No proof output was returned.", 8 * 1024)}`,
    `Original user request: ${boundedRecoveryText(originalPrompt, 8 * 1024)}`,
    "Recover the implementation rather than merely explaining the failure. Inspect the evidence, make the minimum necessary changes, run the relevant checks, and finish with a concise user-facing summary.",
  ].filter((part): part is string => Boolean(part));
  return boundedRecoveryText(parts.join("\n\n"), MAX_RECOVERY_CONTEXT_BYTES);
}


function chatGptStageProgressText(
  state: "planning" | "executing" | "verifying" | "reviewing" | "done" | "blocked",
  iteration: number,
  mode: "review" | "goal" | "loop",
): string {
  if (state === "planning") return mode === "review" ? "Inspecting workspace and task context…" : "Planning the next bounded step in ChatGPT Web…";
  if (state === "executing") return `Executing iteration ${Math.max(1, iteration)} through the verified native Codex lane…`;
  if (state === "verifying") return iteration > 0
    ? `Verifying iteration ${iteration} with Harness proof…`
    : "Verifying repository state and proof…";
  if (state === "reviewing") return `Reviewing verified iteration ${Math.max(1, iteration)} in ChatGPT Web…`;
  if (state === "blocked") return "Waiting on required evidence or operator action…";
  return "Finalizing the verified result…";
}


function summaryValue(summary: string, field: string): string | null {
  const match = summary.match(new RegExp(`(?:^|[\\s·])${field}=([^\\s·]+)`));
  return match?.[1] ?? null;
}

function humanizeToolProgress(tool: string): string {
  if (tool.includes("read_file") || tool.includes("file_fetch")) return "Reading files";
  if (tool.includes("file_write") || tool.includes("file_put") || tool.includes("patch_apply")) return "Editing files";
  if (tool.includes("workspace_exec")) return "Running command";
  if (tool.includes("git_review") || tool.includes("git_diff")) return "Reviewing changes";
  if (tool.includes("git_commit")) return "Committing changes";
  if (tool.includes("git_push")) return "Pushing changes";
  if (tool.includes("pull")) return "Updating pull request";
  const normalized = tool.replaceAll("_", " ").replaceAll("-", " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Harness tool";
}

function boundedRecoveryText(value: string, maxBytes: number): string {
  const normalized = value.replace(/\u0000/g, "");
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= maxBytes) return normalized;
  return `${bytes.subarray(0, Math.max(1, maxBytes - 3)).toString("utf8").replace(/�+$/g, "")}…`;
}

function nativeFailureCategory(error: unknown): string {
  const message = safeMessage(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("approval") || message.includes("denied")) return "denied";
  return "tool-error";
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return result;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 512) : "Task is unavailable";
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
