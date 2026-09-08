import path from "node:path";

import {
  CodexAppServerHost,
  type CodexAppServerHostOptions,
  type CodexNativeAccountUsage,
  type CodexNativeConversationMessage,
  type CodexNativeRateLimits,
  type CodexNativeThreadSummary,
  type CodexThreadOptions,
  type CodexTurnResult,
} from "./codex-app-server-host";
import type { JsonRpcServerRequest } from "./codex-jsonrpc";
import type {
  CodexAccountReadResponse,
  CodexSkillInvocation,
  CodexSkillsListResponse,
} from "./codex-protocol";
import { CodexThreadStore, type CodexThreadBinding } from "./codex-thread-store";

const DEFAULT_MAX_RUNTIMES = 4;
const MAX_ACTIVE_SKILLS = 2;
const ACTIVE_WRITER_RETRY_DELAY_MS = 250;

export interface CodexRuntimePoolOptions {
  store: CodexThreadStore;
  clientVersion?: string;
  maxRuntimes?: number;
  hostFactory?: (options: CodexAppServerHostOptions) => CodexRuntimeHost;
  serverRequestHandler?: (context: CodexRuntimeRequestContext, request: JsonRpcServerRequest) => Promise<unknown> | unknown;
}

export interface CodexRuntimeRequestContext {
  runId: string;
  workspaceId: string;
  cwd: string;
}

export interface CodexRuntimeTurnInput extends CodexThreadOptions {
  runId: string;
  workspaceId: string;
  prompt: string;
  skillRoots?: readonly string[];
  skills?: readonly CodexSkillInvocation[];
}

export interface CodexRuntimeTurnResult extends CodexTurnResult {
  binding: CodexThreadBinding;
  resumed: boolean;
}

export interface CodexRuntimeConversationSummary extends CodexNativeThreadSummary {
  runId?: string;
}

export interface CodexRuntimeConversationView {
  threadId: string | null;
  messages: CodexNativeConversationMessage[];
  busy: boolean;
  busyReason?: string;
}

export interface CodexRuntimeResumeInput extends CodexThreadOptions {
  runId: string;
  workspaceId: string;
  threadId: string;
}

export interface CodexRuntimeHost {
  attachedThreadId(): string | null;
  account(): Promise<CodexAccountReadResponse>;
  readRateLimits?(): Promise<CodexNativeRateLimits>;
  readAccountUsage?(threadId?: string): Promise<CodexNativeAccountUsage>;
  startThread(options: CodexThreadOptions): Promise<{ thread: { id: string } }>;
  resumeThread(threadId: string, options: CodexThreadOptions): Promise<{ thread: { id: string } }>;
  configureSkills(extraRoots: readonly string[], cwd: string): Promise<CodexSkillsListResponse>;
  listThreads(cwd: string, limit?: number): Promise<CodexNativeThreadSummary[]>;
  readConversationHistory(threadId: string): Promise<CodexNativeConversationMessage[]>;
  deleteThread(threadId: string): Promise<void>;
  runTurn(prompt: string, skills?: readonly CodexSkillInvocation[]): Promise<CodexTurnResult>;
  recover(): Promise<boolean>;
  shutdown(): Promise<void>;
}

interface RuntimeEntry {
  runId: string;
  workspaceId: string;
  cwd: string;
  host: CodexRuntimeHost;
  busy: boolean;
  lastUsed: number;
}

interface ThreadWriterState {
  runId: string;
  startedAt: number;
  done: Promise<void>;
  release: () => void;
}

/**
 * Bounded owner of native Codex app-server processes.
 * One Harness run maps to one Codex thread and at most one warm app-server.
 */
export class CodexRuntimePool {
  private readonly store: CodexThreadStore;
  private readonly clientVersion: string;
  private readonly maxRuntimes: number;
  private readonly hostFactory: NonNullable<CodexRuntimePoolOptions["hostFactory"]>;
  private readonly serverRequestHandler?: CodexRuntimePoolOptions["serverRequestHandler"];
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly activeThreadWriters = new Map<string, ThreadWriterState>();
  private initialized = false;
  private clock = 0;

  constructor(options: CodexRuntimePoolOptions) {
    this.store = options.store;
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.maxRuntimes = boundedInteger(options.maxRuntimes, DEFAULT_MAX_RUNTIMES, 1, 16);
    this.hostFactory = options.hostFactory ?? ((hostOptions) => new CodexAppServerHost(hostOptions));
    this.serverRequestHandler = options.serverRequestHandler;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    this.initialized = true;
  }

  async account(input: { cwd: string }): Promise<CodexAccountReadResponse> {
    this.assertInitialized();
    if (!path.isAbsolute(input.cwd)) throw new Error("Codex account probe cwd must be absolute");
    const host = this.hostFactory({ clientVersion: this.clientVersion });
    try {
      return await host.account();
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  }

  async status(input: { cwd: string }): Promise<{ account: CodexAccountReadResponse; rateLimits: CodexNativeRateLimits }> {
    this.assertInitialized();
    if (!path.isAbsolute(input.cwd)) throw new Error("Codex status cwd must be absolute");
    const host = this.hostFactory({ clientVersion: this.clientVersion });
    if (!host.readRateLimits) throw new Error("Installed Codex app-server does not expose native rate-limit status");
    try {
      const account = await host.account();
      const rateLimits = await host.readRateLimits();
      return { account, rateLimits };
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  }

  async usage(input: { workspaceId: string; cwd: string; runId?: string }): Promise<CodexNativeAccountUsage> {
    this.assertInitialized();
    validateWorkspaceScope(input.workspaceId, input.cwd);
    const cwd = path.resolve(input.cwd);
    let threadId: string | undefined;
    if (input.runId) {
      validateRunId(input.runId);
      const binding = this.store.get(input.runId);
      if (binding) {
        if (binding.workspaceId !== input.workspaceId || binding.cwd !== cwd) throw new Error("Codex Harness run is bound to a different workspace");
        threadId = binding.threadId;
      }
    }
    const host = this.hostFactory({ clientVersion: this.clientVersion });
    if (!host.readAccountUsage) throw new Error("Installed Codex app-server does not expose native token usage");
    try {
      return await host.readAccountUsage(threadId);
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  }

  async runTurn(input: CodexRuntimeTurnInput): Promise<CodexRuntimeTurnResult> {
    this.assertInitialized();
    validateInput(input);
    const cwd = path.resolve(input.cwd);
    const stored = this.store.get(input.runId);
    if (stored && (stored.workspaceId !== input.workspaceId || stored.cwd !== cwd)) {
      throw new Error("Codex Harness run is bound to a different workspace");
    }

    if (stored) await this.waitForThreadWriter(stored.threadId);
    const { entry, resumed, binding } = await this.runtimeFor(input, stored);
    if (entry.busy) {
      await this.waitForThreadWriter(binding.threadId);
      if (entry.busy) throw new Error("Codex Harness run already has an active turn");
    }
    this.acquireThreadWriter(binding.threadId, input.runId);
    entry.busy = true;
    entry.lastUsed = ++this.clock;
    try {
      const skillRoots = input.skillRoots ?? [];
      const skills = input.skills ?? [];
      const catalog = await entry.host.configureSkills(skillRoots, cwd);
      assertSkillsAvailable(skills, catalog);
      const result = await entry.host.runTurn(input.prompt, skills);
      const threadId = entry.host.attachedThreadId();
      if (!threadId || threadId !== binding.threadId) throw new Error("Codex runtime completed a turn on an unexpected thread");
      return { ...result, binding, resumed };
    } finally {
      entry.busy = false;
      this.releaseThreadWriter(binding.threadId, input.runId);
      entry.lastUsed = ++this.clock;
    }
  }

  async listConversations(input: { workspaceId: string; cwd: string; limit?: number }): Promise<CodexRuntimeConversationSummary[]> {
    this.assertInitialized();
    validateWorkspaceScope(input.workspaceId, input.cwd);
    const cwd = path.resolve(input.cwd);
    const host = this.hostFactory({ clientVersion: this.clientVersion });
    try {
      const threads = await host.listThreads(cwd, input.limit ?? 100);
      const bindings = this.store.list()
        .filter((binding) => binding.workspaceId === input.workspaceId && binding.cwd === cwd)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const runByThread = new Map<string, string>();
      for (const binding of bindings) if (!runByThread.has(binding.threadId)) runByThread.set(binding.threadId, binding.runId);
      return threads.map((thread) => ({ ...thread, ...(runByThread.get(thread.threadId) ? { runId: runByThread.get(thread.threadId)! } : {}) }));
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  }

  async conversation(input: { runId: string; workspaceId: string; cwd: string }): Promise<CodexRuntimeConversationView> {
    this.assertInitialized();
    validateWorkspaceScope(input.workspaceId, input.cwd);
    validateRunId(input.runId);
    const cwd = path.resolve(input.cwd);
    const binding = this.store.get(input.runId);
    if (!binding) return { threadId: null, messages: [], busy: false };
    if (binding.workspaceId !== input.workspaceId || binding.cwd !== cwd) throw new Error("Codex Harness run is bound to a different workspace");

    const warm = this.runtimes.get(input.runId);
    if (warm) {
      if (warm.workspaceId !== input.workspaceId || warm.cwd !== cwd) throw new Error("Codex runtime scope changed for the same Harness run");
      if (warm.host.attachedThreadId() !== binding.threadId) throw new Error("Codex runtime is attached to a different thread than its persisted binding");
      try {
        return { threadId: binding.threadId, messages: await warm.host.readConversationHistory(binding.threadId), busy: this.activeThreadWriters.has(binding.threadId) };
      } catch (error) {
        if (isMissingNativeThreadError(error) && await this.discardMissingBinding(input.runId)) {
          return { threadId: null, messages: [], busy: false };
        }
        if (isActiveWriterError(error)) return { threadId: binding.threadId, messages: [], busy: true, busyReason: activeWriterBusyReason() };
        throw error;
      }
    }

    // A fresh app-server process does not necessarily have a persisted thread loaded.
    // Resume the exact native thread before reading its turn history. If Codex no
    // longer owns that thread, remove only the stale SourceNerve binding and let the
    // next normal prompt start a fresh native conversation without requiring /new.
    const host = this.hostFactory({ clientVersion: this.clientVersion });
    try {
      await host.resumeThread(binding.threadId, { cwd });
      if (host.attachedThreadId() !== binding.threadId) throw new Error("Codex resumed a different thread than requested");
      return { threadId: binding.threadId, messages: await host.readConversationHistory(binding.threadId), busy: false };
    } catch (error) {
      if (isMissingNativeThreadError(error)) {
        await this.store.remove(input.runId);
        return { threadId: null, messages: [], busy: false };
      }
      if (isActiveWriterError(error)) return { threadId: binding.threadId, messages: [], busy: true, busyReason: activeWriterBusyReason() };
      throw error;
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  }

  async resumeConversation(input: CodexRuntimeResumeInput): Promise<{ binding: CodexThreadBinding; messages: CodexNativeConversationMessage[]; busy: boolean; busyReason?: string }> {
    this.assertInitialized();
    validateResumeInput(input);
    const cwd = path.resolve(input.cwd);
    const current = this.runtimes.get(input.runId);
    if (current?.busy) {
      const threadId = current.host.attachedThreadId() ?? input.threadId;
      const binding = await this.store.rebind({ runId: input.runId, workspaceId: input.workspaceId, cwd, threadId });
      return { binding, messages: [], busy: true, busyReason: activeWriterBusyReason() };
    }
    if (current) {
      this.runtimes.delete(current.runId);
      await current.host.shutdown();
    }

    const active = this.activeThreadWriters.get(input.threadId);
    if (active) {
      const binding = await this.store.rebind({ runId: input.runId, workspaceId: input.workspaceId, cwd, threadId: input.threadId });
      return { binding, messages: [], busy: true, busyReason: activeWriterBusyReason() };
    }

    const duplicate = [...this.runtimes.values()].find((entry) => entry.host.attachedThreadId() === input.threadId);
    if (duplicate?.busy) {
      const binding = await this.store.rebind({ runId: input.runId, workspaceId: input.workspaceId, cwd, threadId: input.threadId });
      return { binding, messages: [], busy: true, busyReason: activeWriterBusyReason() };
    }
    if (duplicate) {
      this.runtimes.delete(duplicate.runId);
      await duplicate.host.shutdown();
    }

    await this.makeCapacity();
    const host = this.hostFactory({
      clientVersion: this.clientVersion,
      ...(this.serverRequestHandler ? {
        onServerRequest: (request) => this.serverRequestHandler!({
          runId: input.runId,
          workspaceId: input.workspaceId,
          cwd,
        }, request),
      } : {}),
    });
    try {
      await host.resumeThread(input.threadId, threadOptionsFromInput({ ...input, prompt: "resume" }));
      if (host.attachedThreadId() !== input.threadId) throw new Error("Codex resumed a different thread than requested");
      const messages = await host.readConversationHistory(input.threadId);
      const binding = await this.store.rebind({
        runId: input.runId,
        workspaceId: input.workspaceId,
        cwd,
        threadId: input.threadId,
      });
      this.runtimes.set(input.runId, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        cwd,
        host,
        busy: false,
        lastUsed: ++this.clock,
      });
      return { binding, messages, busy: false };
    } catch (error) {
      await host.shutdown().catch(() => undefined);
      if (isActiveWriterError(error)) {
        const binding = await this.store.rebind({ runId: input.runId, workspaceId: input.workspaceId, cwd, threadId: input.threadId });
        return { binding, messages: [], busy: true, busyReason: activeWriterBusyReason() };
      }
      throw error;
    }
  }

  async recover(runId: string): Promise<boolean> {
    this.assertInitialized();
    const entry = this.runtimes.get(runId);
    if (!entry) return false;
    if (entry.busy) throw new Error("Cannot recover Codex runtime while a turn is active");
    return entry.host.recover();
  }

  binding(runId: string): CodexThreadBinding | null {
    this.assertInitialized();
    return this.store.get(runId);
  }

  bindings(workspaceId: string): CodexThreadBinding[] {
    this.assertInitialized();
    if (!workspaceId || workspaceId.length > 128 || /[\r\n\0]/.test(workspaceId)) throw new Error("Codex workspace id is invalid");
    return this.store.list().filter((binding) => binding.workspaceId === workspaceId);
  }

  async release(runId: string): Promise<boolean> {
    this.assertInitialized();
    const entry = this.runtimes.get(runId);
    if (!entry) return false;
    if (entry.busy) throw new Error("Cannot release Codex runtime while a turn is active");
    this.runtimes.delete(runId);
    const threadId = entry.host.attachedThreadId();
    if (threadId) this.releaseThreadWriter(threadId, runId);
    await entry.host.shutdown();
    return true;
  }

  async cancel(runId: string): Promise<boolean> {
    this.assertInitialized();
    const entry = this.runtimes.get(runId);
    if (!entry) return false;
    this.runtimes.delete(runId);
    const threadId = entry.host.attachedThreadId();
    if (threadId) this.releaseThreadWriter(threadId, runId);
    await entry.host.shutdown();
    return true;
  }

  async clearWorkspace(workspaceId: string, cwd: string): Promise<string[]> {
    this.assertInitialized();
    validateWorkspaceScope(workspaceId, cwd);
    const resolvedCwd = path.resolve(cwd);
    const entries = [...this.runtimes.values()].filter((entry) => entry.workspaceId === workspaceId);
    if (entries.some((entry) => entry.busy)) throw new Error("Cannot clear Codex conversations while a workspace turn is active");
    for (const entry of entries) {
      this.runtimes.delete(entry.runId);
      const threadId = entry.host.attachedThreadId();
      if (threadId) this.releaseThreadWriter(threadId, entry.runId);
    }
    await Promise.all(entries.map((entry) => entry.host.shutdown().catch(() => undefined)));

    const host = this.hostFactory({ clientVersion: this.clientVersion });
    try {
      const threads = await host.listThreads(resolvedCwd, 2_000);
      for (const thread of threads) await host.deleteThread(thread.threadId);
    } finally {
      await host.shutdown().catch(() => undefined);
    }
    return this.store.removeWorkspace(workspaceId);
  }

  async shutdown(): Promise<void> {
    const entries = [...this.runtimes.values()];
    this.runtimes.clear();
    this.activeThreadWriters.clear();
    await Promise.all(entries.map((entry) => entry.host.shutdown().catch(() => undefined)));
    await this.store.flush().catch(() => undefined);
  }

  private async runtimeFor(input: CodexRuntimeTurnInput, stored: CodexThreadBinding | null): Promise<{ entry: RuntimeEntry; resumed: boolean; binding: CodexThreadBinding }> {
    const existing = this.runtimes.get(input.runId);
    if (existing) {
      if (existing.workspaceId !== input.workspaceId || existing.cwd !== path.resolve(input.cwd)) {
        throw new Error("Codex runtime scope changed for the same Harness run");
      }
      const binding = stored ?? this.store.get(input.runId);
      if (!binding) throw new Error("Codex runtime is missing its persisted thread binding");
      return { entry: existing, resumed: stored !== null, binding };
    }

    await this.makeCapacity();
    const cwd = path.resolve(input.cwd);
    const host = this.hostFactory({
      clientVersion: this.clientVersion,
      ...(this.serverRequestHandler ? {
        onServerRequest: (request) => this.serverRequestHandler!({
          runId: input.runId,
          workspaceId: input.workspaceId,
          cwd,
        }, request),
      } : {}),
    });
    const threadOptions = threadOptionsFromInput(input);
    let binding = stored;
    try {
      if (stored) await this.resumeThreadWhenWritable(host, stored.threadId, threadOptions);
      else {
        await host.startThread(threadOptions);
        const threadId = host.attachedThreadId();
        if (!threadId) throw new Error("Codex runtime started without an attached thread");
        binding = await this.store.bind({
          runId: input.runId,
          workspaceId: input.workspaceId,
          cwd,
          threadId,
        });
      }
    } catch (error) {
      await host.shutdown().catch(() => undefined);
      throw error;
    }
    if (!binding) throw new Error("Codex runtime failed to persist its thread binding");
    const entry: RuntimeEntry = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      cwd: path.resolve(input.cwd),
      host,
      busy: false,
      lastUsed: ++this.clock,
    };
    this.runtimes.set(input.runId, entry);
    return { entry, resumed: stored !== null, binding };
  }

  private acquireThreadWriter(threadId: string, runId: string): void {
    const owner = this.activeThreadWriters.get(threadId);
    if (owner) throw new Error("This Codex conversation already has an active turn in another Harness run");
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    this.activeThreadWriters.set(threadId, { runId, startedAt: Date.now(), done, release });
  }

  private releaseThreadWriter(threadId: string, runId: string): void {
    const owner = this.activeThreadWriters.get(threadId);
    if (!owner || owner.runId !== runId) return;
    this.activeThreadWriters.delete(threadId);
    owner.release();
  }

  private async waitForThreadWriter(threadId: string): Promise<void> {
    for (;;) {
      const owner = this.activeThreadWriters.get(threadId);
      if (!owner) return;
      await owner.done.catch(() => undefined);
    }
  }

  private async resumeThreadWhenWritable(host: CodexRuntimeHost, threadId: string, options: CodexThreadOptions): Promise<void> {
    for (;;) {
      try {
        await host.resumeThread(threadId, options);
        return;
      } catch (error) {
        if (!isActiveWriterError(error)) throw error;
        await sleep(ACTIVE_WRITER_RETRY_DELAY_MS);
      }
    }
  }


  private async discardMissingBinding(runId: string): Promise<boolean> {
    const entry = this.runtimes.get(runId);
    if (entry?.busy) return false;
    if (entry) {
      this.runtimes.delete(runId);
      const threadId = entry.host.attachedThreadId();
      if (threadId) this.releaseThreadWriter(threadId, runId);
      await entry.host.shutdown().catch(() => undefined);
    }
    await this.store.remove(runId);
    return true;
  }

  private async makeCapacity(): Promise<void> {
    if (this.runtimes.size < this.maxRuntimes) return;
    const idle = [...this.runtimes.values()]
      .filter((entry) => !entry.busy)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!idle) throw new Error("Codex runtime pool is at capacity with active turns");
    this.runtimes.delete(idle.runId);
    const threadId = idle.host.attachedThreadId();
    if (threadId) this.releaseThreadWriter(threadId, idle.runId);
    await idle.host.shutdown();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Codex runtime pool is not initialized");
  }
}

function threadOptionsFromInput(input: CodexRuntimeTurnInput): CodexThreadOptions {
  return {
    cwd: path.resolve(input.cwd),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
  };
}

function validateInput(input: CodexRuntimeTurnInput): void {
  if (!input.runId || input.runId.length > 128 || /[\r\n\0]/.test(input.runId)) throw new Error("Codex run id is invalid");
  if (!input.workspaceId || input.workspaceId.length > 128 || /[\r\n\0]/.test(input.workspaceId)) throw new Error("Codex workspace id is invalid");
  if (!path.isAbsolute(input.cwd)) throw new Error("Codex workspace cwd must be absolute");
  if (!input.prompt) throw new Error("Codex prompt must not be empty");
  if ((input.skills?.length ?? 0) > MAX_ACTIVE_SKILLS) throw new Error(`Codex P2 supports at most ${MAX_ACTIVE_SKILLS} active skills`);
  if ((input.skills?.length ?? 0) > 0 && input.skillRoots === undefined) throw new Error("Codex skill invocations require projected skill roots");
  for (const root of input.skillRoots ?? []) {
    if (!path.isAbsolute(root)) throw new Error("Codex skill root must be absolute");
  }
  for (const skill of input.skills ?? []) {
    if (!skill.name || !path.isAbsolute(skill.path)) throw new Error("Codex skill invocation is invalid");
  }
}

function validateRunId(runId: string): void {
  if (!runId || runId.length > 128 || /[\r\n\0]/.test(runId)) throw new Error("Codex run id is invalid");
}

function validateWorkspaceScope(workspaceId: string, cwd: string): void {
  if (!workspaceId || workspaceId.length > 128 || /[\r\n\0]/.test(workspaceId)) throw new Error("Codex workspace id is invalid");
  if (!path.isAbsolute(cwd)) throw new Error("Codex workspace cwd must be absolute");
}

function validateResumeInput(input: CodexRuntimeResumeInput): void {
  validateRunId(input.runId);
  validateWorkspaceScope(input.workspaceId, input.cwd);
  if (!input.threadId || input.threadId.length > 256 || /[\r\n\0]/.test(input.threadId)) throw new Error("Codex thread id is invalid");
}

function assertSkillsAvailable(skills: readonly CodexSkillInvocation[], response: CodexSkillsListResponse): void {
  if (skills.length === 0) return;
  const discovered = response.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
  for (const requested of skills) {
    const requestedPath = path.resolve(requested.path);
    const found = discovered.some((skill) => skill.name === requested.name && path.resolve(skill.path) === requestedPath);
    if (!found) throw new Error(`Codex did not discover requested skill ${requested.name}`);
  }
}

function isMissingNativeThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:thread|conversation).*(?:not loaded|not found|does not exist|unknown)|(?:not loaded|not found|does not exist|unknown).*(?:thread|conversation)/i.test(message);
}

function isActiveWriterError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:thread|conversation).*active writer|active writer.*(?:thread|conversation)/i.test(message);
}

function activeWriterBusyReason(): string {
  return "Codex conversation is still finishing a previous turn. New prompts will wait until the native thread is writable.";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Codex runtime pool limit is invalid");
  return value;
}
