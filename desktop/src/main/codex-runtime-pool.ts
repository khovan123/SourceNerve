import path from "node:path";

import {
  CodexAppServerHost,
  type CodexAppServerHostOptions,
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

export interface CodexRuntimeHost {
  attachedThreadId(): string | null;
  account(): Promise<CodexAccountReadResponse>;
  startThread(options: CodexThreadOptions): Promise<{ thread: { id: string } }>;
  resumeThread(threadId: string, options: CodexThreadOptions): Promise<{ thread: { id: string } }>;
  configureSkills(extraRoots: readonly string[], cwd: string): Promise<CodexSkillsListResponse>;
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

  async runTurn(input: CodexRuntimeTurnInput): Promise<CodexRuntimeTurnResult> {
    this.assertInitialized();
    validateInput(input);
    const cwd = path.resolve(input.cwd);
    const stored = this.store.get(input.runId);
    if (stored && (stored.workspaceId !== input.workspaceId || stored.cwd !== cwd)) {
      throw new Error("Codex Harness run is bound to a different workspace");
    }

    const { entry, resumed, binding } = await this.runtimeFor(input, stored);
    if (entry.busy) throw new Error("Codex Harness run already has an active turn");
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
      entry.lastUsed = ++this.clock;
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

  async release(runId: string): Promise<boolean> {
    this.assertInitialized();
    const entry = this.runtimes.get(runId);
    if (!entry) return false;
    if (entry.busy) throw new Error("Cannot release Codex runtime while a turn is active");
    this.runtimes.delete(runId);
    await entry.host.shutdown();
    return true;
  }

  async cancel(runId: string): Promise<boolean> {
    this.assertInitialized();
    const entry = this.runtimes.get(runId);
    if (!entry) return false;
    this.runtimes.delete(runId);
    await entry.host.shutdown();
    return true;
  }

  async shutdown(): Promise<void> {
    const entries = [...this.runtimes.values()];
    this.runtimes.clear();
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
      if (stored) await host.resumeThread(stored.threadId, threadOptions);
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

  private async makeCapacity(): Promise<void> {
    if (this.runtimes.size < this.maxRuntimes) return;
    const idle = [...this.runtimes.values()]
      .filter((entry) => !entry.busy)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!idle) throw new Error("Codex runtime pool is at capacity with active turns");
    this.runtimes.delete(idle.runId);
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

function assertSkillsAvailable(skills: readonly CodexSkillInvocation[], response: CodexSkillsListResponse): void {
  if (skills.length === 0) return;
  const discovered = response.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
  for (const requested of skills) {
    const requestedPath = path.resolve(requested.path);
    const found = discovered.some((skill) => skill.name === requested.name && path.resolve(skill.path) === requestedPath);
    if (!found) throw new Error(`Codex did not discover requested skill ${requested.name}`);
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Codex runtime pool limit is invalid");
  return value;
}
