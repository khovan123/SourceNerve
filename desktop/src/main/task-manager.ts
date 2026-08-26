import { createHash, randomUUID } from "node:crypto";

import type { DesktopRuntimeEvent, ManagedWorkspaceView } from "../shared/desktop-api";
import type {
  DesktopTaskApplyInput,
  DesktopTaskApplyResult,
  DesktopTaskBeginInput,
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

const MAX_LISTED_TASKS = 50;
const LIST_CONCURRENCY = 6;
const MAX_COMPLETION_NOTIFICATION_KEYS = 128;

export class DesktopTaskManager {
  private readonly beginKeys = new Map<string, string>();
  private readonly completionNotificationKeys = new Set<string>();

  constructor(private readonly options: {
    client: SourceNerveClient;
    workspaceManager: WorkspaceManager;
    registry: DesktopTaskRegistry;
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
      context_max_bytes: input.contextMaxBytes,
      context_max_items: input.contextMaxItems,
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
    this.emit("ready", `Task ${snapshot.task.id} created at ${shortSha(snapshot.task.baseHead)} / graph v${snapshot.task.graphVersion}`);
    return {
      snapshot,
      ...(begun.context ? { context: begun.context } : {}),
      replayed: begun.replayed,
    };
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
      if (workspace.index.state !== "current") throw new Error(`Workspace ${workspaceId} must have a current index before beginning a task`);
      if (workspace.dirty) throw new Error(`Workspace ${workspaceId} must be clean before beginning a task`);
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
