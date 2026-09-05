import path from "node:path";

import type { ManagedWorkspaceView } from "../shared/desktop-api";
import type { DesktopHarnessRunView } from "../shared/harness-api";
import type { JsonRpcServerRequest } from "./codex-jsonrpc";
import type { CodexRuntimeRequestContext } from "./codex-runtime-pool";
import type { CodexAccountReadResponse } from "./codex-protocol";
import type { CodexThinRunner, CodexThinRunnerResult } from "./codex-thin-runner";

const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACTIVE_SKILLS = 2;
const DEFAULT_APPROVAL_POLL_MS = 250;
const DEFAULT_APPROVAL_WAIT_MS = 5 * 60 * 1000;

export interface CodexNativeApprovalResolveInput {
  runId: string;
  requestId: string;
  method: string;
  payload: unknown;
}

export interface CodexNativeApprovalResolution {
  decision: "pending" | "allow" | "deny";
  approvalId: string;
  status: "pending" | "allowed" | "denied" | "consumed" | "expired";
  created: boolean;
}

export interface CodexHarnessRuntimeOptions {
  runner: CodexThinRunner;
  listWorkspaces(): Promise<ManagedWorkspaceView[]>;
  loadRun(runId: string): Promise<DesktopHarnessRunView>;
  resolveApproval?(input: CodexNativeApprovalResolveInput): Promise<CodexNativeApprovalResolution>;
  approvalPollMs?: number;
  approvalWaitMs?: number;
}

export interface CodexHarnessTurnInput {
  runId: string;
  prompt: string;
  skillKeys?: readonly string[];
}

export interface CodexHarnessAccountView {
  authenticated: boolean;
  accountType: "apiKey" | "chatgpt" | "amazonBedrock" | null;
  planType?: string;
  requiresOpenaiAuth: boolean;
}

export interface CodexHarnessTurnView {
  runId: string;
  workspace: string;
  threadId: string;
  turnId: string;
  status: CodexThinRunnerResult["status"];
  response?: string;
  resumed: boolean;
  recoveredBeforeTurn: boolean;
  activeSkills: string[];
}

/**
 * P3 production bridge between an authoritative Harness run and the native
 * Codex app-server lane. The renderer cannot choose cwd, sandbox or approval
 * policy; all three are projected from the current Harness run/workspace.
 *
 * Native app-server escalation callbacks are forwarded into the durable
 * Harness approval ledger. The callback stays pending until the exact one-shot
 * approval is allowed/denied/expired; renderer code never receives authority to
 * choose cwd, sandbox, approval scope or session-wide acceptance.
 */
export class CodexHarnessRuntime {
  private initialized = false;
  private shuttingDown = false;
  private readonly cancelledRuns = new Set<string>();
  private readonly pendingApprovalCounts = new Map<string, number>();
  private readonly approvalPollMs: number;
  private readonly approvalWaitMs: number;

  constructor(private readonly options: CodexHarnessRuntimeOptions) {
    this.approvalPollMs = boundedDuration(options.approvalPollMs, DEFAULT_APPROVAL_POLL_MS, 10, 5_000, "Codex approval poll interval");
    this.approvalWaitMs = boundedDuration(options.approvalWaitMs, DEFAULT_APPROVAL_WAIT_MS, 100, 10 * 60 * 1000, "Codex approval wait timeout");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.options.runner.initialize();
    this.shuttingDown = false;
    this.initialized = true;
  }

  async account(workspaceId: string): Promise<CodexHarnessAccountView> {
    await this.initialize();
    const workspace = await this.requireWorkspace(workspaceId, false);
    return sanitizeAccount(await this.options.runner.account(workspace.root));
  }

  async run(input: CodexHarnessTurnInput): Promise<CodexHarnessTurnView> {
    await this.initialize();
    validateTurnInput(input);
    const run = await this.options.loadRun(input.runId);
    const workspace = await this.requireRunnable(run);
    this.cancelledRuns.delete(run.id);
    const result = await this.options.runner.run({
      runId: run.id,
      workspaceId: run.workspace,
      cwd: workspace.root,
      prompt: input.prompt,
      ...(input.skillKeys === undefined ? {} : { skillKeys: input.skillKeys }),
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    return toTurnView(run, result);
  }

  async release(runId: string): Promise<void> {
    await this.initialize();
    if ((this.pendingApprovalCounts.get(runId) ?? 0) > 0) this.cancelledRuns.add(runId);
    await this.options.runner.cancel(runId);
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;
    this.shuttingDown = true;
    await this.options.runner.shutdown();
    this.initialized = false;
  }

  /**
   * Holds one native app-server approval callback open while the exact durable
   * Harness approval is pending. The daemon derives capability, HEAD and hash;
   * Desktop only forwards the bounded native request identity/payload.
   */
  async handleServerRequest(
    context: CodexRuntimeRequestContext,
    request: JsonRpcServerRequest,
  ): Promise<unknown> {
    const run = await this.options.loadRun(context.runId);
    const workspace = await this.requireRunnable(run);
    if (run.workspace !== context.workspaceId || path.resolve(workspace.root) !== path.resolve(context.cwd)) {
      throw new Error("Codex server request scope no longer matches its Harness run");
    }
    if (!isNativeApprovalMethod(request.method)) {
      throw new Error(`SourceNerve P3 does not authorize app-server request ${request.method}`);
    }

    const resolution = await this.waitForNativeApproval(context.runId, request);
    if (resolution.decision === "allow") return approvedNativeResponse(request);
    return deniedNativeResponse(request);
  }

  private async waitForNativeApproval(
    runId: string,
    request: JsonRpcServerRequest,
  ): Promise<CodexNativeApprovalResolution> {
    if (!this.options.resolveApproval) {
      return deniedResolution("unavailable");
    }
    const input: CodexNativeApprovalResolveInput = {
      runId,
      requestId: nativeRequestId(request.id),
      method: request.method,
      payload: boundedNativePayload(request.params ?? {}),
    };
    const started = Date.now();
    this.pendingApprovalCounts.set(runId, (this.pendingApprovalCounts.get(runId) ?? 0) + 1);
    try {
      while (!this.shuttingDown && !this.cancelledRuns.has(runId)) {
        let resolution: CodexNativeApprovalResolution;
        try {
          resolution = await this.options.resolveApproval(input);
        } catch {
          return deniedResolution("resolver-error");
        }
        if (resolution.decision !== "pending") return resolution;
        if (Date.now() - started >= this.approvalWaitMs) return deniedResolution("timeout");
        await sleep(this.approvalPollMs);
      }
      return deniedResolution(this.shuttingDown ? "shutdown" : "cancelled");
    } finally {
      const remaining = (this.pendingApprovalCounts.get(runId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingApprovalCounts.delete(runId);
        this.cancelledRuns.delete(runId);
      } else {
        this.pendingApprovalCounts.set(runId, remaining);
      }
    }
  }

  private async requireRunnable(run: DesktopHarnessRunView): Promise<ManagedWorkspaceView> {
    if (run.status !== "running") throw new Error("Codex requires a running Harness run");
    if (run.freshnessState !== "current") throw new Error("Codex Harness run is stale and must be refreshed");
    if (run.closedLoop.recoveryStatus === "needed" || run.closedLoop.recoveryStatus === "in-progress") {
      throw new Error("Codex Harness run requires recovery before another turn");
    }
    if (run.pendingApprovals > 0) throw new Error("Codex Harness run has a pending approval");
    if (run.uncertainMutations > 0) throw new Error("Codex Harness run has an uncertain mutation");
    if (run.sandbox !== "workspace-write") {
      throw new Error("Codex P3 requires the Harness workspace-write sandbox");
    }
    if (run.policies.read !== "allow" || run.policies.write !== "allow" || run.policies.exec !== "allow") {
      throw new Error("Codex P3 requires Harness read, write and exec policies to be allowed");
    }
    return this.requireWorkspace(run.workspace, true);
  }

  private async requireWorkspace(workspaceId: string, writable: boolean): Promise<ManagedWorkspaceView> {
    if (!boundedId(workspaceId)) throw new Error("Codex workspace id is invalid");
    const workspace = (await this.options.listWorkspaces()).find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error("Codex workspace is no longer registered");
    if (workspace.validation.state !== "ready") throw new Error("Codex workspace is not ready");
    if (!path.isAbsolute(workspace.root)) throw new Error("Codex workspace root must be absolute");
    if (writable && (workspace.access !== "read-write" || !workspace.localWritable)) {
      throw new Error("Codex P3 requires a writable managed workspace");
    }
    return workspace;
  }
}

export function parseCodexNativeApprovalResolution(value: unknown): CodexNativeApprovalResolution {
  if (!isRecord(value)) throw new Error("SourceNerve native Codex approval response is invalid");
  const decision = value.decision;
  if (decision !== "pending" && decision !== "allow" && decision !== "deny") throw new Error("SourceNerve native Codex approval decision is invalid");
  if (!isRecord(value.approval)) throw new Error("SourceNerve native Codex approval record is invalid");
  const approvalId = boundedMetadata(value.approval.id, "SourceNerve native Codex approval id", 128);
  const status = value.approval.status;
  if (status !== "pending" && status !== "allowed" && status !== "denied" && status !== "consumed" && status !== "expired") {
    throw new Error("SourceNerve native Codex approval status is invalid");
  }
  if (typeof value.created !== "boolean") throw new Error("SourceNerve native Codex approval created flag is invalid");
  if (decision === "pending" && status !== "pending") throw new Error("SourceNerve native Codex pending approval state is inconsistent");
  if (decision === "allow" && status !== "consumed") throw new Error("SourceNerve native Codex allowed approval must already be consumed");
  if (decision === "deny" && status !== "denied" && status !== "expired" && status !== "consumed") {
    throw new Error("SourceNerve native Codex denied approval state is inconsistent");
  }
  if (value.created && decision !== "pending") throw new Error("SourceNerve native Codex created approval state is inconsistent");
  return { decision, approvalId, status, created: value.created };
}

function isNativeApprovalMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval";
}

function nativeRequestId(id: string | number): string {
  if (typeof id === "number") {
    if (!Number.isSafeInteger(id)) throw new Error("Codex native approval request id is invalid");
    return `n:${id}`;
  }
  return `s:${boundedMetadata(id, "Codex native approval request id", 120)}`;
}

function boundedNativePayload(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    throw new Error("Codex native approval payload exceeds 64 KiB");
  }
  if (/\\u0000/i.test(serialized)) throw new Error("Codex native approval payload contains invalid control data");
  return JSON.parse(serialized) as unknown;
}

function approvedNativeResponse(request: JsonRpcServerRequest): unknown {
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    return { decision: "accept" };
  }
  const permissions = isRecord(request.params) && isRecord(request.params.permissions)
    ? JSON.parse(JSON.stringify(request.params.permissions)) as Record<string, unknown>
    : {};
  return { permissions, scope: "turn", strictAutoReview: true };
}

function deniedNativeResponse(request: JsonRpcServerRequest): unknown {
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: true };
  }
  return { decision: "decline" };
}

function deniedResolution(reason: string): CodexNativeApprovalResolution {
  return { decision: "deny", approvalId: `local-${reason}`, status: "denied", created: false };
}

function boundedDuration(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTurnInput(input: CodexHarnessTurnInput): void {
  if (!boundedId(input.runId)) throw new Error("Codex Harness run id is invalid");
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) throw new Error("Codex prompt must not be empty");
  if (Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Codex prompt exceeds the P3 size limit");
  if ((input.skillKeys?.length ?? 0) > MAX_ACTIVE_SKILLS) throw new Error(`Codex P3 supports at most ${MAX_ACTIVE_SKILLS} active skills`);
  for (const key of input.skillKeys ?? []) {
    if (!/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}$/.test(key)) throw new Error("Codex skill key is invalid");
  }
}

function sanitizeAccount(response: CodexAccountReadResponse): CodexHarnessAccountView {
  const account = response.account;
  return {
    authenticated: account !== null,
    accountType: account?.type ?? null,
    ...(account?.type === "chatgpt" ? { planType: boundedMetadata(account.planType, "Codex plan type", 128) } : {}),
    requiresOpenaiAuth: response.requiresOpenaiAuth,
  };
}

function toTurnView(run: DesktopHarnessRunView, result: CodexThinRunnerResult): CodexHarnessTurnView {
  return {
    runId: run.id,
    workspace: run.workspace,
    threadId: boundedMetadata(result.threadId, "Codex thread id", 128),
    turnId: boundedMetadata(result.turnId, "Codex turn id", 128),
    status: result.status,
    ...(result.response === undefined ? {} : { response: boundedResponse(result.response) }),
    resumed: result.resumed,
    recoveredBeforeTurn: result.recoveredBeforeTurn,
    activeSkills: result.skillActivation?.skills.map((skill) => skill.key) ?? [],
  };
}

function boundedResponse(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Codex response exceeds the P3 size limit");
  if (/\0/.test(value)) throw new Error("Codex response contains invalid control data");
  return value;
}

function boundedMetadata(value: string, label: string, maxLength: number): string {
  if (value.length < 1 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
