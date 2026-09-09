import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { CodexJsonRpcConnection, type JsonRpcServerRequest } from "./codex-jsonrpc";
import { isCodexHarnessInternalRecoveryPrompt } from "./codex-harness-supervision";
import {
  codexSkillInput,
  codexTextInput,
  finalAgentMessage,
  parseCodexAccountReadResponse,
  parseCodexInitializeResponse,
  parseCodexServerEvent,
  parseCodexSkillsListResponse,
  parseCodexThreadStartResponse,
  parseCodexTurnStartResponse,
  type CodexAccountReadResponse,
  type CodexApprovalPolicy,
  type CodexInitializeResponse,
  type CodexSandboxMode,
  type CodexServerEvent,
  type CodexSkillInvocation,
  type CodexSkillsListResponse,
  type CodexThreadStartResponse,
  type CodexThreadTokenUsage,
  type CodexTurn,
} from "./codex-protocol";

const DEFAULT_CODEX_COMMAND = "codex";
const MAX_STDERR_BYTES = 8 * 1024;
const SHUTDOWN_TERM_TIMEOUT_MS = 2_000;
const SHUTDOWN_KILL_TIMEOUT_MS = 1_000;
const MAX_SKILL_ROOTS = 8;
const MAX_ACTIVE_SKILLS = 2;
const MAX_NATIVE_THREADS = 2_000;
const MAX_NATIVE_TURNS = 2_000;
const MAX_NATIVE_MESSAGES = 4_000;

export interface CodexThreadOptions {
  cwd: string;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  model?: string;
  modelProvider?: string;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: CodexTurn["status"];
  response?: string;
  tokenUsage?: CodexThreadTokenUsage;
  recoveredBeforeTurn: boolean;
}

export interface CodexNativeThreadSummary {
  threadId: string;
  cwd: string;
  name: string | null;
  preview: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
}

export interface CodexNativeConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  turnId: string;
}

export interface CodexNativeRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexNativeRateLimitBucket {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: CodexNativeRateLimitWindow | null;
  secondary: CodexNativeRateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
}

export interface CodexNativeRateLimits {
  buckets: CodexNativeRateLimitBucket[];
  resetCreditsAvailable: number | null;
}

export interface CodexNativeUsageGroup {
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  netNewInputTokens: number | null;
  outputTokens: number | null;
  estimatedUsageCreditsMicros: number;
}

export interface CodexNativeAccountUsage {
  summary: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    longestRunningTurnSec: number | null;
  };
  threadUsage: {
    threadId: string;
    estimatedUsageCreditsMicros: number;
    estimatedUsageUsdMicros: number | null;
    groups: CodexNativeUsageGroup[];
  } | null;
}

export interface CodexAppServerHostOptions {
  command?: string;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: CodexSpawnProcess;
  onEvent?: (event: CodexServerEvent) => void;
  onServerRequest?: (request: JsonRpcServerRequest) => Promise<unknown> | unknown;
}

export type CodexSpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface AttachedThread {
  id: string;
  options: Required<Pick<CodexThreadOptions, "cwd" | "sandbox" | "approvalPolicy">> & Pick<CodexThreadOptions, "model" | "modelProvider">;
}

interface DesiredSkillConfig {
  extraRoots: string[];
  cwd: string;
}

interface TurnWaiter {
  resolve(turn: CodexTurn): void;
  reject(error: Error): void;
}

export class CodexAppServerCrashError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerCrashError";
  }
}

/**
 * Thin native host for the official `codex app-server --stdio` protocol.
 *
 * Codex remains the owner of model reasoning, built-in tools, thread history,
 * compaction, authentication and skill interpretation. SourceNerve only owns
 * process lifecycle, exact skill-root projection and the run-to-thread binding.
 */
export class CodexAppServerHost {
  private readonly command: string;
  private readonly clientVersion: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnProcess: CodexSpawnProcess;
  private readonly onEvent?: (event: CodexServerEvent) => void;
  private readonly onServerRequest?: CodexAppServerHostOptions["onServerRequest"];
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: CodexJsonRpcConnection | null = null;
  private initializeResponse: CodexInitializeResponse | null = null;
  private thread: AttachedThread | null = null;
  private intentionalShutdown = false;
  private disposed = false;
  private stderrTail = "";
  private desiredSkillConfig: DesiredSkillConfig | null = null;
  private skillConfigApplied = false;
  private lastSkills: CodexSkillsListResponse | null = null;
  private readonly completedTurns = new Map<string, CodexTurn>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnUsage = new Map<string, CodexThreadTokenUsage>();
  private readonly agentMessageItems = new Map<string, Map<string, string>>();
  private activeTurnId: string | null = null;

  constructor(options: CodexAppServerHostOptions = {}) {
    this.command = options.command ?? DEFAULT_CODEX_COMMAND;
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.env = { ...process.env, ...options.env };
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, { ...spawnOptions, stdio: "pipe" }));
    this.onEvent = options.onEvent;
    this.onServerRequest = options.onServerRequest;
  }

  attachedThreadId(): string | null {
    return this.thread?.id ?? null;
  }

  initialization(): CodexInitializeResponse | null {
    return this.initializeResponse ? { ...this.initializeResponse } : null;
  }

  diagnostics(): { running: boolean; threadId: string | null; stderrTail: string } {
    return {
      running: this.child !== null && this.child.exitCode === null && this.child.signalCode === null,
      threadId: this.thread?.id ?? null,
      stderrTail: this.stderrTail,
    };
  }

  async account(): Promise<CodexAccountReadResponse> {
    await this.ensureProcess();
    const response = parseCodexAccountReadResponse(await this.requireRpc().request("account/read", { refreshToken: false }));
    this.assertNotDisposed();
    return response;
  }

  async startThread(options: CodexThreadOptions): Promise<CodexThreadStartResponse> {
    if (this.thread) throw new Error("Codex app-server host already owns a thread");
    const normalized = normalizeThreadOptions(options);
    await this.ensureProcess();
    const response = parseCodexThreadStartResponse(await this.requireRpc().request("thread/start", {
      cwd: normalized.cwd,
      approvalPolicy: normalized.approvalPolicy,
      sandbox: normalized.sandbox,
      ephemeral: false,
      serviceName: "sourcenerve-desktop",
      threadSource: "sourcenerve-desktop",
      sessionStartSource: "startup",
      ...(normalized.model ? { model: normalized.model } : {}),
      ...(normalized.modelProvider ? { modelProvider: normalized.modelProvider } : {}),
    }));
    this.assertNotDisposed();
    this.thread = { id: response.thread.id, options: normalized };
    return response;
  }

  async resumeThread(threadId: string, options: CodexThreadOptions): Promise<CodexThreadStartResponse> {
    if (!threadId) throw new Error("Codex thread id is required");
    if (this.thread && this.thread.id !== threadId) throw new Error("Codex app-server host cannot switch threads");
    const normalized = normalizeThreadOptions(options);
    await this.ensureProcess();
    const response = parseCodexThreadStartResponse(await this.requireRpc().request("thread/resume", {
      threadId,
      cwd: normalized.cwd,
      approvalPolicy: normalized.approvalPolicy,
      sandbox: normalized.sandbox,
      excludeTurns: true,
      ...(normalized.model ? { model: normalized.model } : {}),
      ...(normalized.modelProvider ? { modelProvider: normalized.modelProvider } : {}),
    }));
    this.assertNotDisposed();
    if (response.thread.id !== threadId) throw new Error("Codex resumed a different thread than requested");
    this.thread = { id: threadId, options: normalized };
    return response;
  }

  async configureSkills(extraRoots: readonly string[], cwd: string): Promise<CodexSkillsListResponse> {
    const next: DesiredSkillConfig = {
      extraRoots: normalizeSkillRoots(extraRoots),
      cwd: normalizeAbsolutePath(cwd, "Codex skills cwd"),
    };
    await this.ensureProcess();
    if (!skillConfigEquals(this.desiredSkillConfig, next)) this.skillConfigApplied = false;
    this.desiredSkillConfig = next;
    return this.applyDesiredSkills(true);
  }

  async listThreads(cwd: string, limit = 100): Promise<CodexNativeThreadSummary[]> {
    const workspaceRoot = await canonicalNativePath(normalizeAbsolutePath(cwd, "Codex thread list cwd"));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NATIVE_THREADS) throw new Error("Codex thread list limit is invalid");
    await this.ensureProcess();
    const threads: CodexNativeThreadSummary[] = [];
    let cursor: string | null = null;
    let scanned = 0;
    while (threads.length < limit && scanned < MAX_NATIVE_THREADS) {
      const response = record(await this.requireRpc().request("thread/list", {
        limit: Math.min(100, MAX_NATIVE_THREADS - scanned),
        ...(cursor ? { cursor } : {}),
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      }));
      const data = Array.isArray(response.data) ? response.data : [];
      scanned += data.length;
      for (const value of data) {
        const parsed = parseNativeThreadSummary(value);
        if (parsed.parentThreadId !== null) continue;
        if (!await workspaceContainsNativePath(workspaceRoot, parsed.summary.cwd)) continue;
        threads.push(parsed.summary);
        if (threads.length >= limit) break;
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
      if (!cursor || data.length === 0) break;
    }
    return threads;
  }

  async readConversationHistory(threadId: string): Promise<CodexNativeConversationMessage[]> {
    validateNativeId(threadId, "Codex thread id");
    await this.ensureProcess();
    const rpc = this.requireRpc();
    const metadataResponse = record(await rpc.request("thread/read", { threadId, includeTurns: false }));
    const metadata = recordOrNull(metadataResponse.thread) ?? metadataResponse;
    const fallbackTimestamp = unixSecondsToIso(metadata.updatedAt) ?? unixSecondsToIso(metadata.createdAt) ?? new Date().toISOString();
    const messages: CodexNativeConversationMessage[] = [];
    let cursor: string | null = null;
    let loadedTurns = 0;

    while (loadedTurns < MAX_NATIVE_TURNS) {
      const response = record(await rpc.request("thread/turns/list", {
        threadId,
        limit: Math.min(100, MAX_NATIVE_TURNS - loadedTurns),
        ...(cursor ? { cursor } : {}),
        sortDirection: "asc",
        itemsView: "full",
      }));
      const turns = Array.isArray(response.data) ? response.data : [];
      loadedTurns += turns.length;
      for (const turnValue of turns) {
        const turn = record(turnValue);
        const turnId = requiredString(turn.id, "Codex turn id");
        const createdAt = unixSecondsToIso(turn.startedAt) ?? unixSecondsToIso(turn.completedAt) ?? fallbackTimestamp;
        const items = Array.isArray(turn.items) ? turn.items : [];
        const harnessRecoveryTurn = items.some((itemValue) => {
          const item = recordOrNull(itemValue);
          return item?.type === "userMessage" && isCodexHarnessInternalRecoveryPrompt(userMessageText(item.content));
        });
        const assistantParts: string[] = [];
        for (const itemValue of items) {
          const item = recordOrNull(itemValue);
          if (!item) continue;
          const id = typeof item.id === "string" && item.id ? item.id : `${turnId}:${messages.length}`;
          if (item.type === "userMessage") {
            const text = userMessageText(item.content);
            if (text && !harnessRecoveryTurn) messages.push({ id, role: "user", text, createdAt, turnId });
          } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
            assistantParts.push(item.text);
          }
          if (messages.length >= MAX_NATIVE_MESSAGES) throw new Error("Codex conversation history exceeds the Desktop message limit");
        }
        if (assistantParts.length > 0) {
          messages.push({
            id: `assistant:${turnId}`,
            role: "assistant",
            text: boundedNativeText(assistantParts.join("\n\n")),
            createdAt,
            turnId,
          });
        }
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
      if (!cursor) break;
    }
    if (cursor) throw new Error("Codex conversation history exceeds the Desktop turn limit");
    const activeTurnId = this.thread?.id === threadId ? this.activeTurnId : null;
    const activeText = activeTurnId ? this.turnAgentMessageText(activeTurnId) : undefined;
    if (activeTurnId && activeText?.trim()) {
      const id = `assistant:${activeTurnId}`;
      const existingIndex = messages.findIndex((message) => message.id === id);
      const activeMessage: CodexNativeConversationMessage = {
        id,
        role: "assistant",
        text: boundedNativeText(activeText),
        createdAt: existingIndex >= 0 ? messages[existingIndex].createdAt : new Date().toISOString(),
        turnId: activeTurnId,
      };
      if (existingIndex >= 0) messages[existingIndex] = activeMessage;
      else messages.push(activeMessage);
    }
    return messages;
  }

  async deleteThread(threadId: string): Promise<void> {
    validateNativeId(threadId, "Codex thread id");
    await this.ensureProcess();
    await this.requireRpc().request("thread/delete", { threadId });
  }

  async readRateLimits(): Promise<CodexNativeRateLimits> {
    await this.ensureProcess();
    return parseNativeRateLimits(await this.requireRpc().request("account/rateLimits/read", null));
  }

  async readAccountUsage(threadId?: string): Promise<CodexNativeAccountUsage> {
    if (threadId !== undefined) validateNativeId(threadId, "Codex thread id");
    await this.ensureProcess();
    return parseNativeAccountUsage(await this.requireRpc().request("account/usage/read", threadId ? { threadId } : null));
  }

  async runTurn(prompt: string, skills: readonly CodexSkillInvocation[] = []): Promise<CodexTurnResult> {
    if (!this.thread) throw new Error("Codex thread is not attached");
    if (this.activeTurnId) throw new Error("Codex app-server host already has an active turn");
    if (skills.length > MAX_ACTIVE_SKILLS) throw new Error(`Codex P2 supports at most ${MAX_ACTIVE_SKILLS} active skills`);

    const recoveredBeforeTurn = await this.ensureAttachedThreadReady();
    if (this.desiredSkillConfig && !this.skillConfigApplied) await this.applyDesiredSkills(true);
    const response = parseCodexTurnStartResponse(await this.requireRpc().request("turn/start", {
      threadId: this.thread.id,
      input: [
        ...skills.map((skill) => codexSkillInput({
          name: skill.name,
          path: normalizeAbsolutePath(skill.path, "Codex skill invocation path"),
        })),
        codexTextInput(prompt),
      ],
    }));
    this.assertNotDisposed();
    const turnId = response.turn.id;
    this.activeTurnId = turnId;

    try {
      const turn = response.turn.status === "inProgress"
        ? await this.waitForTurn(turnId)
        : response.turn;
      const responseText = this.turnAgentMessageText(turnId)
        ?? finalAgentMessage(turn);
      const tokenUsage = this.turnUsage.get(turnId);
      if (turn.status === "failed") {
        const detail = turn.error?.message ?? "Codex turn failed";
        throw new Error(detail);
      }
      return {
        threadId: this.thread.id,
        turnId,
        status: turn.status,
        ...(responseText === undefined ? {} : { response: responseText }),
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
        recoveredBeforeTurn,
      };
    } finally {
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      this.completedTurns.delete(turnId);
      this.turnUsage.delete(turnId);
      this.agentMessageItems.delete(turnId);
    }
  }

  async recover(): Promise<boolean> {
    if (!this.thread) return false;
    return this.ensureAttachedThreadReady();
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    this.intentionalShutdown = true;
    this.rejectActiveTurn(new Error("Codex app-server host shut down"));
    const child = this.child;
    this.rpc?.close("Codex app-server host shut down");
    this.rpc = null;
    this.child = null;
    this.initializeResponse = null;
    this.desiredSkillConfig = null;
    this.skillConfigApplied = false;
    this.lastSkills = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await terminateChildProcess(child);
  }

  private async ensureAttachedThreadReady(): Promise<boolean> {
    if (!this.thread) throw new Error("Codex thread is not attached");
    if (this.rpc && this.child && this.child.exitCode === null && this.child.signalCode === null) return false;
    const attached = this.thread;
    await this.ensureProcess();
    const response = parseCodexThreadStartResponse(await this.requireRpc().request("thread/resume", {
      threadId: attached.id,
      cwd: attached.options.cwd,
      approvalPolicy: attached.options.approvalPolicy,
      sandbox: attached.options.sandbox,
      excludeTurns: true,
      ...(attached.options.model ? { model: attached.options.model } : {}),
      ...(attached.options.modelProvider ? { modelProvider: attached.options.modelProvider } : {}),
    }));
    if (response.thread.id !== attached.id) throw new Error("Codex recovery resumed a different thread");
    return true;
  }

  private async ensureProcess(): Promise<void> {
    this.assertNotDisposed();
    if (this.rpc && this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    this.intentionalShutdown = false;
    const child = this.spawnProcess(this.command, ["app-server", "--stdio"], {
      cwd: this.thread?.options.cwd ?? process.cwd(),
      env: this.env,
      windowsHide: true,
    });
    this.child = child;
    this.stderrTail = "";
    this.skillConfigApplied = false;
    this.lastSkills = null;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const next = `${this.stderrTail}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`;
      const bytes = Buffer.from(next, "utf8");
      this.stderrTail = bytes.subarray(Math.max(0, bytes.length - MAX_STDERR_BYTES)).toString("utf8");
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
    child.once("error", (error) => this.handleProcessError(child, error));

    const rpc = new CodexJsonRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
      onNotification: (method, params) => this.handleNotification(method, params),
      ...(this.onServerRequest ? { onServerRequest: this.onServerRequest } : {}),
    });
    this.rpc = rpc;
    try {
      this.initializeResponse = parseCodexInitializeResponse(await rpc.request("initialize", {
        clientInfo: { name: "sourcenerve-desktop", title: "SourceNerve Desktop", version: this.clientVersion },
        capabilities: { experimentalApi: false },
      }));
      rpc.notify("initialized");
      if (this.desiredSkillConfig) await this.applyDesiredSkills(true);
    } catch (error) {
      rpc.close("Codex app-server initialization failed");
      if (this.child === child) this.child = null;
      if (this.rpc === rpc) this.rpc = null;
      child.kill("SIGTERM");
      throw error;
    }
  }

  private async applyDesiredSkills(forceReload: boolean): Promise<CodexSkillsListResponse> {
    if (!this.desiredSkillConfig) {
      return this.lastSkills ?? { data: [] };
    }
    const rpc = this.requireRpc();
    if (!this.skillConfigApplied) {
      await rpc.request("skills/extraRoots/set", { extraRoots: this.desiredSkillConfig.extraRoots });
      this.skillConfigApplied = true;
    }
    const listed = parseCodexSkillsListResponse(await rpc.request("skills/list", {
      cwds: [this.desiredSkillConfig.cwd],
      forceReload,
    }));
    this.lastSkills = listed;
    return listed;
  }

  private handleNotification(method: string, params: unknown): void {
    let event: CodexServerEvent;
    try {
      event = parseCodexServerEvent(method, params);
    } catch (error) {
      this.rejectActiveTurn(error instanceof Error ? error : new Error("Invalid Codex app-server notification"));
      return;
    }
    this.onEvent?.(event);
    if (event.type === "agent-message-delta") {
      if (event.threadId !== this.thread?.id) return;
      this.updateAgentMessageItem(event.turnId, event.itemId, event.delta, true);
      return;
    }
    if (event.type === "agent-message-completed") {
      if (event.threadId !== this.thread?.id) return;
      this.updateAgentMessageItem(event.turnId, event.itemId, event.text, false);
      return;
    }
    if (event.type === "token-usage") {
      if (event.threadId !== this.thread?.id) return;
      this.turnUsage.set(event.turnId, event.tokenUsage);
      return;
    }
    if (event.type === "turn-completed") {
      if (event.threadId !== this.thread?.id) return;
      const waiter = this.turnWaiters.get(event.turn.id);
      if (waiter) {
        this.turnWaiters.delete(event.turn.id);
        waiter.resolve(event.turn);
      } else {
        this.completedTurns.set(event.turn.id, event.turn);
      }
    }
  }


  private updateAgentMessageItem(turnId: string, itemId: string, text: string, append: boolean): void {
    let items = this.agentMessageItems.get(turnId);
    if (!items) {
      items = new Map<string, string>();
      this.agentMessageItems.set(turnId, items);
    }
    items.set(itemId, append ? `${items.get(itemId) ?? ""}${text}` : text);
  }

  private turnAgentMessageText(turnId: string): string | undefined {
    const items = this.agentMessageItems.get(turnId);
    if (!items) return undefined;
    const parts = [...items.values()].filter((text) => text.trim().length > 0);
    return parts.length > 0 ? boundedNativeText(parts.join("\n\n")) : undefined;
  }

  private waitForTurn(turnId: string): Promise<CodexTurn> {
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise<CodexTurn>((resolve, reject) => {
      this.turnWaiters.set(turnId, { resolve, reject });
    });
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    this.rpc?.close("Codex app-server process exited");
    this.rpc = null;
    this.initializeResponse = null;
    this.skillConfigApplied = false;
    this.lastSkills = null;
    if (this.intentionalShutdown) return;
    const suffix = signal ? ` signal=${signal}` : code === null ? "" : ` code=${code}`;
    this.rejectActiveTurn(new CodexAppServerCrashError(`Codex app-server exited unexpectedly${suffix}`));
  }

  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.rpc?.close(error.message);
    this.rpc = null;
    this.initializeResponse = null;
    this.skillConfigApplied = false;
    this.lastSkills = null;
    this.rejectActiveTurn(new CodexAppServerCrashError(`Codex app-server process error: ${error.message}`));
  }

  private rejectActiveTurn(error: Error): void {
    if (!this.activeTurnId) return;
    const waiter = this.turnWaiters.get(this.activeTurnId);
    if (waiter) {
      this.turnWaiters.delete(this.activeTurnId);
      waiter.reject(error);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Codex app-server host is shut down");
  }

  private requireRpc(): CodexJsonRpcConnection {
    if (!this.rpc) throw new Error("Codex app-server is not initialized");
    return this.rpc;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex app-server response is invalid");
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateNativeId(value: unknown, label: string): asserts value is string {
  const text = requiredString(value, label);
  if (text.length > 256) throw new Error(`${label} is invalid`);
}

function parseNativeThreadSummary(value: unknown): { summary: CodexNativeThreadSummary; parentThreadId: string | null } {
  const thread = record(value);
  const threadId = requiredString(thread.id, "Codex thread id");
  const cwd = requiredString(thread.cwd, "Codex thread cwd");
  if (!path.isAbsolute(cwd)) throw new Error("Codex thread cwd is invalid");
  const statusRecord = recordOrNull(thread.status);
  return {
    parentThreadId: typeof thread.parentThreadId === "string" && thread.parentThreadId ? thread.parentThreadId : null,
    summary: {
      threadId,
      cwd: path.resolve(cwd),
      name: typeof thread.name === "string" && thread.name.trim() ? boundedNativeText(thread.name, 240) : null,
      preview: typeof thread.preview === "string" ? boundedNativeText(thread.preview, 600) : "",
      model: typeof thread.model === "string" && thread.model ? boundedNativeText(thread.model, 120) : null,
      createdAt: unixSecondsToIso(thread.createdAt) ?? new Date(0).toISOString(),
      updatedAt: unixSecondsToIso(thread.updatedAt) ?? unixSecondsToIso(thread.createdAt) ?? new Date(0).toISOString(),
      status: typeof statusRecord?.type === "string" ? boundedNativeText(statusRecord.type, 80) : "unknown",
    },
  };
}

function parseNativeRateLimits(value: unknown): CodexNativeRateLimits {
  const response = record(value);
  const buckets: CodexNativeRateLimitBucket[] = [];
  const byId = recordOrNull(response.rateLimitsByLimitId);
  if (byId) {
    for (const bucketValue of Object.values(byId)) buckets.push(parseNativeRateLimitBucket(bucketValue));
  }
  if (buckets.length === 0 && response.rateLimits !== undefined) buckets.push(parseNativeRateLimitBucket(response.rateLimits));
  const resetCredits = recordOrNull(response.rateLimitResetCredits);
  return {
    buckets,
    resetCreditsAvailable: nullableSafeInteger(resetCredits?.availableCount),
  };
}

function parseNativeRateLimitBucket(value: unknown): CodexNativeRateLimitBucket {
  const bucket = record(value);
  return {
    limitId: nullableText(bucket.limitId, 120),
    limitName: nullableText(bucket.limitName, 160),
    planType: nullableText(bucket.planType, 120),
    primary: parseNativeRateLimitWindow(bucket.primary),
    secondary: parseNativeRateLimitWindow(bucket.secondary),
    credits: parseNativeCredits(bucket.credits),
  };
}

function parseNativeRateLimitWindow(value: unknown): CodexNativeRateLimitWindow | null {
  const window = recordOrNull(value);
  if (!window) return null;
  const usedPercent = safeInteger(window.usedPercent, "Codex rate limit usedPercent");
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowDurationMins: nullableSafeInteger(window.windowDurationMins),
    resetsAt: nullableSafeInteger(window.resetsAt),
  };
}

function parseNativeCredits(value: unknown): CodexNativeRateLimitBucket["credits"] {
  const credits = recordOrNull(value);
  if (!credits) return null;
  if (typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean") return null;
  return {
    hasCredits: credits.hasCredits,
    unlimited: credits.unlimited,
    balance: nullableText(credits.balance, 120),
  };
}

function parseNativeAccountUsage(value: unknown): CodexNativeAccountUsage {
  const response = record(value);
  const summary = record(response.summary);
  const thread = recordOrNull(response.threadUsage);
  return {
    summary: {
      lifetimeTokens: nullableSafeInteger(summary.lifetimeTokens),
      peakDailyTokens: nullableSafeInteger(summary.peakDailyTokens),
      currentStreakDays: nullableSafeInteger(summary.currentStreakDays),
      longestStreakDays: nullableSafeInteger(summary.longestStreakDays),
      longestRunningTurnSec: nullableSafeInteger(summary.longestRunningTurnSec),
    },
    threadUsage: thread ? {
      threadId: requiredString(thread.threadId, "Codex usage thread id"),
      estimatedUsageCreditsMicros: safeInteger(thread.estimatedUsageCreditsMicros, "Codex estimated usage credits"),
      estimatedUsageUsdMicros: nullableSafeInteger(thread.estimatedUsageUsdMicros),
      groups: Array.isArray(thread.groups) ? thread.groups.map(parseNativeUsageGroup) : [],
    } : null,
  };
}

function parseNativeUsageGroup(value: unknown): CodexNativeUsageGroup {
  const group = record(value);
  return {
    model: nullableText(group.model, 120),
    reasoningEffort: nullableText(group.reasoningEffort, 80),
    speed: nullableText(group.speed, 80),
    totalTokens: nullableSafeInteger(group.totalTokens),
    inputTokens: nullableSafeInteger(group.inputTokens),
    cachedInputTokens: nullableSafeInteger(group.cachedInputTokens),
    netNewInputTokens: nullableSafeInteger(group.netNewInputTokens),
    outputTokens: nullableSafeInteger(group.outputTokens),
    estimatedUsageCreditsMicros: safeInteger(group.estimatedUsageCreditsMicros, "Codex usage group credits"),
  };
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function nullableSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nullableText(value: unknown, maxChars: number): string | null {
  return typeof value === "string" && value.trim() ? boundedNativeText(value.trim(), maxChars) : null;
}

function userMessageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const inputValue of value) {
    const input = recordOrNull(inputValue);
    if (!input) continue;
    if (input.type === "text" && typeof input.text === "string" && input.text.trim()) parts.push(input.text);
    else if (input.type === "mention" && typeof input.name === "string") parts.push(`@${input.name}`);
  }
  return boundedNativeText(parts.join("\n").trim());
}

function boundedNativeText(value: string, maxChars = 256 * 1024): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function terminateChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    if (settled) return;
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (settled) return;
      giveUpTimer = setTimeout(finish, SHUTDOWN_KILL_TIMEOUT_MS);
    }, SHUTDOWN_TERM_TIMEOUT_MS);
  });
}

function normalizeThreadOptions(options: CodexThreadOptions): AttachedThread["options"] {
  if (!path.isAbsolute(options.cwd)) throw new Error("Codex workspace cwd must be absolute");
  return {
    cwd: path.resolve(options.cwd),
    sandbox: options.sandbox ?? "workspace-write",
    approvalPolicy: options.approvalPolicy ?? "never",
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
  };
}

function normalizeSkillRoots(roots: readonly string[]): string[] {
  if (roots.length > MAX_SKILL_ROOTS) throw new Error(`Codex supports at most ${MAX_SKILL_ROOTS} projected skill roots`);
  return [...new Set(roots.map((root) => normalizeAbsolutePath(root, "Codex skill root")))].sort();
}

function normalizeAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}

async function canonicalNativePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function workspaceContainsNativePath(workspaceRoot: string, candidate: string): Promise<boolean> {
  const canonicalCandidate = await canonicalNativePath(candidate);
  const relative = path.relative(workspaceRoot, canonicalCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function skillConfigEquals(left: DesiredSkillConfig | null, right: DesiredSkillConfig): boolean {
  return left?.cwd === right.cwd
    && left.extraRoots.length === right.extraRoots.length
    && left.extraRoots.every((root, index) => root === right.extraRoots[index]);
}
