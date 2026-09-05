import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";

import { CodexJsonRpcConnection } from "./codex-jsonrpc";
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
const MAX_SKILL_ROOTS = 8;
const MAX_ACTIVE_SKILLS = 2;

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

export interface CodexAppServerHostOptions {
  command?: string;
  clientVersion?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: CodexSpawnProcess;
  onEvent?: (event: CodexServerEvent) => void;
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
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: CodexJsonRpcConnection | null = null;
  private initializeResponse: CodexInitializeResponse | null = null;
  private thread: AttachedThread | null = null;
  private intentionalShutdown = false;
  private stderrTail = "";
  private desiredSkillConfig: DesiredSkillConfig | null = null;
  private skillConfigApplied = false;
  private lastSkills: CodexSkillsListResponse | null = null;
  private readonly completedTurns = new Map<string, CodexTurn>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly turnUsage = new Map<string, CodexThreadTokenUsage>();
  private readonly completedAgentMessages = new Map<string, string>();
  private readonly streamedAgentMessages = new Map<string, string>();
  private activeTurnId: string | null = null;

  constructor(options: CodexAppServerHostOptions = {}) {
    this.command = options.command ?? DEFAULT_CODEX_COMMAND;
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.env = { ...process.env, ...options.env };
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, { ...spawnOptions, stdio: "pipe" }));
    this.onEvent = options.onEvent;
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
    return parseCodexAccountReadResponse(await this.requireRpc().request("account/read", { refreshToken: false }));
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
    const turnId = response.turn.id;
    this.activeTurnId = turnId;

    try {
      const turn = response.turn.status === "inProgress"
        ? await this.waitForTurn(turnId)
        : response.turn;
      const responseText = this.completedAgentMessages.get(turnId)
        ?? finalAgentMessage(turn)
        ?? this.streamedAgentMessages.get(turnId);
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
      this.completedAgentMessages.delete(turnId);
      this.streamedAgentMessages.delete(turnId);
    }
  }

  async recover(): Promise<boolean> {
    if (!this.thread) return false;
    return this.ensureAttachedThreadReady();
  }

  async shutdown(): Promise<void> {
    this.intentionalShutdown = true;
    const child = this.child;
    this.rpc?.close("Codex app-server host shut down");
    this.rpc = null;
    this.child = null;
    this.initializeResponse = null;
    this.desiredSkillConfig = null;
    this.skillConfigApplied = false;
    this.lastSkills = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
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
      this.streamedAgentMessages.set(event.turnId, `${this.streamedAgentMessages.get(event.turnId) ?? ""}${event.delta}`);
      return;
    }
    if (event.type === "agent-message-completed") {
      if (event.threadId !== this.thread?.id) return;
      this.completedAgentMessages.set(event.turnId, event.text);
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

  private requireRpc(): CodexJsonRpcConnection {
    if (!this.rpc) throw new Error("Codex app-server is not initialized");
    return this.rpc;
  }
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

function skillConfigEquals(left: DesiredSkillConfig | null, right: DesiredSkillConfig): boolean {
  return left?.cwd === right.cwd
    && left.extraRoots.length === right.extraRoots.length
    && left.extraRoots.every((root, index) => root === right.extraRoots[index]);
}
