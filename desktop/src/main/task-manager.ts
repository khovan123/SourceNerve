import { createHash, randomUUID } from "node:crypto";

import type { DesktopRuntimeEvent, ManagedWorkspaceView } from "../shared/desktop-api";
import type {
  DesktopHarnessCodexAccountInput,
  DesktopHarnessCodexAccountView,
  DesktopHarnessCodexConversationClearInput,
  DesktopHarnessCodexConversationClearResult,
  DesktopHarnessCodexConversationInput,
  DesktopHarnessCodexConversationListInput,
  DesktopHarnessCodexConversationResumeInput,
  DesktopHarnessCodexConversationSummary,
  DesktopHarnessCodexConversationView,
  DesktopHarnessCodexSetupView,
  DesktopHarnessCodexStatusInput,
  DesktopHarnessCodexStatusView,
  DesktopHarnessCodexUsageInput,
  DesktopHarnessCodexUsageView,
  DesktopHarnessCodexTurnInput,
  DesktopHarnessCodexTurnView,
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
const NATIVE_VERIFICATION_TIMEOUT_MS = 600_000;
const MAX_RECOVERY_CONTEXT_BYTES = 24 * 1024;

export class DesktopTaskManager {
  private readonly beginKeys = new Map<string, string>();
  private readonly completionNotificationKeys = new Set<string>();
  private readonly harnessJobStatuses = new Map<string, string>();

  constructor(private readonly options: {
    client: SourceNerveClient;
    workspaceManager: WorkspaceManager;
    registry: DesktopTaskRegistry;
    codex?: Pick<CodexHarnessRuntime, "account" | "status" | "usage" | "run" | "release" | "clearWorkspace" | "listConversations" | "conversation" | "resumeConversation">;
    codexSetup?: Pick<CodexCliManager, "status" | "install" | "login">;
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
    const routed = parseHarnessContextRoute(value);
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
    const run = parseHarnessRunSnapshot(await this.options.client.harnessRequest(
      "/api/v1/harness/runs/cancel",
      { run_id: input.runId },
    ));
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
    if (!this.options.codex) return { runId: run.id, workspace: run.workspace, messages: [] };
    return this.options.codex.conversation(run.id);
  }

  async listHarnessCodexConversations(input: DesktopHarnessCodexConversationListInput): Promise<DesktopHarnessCodexConversationSummary[]> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    if (!this.options.codex) return [];
    return this.options.codex.listConversations(input.workspace);
  }

  async resumeHarnessCodexConversation(input: DesktopHarnessCodexConversationResumeInput): Promise<DesktopHarnessCodexConversationView> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    if (!this.options.codex) throw new Error("Desktop Codex Harness runtime is not initialized");
    const available = await this.options.codex.listConversations(input.workspace);
    if (!available.some((conversation) => conversation.threadId === input.threadId)) {
      throw new Error("Codex conversation does not belong to the selected workspace");
    }

    const run = await this.beginHarnessRun({
      workspace: input.workspace,
      profile: "interactive-local",
      sandbox: "workspace-write",
    });
    try {
      return await this.options.codex.resumeConversation({ runId: run.id, threadId: input.threadId });
    } catch (error) {
      await this.cancelHarnessRun({ runId: run.id }).catch(() => undefined);
      throw error;
    }
  }

  async clearHarnessCodexConversations(input: DesktopHarnessCodexConversationClearInput): Promise<DesktopHarnessCodexConversationClearResult> {
    await this.requireManagedWorkspace(input.workspace, false, false);
    const conversations = this.options.codex ? await this.options.codex.listConversations(input.workspace) : [];
    await this.options.codex?.clearWorkspace(input.workspace);
    return { workspace: input.workspace, deleted: conversations.length };
  }

  async runHarnessCodexTurn(input: DesktopHarnessCodexTurnInput): Promise<DesktopHarnessCodexTurnView> {
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

    let result: DesktopHarnessCodexTurnView;
    try {
      result = await this.runSupervisedCodexExecution({
        runId: run.id,
        prompt: input.prompt,
        skillKeys,
        recovery: false,
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
      });
      verification = await this.runNativeVerification(run.id);
    }

    if (!verification.success) {
      const proof = verification.proofCommand ?? verification.proofType ?? "repository proof";
      const detail = boundedRecoveryText(verification.stderr || verification.stdout || "verification did not pass", 512);
      throw new Error(`Harness verification failed after recovery attempts (${proof}): ${detail}`);
    }
    return result;
  }

  private async runSupervisedCodexExecution(input: {
    runId: string;
    prompt: string;
    skillKeys: string[];
    recovery: boolean;
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