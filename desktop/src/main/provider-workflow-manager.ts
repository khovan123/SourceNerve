import type { GitProvider, ManagedWorkspaceView } from "../shared/desktop-api";
import type {
  ProviderDefaultSyncResult,
  ProviderIssueCreateInput,
  ProviderIssueCreateResult,
  ProviderIssueView,
  ProviderPullCreateInput,
  ProviderPullCreateResult,
  ProviderPullMergeInput,
  ProviderPullMergeResult,
  ProviderPullView,
  ProviderWorkflowState,
} from "../shared/provider-workflow-api";
import type { ProviderManager } from "./provider-manager";
import type { ProviderWorkflowClient } from "./provider-workflow-client";
import { parseProviderIssue, parseProviderPull, replayedFlag } from "./provider-workflow-parser";
import type { DesktopTaskManager } from "./task-manager";
import type { DesktopTaskSnapshot } from "../shared/task-api";
import type { WorkspaceManager } from "./workspace-manager";

export class ProviderWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderWorkflowConflictError";
  }
}

export class ProviderWorkflowManager {
  constructor(private readonly options: {
    client: ProviderWorkflowClient;
    tasks: DesktopTaskManager;
    workspaces: WorkspaceManager;
    providers: ProviderManager;
  }) {}

  async state(taskId: string): Promise<ProviderWorkflowState> {
    const context = await this.context(taskId, false);
    const pull = context.task.lifecycle.pullNumber
      ? await this.fetchPull(context)
      : undefined;
    return this.toState(context, pull);
  }

  async createIssue(input: ProviderIssueCreateInput): Promise<ProviderIssueCreateResult> {
    const context = await this.context(input.taskId, true);
    this.assertTaskUsable(context.task);
    const raw = await this.options.client.createIssue(input);
    const refreshed = await this.context(input.taskId, true);
    const issueNumber = refreshed.task.lifecycle.issueNumber;
    if (!issueNumber) throw new Error("SourceNerve did not persist the provider issue number");
    const parsed = parseProviderIssue(raw, {
      provider: context.provider,
      repository: context.repository,
      fallbackTitle: input.title,
    });
    if (parsed && parsed.number !== issueNumber) {
      throw new ProviderWorkflowConflictError("Provider issue number differs from the durable task lifecycle; refresh before continuing");
    }
    const issue: ProviderIssueView = parsed ?? {
      provider: context.provider,
      repository: context.repository,
      number: issueNumber,
      title: input.title,
      state: "open",
    };
    return { issue, replayed: replayedFlag(raw) };
  }

  async createPull(input: ProviderPullCreateInput): Promise<ProviderPullCreateResult> {
    const context = await this.context(input.taskId, true);
    if (context.task.lifecycle.phase !== "pushed" || !context.task.lifecycle.pushSha || !context.task.lifecycle.branch) {
      throw new Error(`Task must be pushed before creating a pull request (phase=${context.task.lifecycle.phase})`);
    }
    const raw = await this.options.client.createPull(input);
    const refreshed = await this.context(input.taskId, true);
    const lifecycle = refreshed.task.lifecycle;
    if (!lifecycle.pullNumber || !lifecycle.pullHeadSha) {
      throw new Error("SourceNerve did not persist pull request identity/head after creation");
    }
    const pull = await this.fetchPull(refreshed);
    this.assertPullMatchesLifecycle(refreshed, pull);
    if (pull.headSha !== refreshed.task.lifecycle.pushSha) {
      throw new ProviderWorkflowConflictError("Created pull request head does not match the exact pushed task commit; refresh task/provider state");
    }
    if (pull.baseBranch !== refreshed.workspace.defaultBranch) {
      throw new ProviderWorkflowConflictError(`Created pull request base is ${pull.baseBranch}, expected ${refreshed.workspace.defaultBranch}`);
    }
    return { pull, replayed: replayedFlag(raw) };
  }

  async refreshPull(taskId: string): Promise<ProviderPullView> {
    const context = await this.context(taskId, true);
    if (!context.task.lifecycle.pullNumber) throw new Error("Task has no provider pull request to refresh");
    const pull = await this.fetchPull(context);
    if (pull.number !== context.task.lifecycle.pullNumber) {
      throw new ProviderWorkflowConflictError("Provider pull request number differs from the durable task lifecycle");
    }
    return pull;
  }

  async mergePull(input: ProviderPullMergeInput): Promise<ProviderPullMergeResult> {
    const context = await this.context(input.taskId, true);
    const lifecycle = context.task.lifecycle;
    if (lifecycle.phase !== "pr_open" || !lifecycle.pullNumber || !lifecycle.pullHeadSha) {
      throw new Error(`Task must have an open persisted pull request before merge (phase=${lifecycle.phase})`);
    }
    const fresh = await this.fetchPull(context);
    if (fresh.state !== "open") {
      throw new ProviderWorkflowConflictError(`Provider pull request is ${fresh.state}; refresh before merge`);
    }
    if (fresh.baseBranch !== context.workspace.defaultBranch) {
      throw new ProviderWorkflowConflictError(`Provider base branch changed to ${fresh.baseBranch}; expected ${context.workspace.defaultBranch}`);
    }
    if (fresh.headSha !== input.expectedHeadSha) {
      throw new ProviderWorkflowConflictError(`Provider head changed from the SHA being confirmed (${shortSha(input.expectedHeadSha)} → ${shortSha(fresh.headSha)}). Refresh and review the new head before merge.`);
    }
    if (fresh.headSha !== lifecycle.pullHeadSha) {
      throw new ProviderWorkflowConflictError(`Provider head ${shortSha(fresh.headSha)} differs from task-recorded head ${shortSha(lifecycle.pullHeadSha)}. Refresh task/provider state; Desktop will not guess a replacement SHA.`);
    }
    if (fresh.mergeable === false) {
      throw new ProviderWorkflowConflictError(`Provider reports this change request is not mergeable${fresh.mergeState ? ` (${fresh.mergeState})` : ""}. Required checks, reviews or branch protection remain provider-owned constraints.`);
    }

    const raw = await this.options.client.mergePull({
      taskId: input.taskId,
      expectedHeadSha: fresh.headSha,
      method: input.method,
    });
    const refreshed = await this.context(input.taskId, true);
    if (!refreshed.task.lifecycle.mergeSha) {
      throw new Error("SourceNerve did not persist a merge SHA after provider merge");
    }
    const pull = await this.fetchPull(refreshed);
    if (pull.headSha !== fresh.headSha) {
      throw new ProviderWorkflowConflictError("Provider pull head changed during merge completion; refresh provider state");
    }
    return {
      pull,
      mergeSha: refreshed.task.lifecycle.mergeSha,
      replayed: replayedFlag(raw),
    };
  }

  async syncDefault(taskId: string): Promise<ProviderDefaultSyncResult> {
    const context = await this.context(taskId, true);
    const lifecycle = context.task.lifecycle;
    if (lifecycle.phase !== "merged" || !lifecycle.mergeSha) {
      throw new Error(`Task must be merged before syncing the default branch (phase=${lifecycle.phase})`);
    }
    const raw = await this.options.client.syncDefault(taskId);
    const refreshed = await this.context(taskId, true);
    const head = refreshed.task.lifecycle.defaultSyncedHead;
    if (!head) throw new Error("SourceNerve did not persist the synced default-branch head");
    return {
      taskId,
      workspace: refreshed.workspace.id,
      defaultBranch: refreshed.workspace.defaultBranch,
      head,
      replayed: replayedFlag(raw),
    };
  }

  private async context(taskId: string, requireConnectedProvider: boolean): Promise<ProviderContext> {
    const task = await this.options.tasks.get(taskId);
    const workspaces = await this.options.workspaces.listManagedWorkspaces();
    const workspace = workspaces.find((item) => item.id === task.task.workspace);
    if (!workspace || workspace.validation.state !== "ready") {
      throw new Error(`Workspace ${task.task.workspace} is not a ready Desktop-managed workspace`);
    }
    if (!workspace.provider || !workspace.repository) {
      throw new Error(`Workspace ${workspace.id} has no explicit GitHub/GitLab provider configuration`);
    }
    if (requireConnectedProvider) {
      const providerState = this.options.providers.states().find((item) => item.provider === workspace.provider);
      if (!providerState || providerState.status !== "connected") {
        throw new Error(`${providerLabel(workspace.provider)} is not connected; reconnect it in Connections before provider operations`);
      }
    }
    return {
      task,
      workspace,
      provider: workspace.provider,
      repository: workspace.repository,
    };
  }

  private assertTaskUsable(task: DesktopTaskSnapshot): void {
    if (task.task.status === "cancelled" || task.task.status === "stale") {
      throw new Error(`Provider operation is unavailable for task status ${task.task.status}`);
    }
  }

  private async fetchPull(context: ProviderContext): Promise<ProviderPullView> {
    const raw = await this.options.client.getPull(context.task.task.id);
    return parseProviderPull(raw, {
      provider: context.provider,
      repository: context.repository,
    });
  }

  private assertPullMatchesLifecycle(context: ProviderContext, pull: ProviderPullView): void {
    const lifecycle = context.task.lifecycle;
    if (!lifecycle.pullNumber || pull.number !== lifecycle.pullNumber) {
      throw new ProviderWorkflowConflictError("Provider pull request identity differs from the durable task lifecycle");
    }
    if (!lifecycle.pullHeadSha || pull.headSha !== lifecycle.pullHeadSha) {
      throw new ProviderWorkflowConflictError("Provider pull head differs from the durable task lifecycle; refresh before continuing");
    }
  }

  private toState(context: ProviderContext, pull?: ProviderPullView): ProviderWorkflowState {
    const lifecycle = context.task.lifecycle;
    return {
      taskId: context.task.task.id,
      workspace: context.workspace.id,
      provider: context.provider,
      repository: context.repository,
      defaultBranch: context.workspace.defaultBranch,
      lifecyclePhase: lifecycle.phase,
      ...(lifecycle.pushSha ? { taskPushSha: lifecycle.pushSha } : {}),
      ...(lifecycle.branch ? { taskBranch: lifecycle.branch } : {}),
      ...(lifecycle.issueNumber ? { issueNumber: lifecycle.issueNumber } : {}),
      ...(lifecycle.pullNumber ? { pullNumber: lifecycle.pullNumber } : {}),
      ...(lifecycle.pullHeadSha ? { pullHeadSha: lifecycle.pullHeadSha } : {}),
      ...(lifecycle.mergeSha ? { mergeSha: lifecycle.mergeSha } : {}),
      ...(lifecycle.defaultSyncedHead ? { defaultSyncedHead: lifecycle.defaultSyncedHead } : {}),
      ...(pull ? { pull } : {}),
    };
  }
}

interface ProviderContext {
  task: DesktopTaskSnapshot;
  workspace: ManagedWorkspaceView;
  provider: GitProvider;
  repository: string;
}

function providerLabel(provider: GitProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
