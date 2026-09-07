import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { CodexAppServerHost } from "./codex-app-server-host";

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor(private readonly exitDelayMs = 0) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null || this.killed) return false;
    this.killed = true;
    const exit = () => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.emit("exit", null, signal);
    };
    if (this.exitDelayMs > 0) setTimeout(exit, this.exitDelayMs);
    else exit();
    return true;
  }

  crash(code = 1): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

interface FakeServer {
  methods: string[];
  prompts: string[];
  turnInputs: unknown[][];
  extraRoots: string[][];
  deletedThreads: string[];
}

describe("CodexAppServerHost", () => {
  it("uses the official stdio app-server lane and leaves reasoning/tools/session ownership in Codex", async () => {
    const child = new FakeCodexProcess();
    const server = installFakeAppServer(child, "thread-native-1");
    const launches: Array<{ command: string; args: readonly string[] }> = [];
    const host = new CodexAppServerHost({
      clientVersion: "0.1.12",
      spawnProcess: (command, args) => {
        launches.push({ command, args });
        return child.asChild();
      },
    });

    await expect(host.account()).resolves.toEqual({
      account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    await host.startThread({ cwd: "/tmp/source-native", sandbox: "workspace-write", approvalPolicy: "never" });
    const result = await host.runTurn("edit the file and run tests");

    expect(launches).toEqual([{ command: "codex", args: ["app-server", "--stdio"] }]);
    expect(server.methods).toEqual(["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
    expect(server.methods.some((method) => method.startsWith("skills/"))).toBe(false);
    expect(server.prompts).toEqual(["edit the file and run tests"]);
    expect(result).toMatchObject({
      threadId: "thread-native-1",
      turnId: "turn-1",
      status: "completed",
      response: "native codex completed",
      recoveredBeforeTurn: false,
      tokenUsage: {
        last: { inputTokens: 12, outputTokens: 7, reasoningOutputTokens: 2 },
      },
    });

    await host.shutdown();
    expect(child.killed).toBe(true);
  });

  it("lists, reads and deletes native Codex conversations through app-server thread RPCs", async () => {
    const child = new FakeCodexProcess();
    const cwd = "/tmp/source-history";
    const server = installFakeAppServer(child, "thread-history", { nativeHistoryCwd: cwd });
    const host = new CodexAppServerHost({ spawnProcess: () => child.asChild() });

    await expect(host.listThreads(cwd)).resolves.toEqual([
      {
        threadId: "thread-history",
        cwd,
        name: "Native history",
        preview: "Resume this conversation",
        model: "gpt-test-codex",
        createdAt: "2026-09-05T08:00:00.000Z",
        updatedAt: "2026-09-05T08:01:00.000Z",
        status: "idle",
      },
      {
        threadId: "thread-history-nested",
        cwd: `${cwd}/desktop`,
        name: "Nested native history",
        preview: "Resume nested conversation",
        model: "gpt-test-codex",
        createdAt: "2026-09-05T07:00:00.000Z",
        updatedAt: "2026-09-05T07:01:00.000Z",
        status: "idle",
      },
    ]);
    await expect(host.readConversationHistory("thread-history")).resolves.toEqual([
      { id: "user-history", role: "user", text: "Resume this conversation", createdAt: "2026-09-05T08:00:00.000Z", turnId: "turn-history" },
      { id: "assistant-history", role: "assistant", text: "Native response", createdAt: "2026-09-05T08:00:00.000Z", turnId: "turn-history" },
    ]);
    await expect(host.readRateLimits()).resolves.toMatchObject({
      buckets: [{ limitId: "codex", planType: "plus", primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1788598800 } }],
      resetCreditsAvailable: 1,
    });
    await expect(host.readAccountUsage("thread-history")).resolves.toMatchObject({
      summary: { lifetimeTokens: 123456, peakDailyTokens: 12000 },
      threadUsage: { threadId: "thread-history", groups: [{ model: "gpt-test-codex", totalTokens: 3210 }] },
    });
    await host.deleteThread("thread-history");

    expect(server.methods).toContain("thread/list");
    expect(server.methods).toContain("thread/read");
    expect(server.methods).toContain("thread/turns/list");
    expect(server.methods).toContain("account/rateLimits/read");
    expect(server.methods).toContain("account/usage/read");
    expect(server.methods).toContain("thread/delete");
    expect(server.deletedThreads).toEqual(["thread-history"]);
    await host.shutdown();
  });

  it("hides internal Harness recovery prompts from native conversation history while keeping the recovery answer", async () => {
    const child = new FakeCodexProcess();
    const cwd = "/tmp/source-recovery-history";
    installFakeAppServer(child, "thread-recovery-history", {
      nativeHistoryCwd: cwd,
      nativeHistoryItems: [
        { id: "user-recovery", type: "userMessage", content: [{ type: "text", text: "[[SOURCENERVE_HARNESS_RECOVERY]]\nproof failed", text_elements: [] }] },
        { id: "assistant-recovery", type: "agentMessage", text: "Recovered implementation and tests now pass" },
      ],
    });
    const host = new CodexAppServerHost({ spawnProcess: () => child.asChild() });

    await expect(host.readConversationHistory("thread-recovery-history")).resolves.toEqual([
      { id: "assistant-recovery", role: "assistant", text: "Recovered implementation and tests now pass", createdAt: "2026-09-05T08:00:00.000Z", turnId: "turn-history" },
    ]);
    await host.shutdown();
  });

  it("recovers an established native thread after app-server crashes without replaying the failed turn", async () => {
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const firstServer = installFakeAppServer(first, "thread-recover-1");
    const secondServer = installFakeAppServer(second, "thread-recover-1");
    const children = [first, second];
    const host = new CodexAppServerHost({
      spawnProcess: () => {
        const next = children.shift();
        if (!next) throw new Error("unexpected extra Codex spawn");
        return next.asChild();
      },
    });

    await host.startThread({ cwd: "/tmp/source-recover" });
    await host.runTurn("first completed turn");
    first.crash(9);

    const recovered = await host.runTurn("continue after crash");
    expect(recovered.recoveredBeforeTurn).toBe(true);
    expect(recovered.response).toBe("native codex completed");
    expect(firstServer.prompts).toEqual(["first completed turn"]);
    expect(secondServer.methods).toContain("thread/resume");
    expect(secondServer.prompts).toEqual(["continue after crash"]);

    await host.shutdown();
  });

  it("waits for the app-server process to exit before shutdown resolves", async () => {
    const child = new FakeCodexProcess(25);
    installFakeAppServer(child, "thread-shutdown-wait");
    const host = new CodexAppServerHost({ spawnProcess: () => child.asChild() });
    await host.startThread({ cwd: "/tmp/source-shutdown-wait", sandbox: "workspace-write", approvalPolicy: "on-request" });

    let resolved = false;
    const shutdown = host.shutdown().then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(child.killed).toBe(true);
    expect(resolved).toBe(false);
    await shutdown;
    expect(resolved).toBe(true);
  });

  it("rejects an active turn when shutdown cancels its app-server process", async () => {
    const child = new FakeCodexProcess();
    installFakeAppServer(child, "thread-cancel", { completeTurns: false });
    const host = new CodexAppServerHost({ spawnProcess: () => child.asChild() });
    await host.startThread({ cwd: "/tmp/source-cancel", sandbox: "workspace-write", approvalPolicy: "on-request" });

    const pendingTurn = host.runTurn("keep working");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await host.shutdown();

    await expect(pendingTurn).rejects.toThrow(/shut down/);
    expect(child.killed).toBe(true);
  });

  it("projects exact skill roots and invokes skills through native Codex UserInput", async () => {
    const child = new FakeCodexProcess();
    const skillRoot = "/tmp/sourcenerve-run/skills";
    const skillPath = `${skillRoot}/plugin--review/SKILL.md`;
    const server = installFakeAppServer(child, "thread-skills", {
      skills: [{ name: "review", path: skillPath }],
    });
    const host = new CodexAppServerHost({ spawnProcess: () => child.asChild() });

    await host.startThread({ cwd: "/tmp/source-skills" });
    const catalog = await host.configureSkills([skillRoot], "/tmp/source-skills");
    expect(catalog.data[0]?.skills[0]).toMatchObject({ name: "review", path: skillPath, enabled: true });
    await host.runTurn("review this diff", [{ name: "review", path: skillPath }]);

    expect(server.extraRoots).toEqual([[skillRoot]]);
    expect(server.methods).toContain("skills/extraRoots/set");
    expect(server.methods).toContain("skills/list");
    expect(server.turnInputs[0]).toEqual([
      { type: "skill", name: "review", path: skillPath },
      { type: "text", text: "review this diff", text_elements: [] },
    ]);
    expect(JSON.stringify(server.turnInputs[0])).not.toContain("skill instructions");
    await host.shutdown();
  });

  it("reapplies desired skill roots after an app-server crash before continuing the native thread", async () => {
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const skillRoot = "/tmp/sourcenerve-recover/skills";
    const skillPath = `${skillRoot}/plugin--review/SKILL.md`;
    const firstServer = installFakeAppServer(first, "thread-skill-recover", { skills: [{ name: "review", path: skillPath }] });
    const secondServer = installFakeAppServer(second, "thread-skill-recover", { skills: [{ name: "review", path: skillPath }] });
    const children = [first, second];
    const host = new CodexAppServerHost({
      spawnProcess: () => {
        const next = children.shift();
        if (!next) throw new Error("unexpected extra Codex spawn");
        return next.asChild();
      },
    });

    await host.startThread({ cwd: "/tmp/source-skill-recover" });
    await host.configureSkills([skillRoot], "/tmp/source-skill-recover");
    await host.runTurn("first", [{ name: "review", path: skillPath }]);
    first.crash(7);

    const recovered = await host.runTurn("continue", [{ name: "review", path: skillPath }]);
    expect(recovered.recoveredBeforeTurn).toBe(true);
    expect(firstServer.extraRoots).toEqual([[skillRoot]]);
    expect(secondServer.extraRoots).toEqual([[skillRoot]]);
    const resumeIndex = secondServer.methods.indexOf("thread/resume");
    const rootIndex = secondServer.methods.indexOf("skills/extraRoots/set");
    const turnIndex = secondServer.methods.indexOf("turn/start");
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(rootIndex).toBeLessThan(turnIndex);
    expect(resumeIndex).toBeLessThan(turnIndex);
    await host.shutdown();
  });
});

function installFakeAppServer(
  child: FakeCodexProcess,
  threadId: string,
  options: { skills?: Array<{ name: string; path: string }>; completeTurns?: boolean; nativeHistoryCwd?: string; nativeHistoryItems?: unknown[] } = {},
): FakeServer {
  const methods: string[] = [];
  const prompts: string[] = [];
  const turnInputs: unknown[][] = [];
  const extraRoots: string[][] = [];
  const deletedThreads: string[] = [];
  let buffer = "";
  let turnSequence = 0;
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
      methods.push(message.method);
      if (message.method === "initialized") continue;
      if (message.method === "initialize") {
        respond(child, message.id, {
          userAgent: "codex-cli-test",
          codexHome: "/tmp/.codex",
          platformFamily: "unix",
          platformOs: "linux",
        });
        continue;
      }
      if (message.method === "account/read") {
        respond(child, message.id, {
          account: { type: "chatgpt", email: "dev@example.com", planType: "plus" },
          requiresOpenaiAuth: true,
        });
        continue;
      }
      if (message.method === "account/rateLimits/read" && options.nativeHistoryCwd) {
        respond(child, message.id, {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            planType: "plus",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1788598800 },
            secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1789200000 },
            credits: { hasCredits: true, unlimited: false, balance: "10" },
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: { availableCount: 1, credits: null },
        });
        continue;
      }
      if (message.method === "account/usage/read" && options.nativeHistoryCwd) {
        respond(child, message.id, {
          summary: { lifetimeTokens: 123456, peakDailyTokens: 12000, currentStreakDays: 3, longestStreakDays: 8, longestRunningTurnSec: 45 },
          dailyUsageBuckets: null,
          threadUsage: message.params?.threadId ? {
            threadId: String(message.params.threadId),
            estimatedUsageCreditsMicros: 1000,
            estimatedUsageUsdMicros: 2500,
            groups: [{
              model: "gpt-test-codex",
              reasoningEffort: "medium",
              speed: "normal",
              totalTokens: 3210,
              inputTokens: 2500,
              cachedInputTokens: 500,
              netNewInputTokens: 2000,
              outputTokens: 710,
              estimatedUsageCreditsMicros: 1000,
            }],
          } : null,
        });
        continue;
      }
      if (message.method === "thread/list" && options.nativeHistoryCwd) {
        respond(child, message.id, {
          data: [
            {
              id: threadId,
              sessionId: `session-${threadId}`,
              cwd: options.nativeHistoryCwd,
              modelProvider: "openai",
              model: "gpt-test-codex",
              ephemeral: false,
              name: "Native history",
              preview: "Resume this conversation",
              projectId: null,
              parentThreadId: null,
              source: "cli",
              status: { type: "idle" },
              turns: [],
              cliVersion: "0.0.0-test",
              createdAt: 1788595200,
              updatedAt: 1788595260,
            },
            {
              id: `${threadId}-nested`,
              sessionId: `session-${threadId}-nested`,
              cwd: `${options.nativeHistoryCwd}/desktop`,
              modelProvider: "openai",
              model: "gpt-test-codex",
              ephemeral: false,
              name: "Nested native history",
              preview: "Resume nested conversation",
              projectId: null,
              parentThreadId: null,
              source: "exec",
              status: { type: "idle" },
              turns: [],
              cliVersion: "0.0.0-test",
              createdAt: 1788591600,
              updatedAt: 1788591660,
            },
            {
              id: `${threadId}-other`,
              sessionId: `session-${threadId}-other`,
              cwd: "/tmp/another-workspace",
              modelProvider: "openai",
              model: "gpt-test-codex",
              ephemeral: false,
              name: "Other workspace",
              preview: "Do not include",
              projectId: null,
              parentThreadId: null,
              source: "cli",
              status: { type: "idle" },
              turns: [],
              cliVersion: "0.0.0-test",
              createdAt: 1788588000,
              updatedAt: 1788588060,
            },
            {
              id: `${threadId}-child-agent`,
              sessionId: `session-${threadId}-child-agent`,
              cwd: `${options.nativeHistoryCwd}/desktop`,
              modelProvider: "openai",
              model: "gpt-test-codex",
              ephemeral: false,
              name: "Subagent",
              preview: "Do not include",
              projectId: null,
              parentThreadId: threadId,
              source: "subAgent",
              status: { type: "idle" },
              turns: [],
              cliVersion: "0.0.0-test",
              createdAt: 1788584400,
              updatedAt: 1788584460,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
        });
        continue;
      }
      if (message.method === "thread/read" && options.nativeHistoryCwd) {
        respond(child, message.id, {
          thread: {
            id: threadId,
            cwd: options.nativeHistoryCwd,
            createdAt: 1788595200,
            updatedAt: 1788595260,
            status: { type: "idle" },
          },
        });
        continue;
      }
      if (message.method === "thread/turns/list" && options.nativeHistoryCwd) {
        respond(child, message.id, {
          data: [{
            id: "turn-history",
            status: "completed",
            startedAt: 1788595200,
            completedAt: 1788595260,
            itemsView: "full",
            items: options.nativeHistoryItems ?? [
              { id: "user-history", type: "userMessage", content: [{ type: "text", text: "Resume this conversation", text_elements: [] }] },
              { id: "assistant-history", type: "agentMessage", text: "Native response" },
            ],
          }],
          nextCursor: null,
          backwardsCursor: null,
        });
        continue;
      }
      if (message.method === "thread/delete" && options.nativeHistoryCwd) {
        deletedThreads.push(String(message.params?.threadId ?? ""));
        respond(child, message.id, {});
        continue;
      }
      if (message.method === "thread/start" || message.method === "thread/resume") {
        const cwd = String(message.params?.cwd ?? "/tmp/source");
        respond(child, message.id, threadResponse(threadId, cwd));
        continue;
      }
      if (message.method === "skills/extraRoots/set") {
        const roots = Array.isArray(message.params?.extraRoots) ? message.params?.extraRoots.map(String) : [];
        extraRoots.push(roots);
        respond(child, message.id, {});
        continue;
      }
      if (message.method === "skills/list") {
        const cwd = Array.isArray(message.params?.cwds) ? String(message.params?.cwds[0] ?? "/tmp/source") : "/tmp/source";
        respond(child, message.id, {
          data: [{
            cwd,
            errors: [],
            skills: (options.skills ?? []).map((skill) => ({
              name: skill.name,
              description: `${skill.name} skill`,
              path: skill.path,
              scope: "user",
              enabled: true,
              pluginId: null,
            })),
          }],
        });
        continue;
      }
      if (message.method === "turn/start") {
        const input = Array.isArray(message.params?.input) ? message.params?.input : [];
        turnInputs.push(input);
        const textInput = input.find((item) => item && typeof item === "object" && (item as { type?: string }).type === "text") as { text?: string } | undefined;
        prompts.push(textInput?.text ?? "");
        const turnId = `turn-${++turnSequence}`;
        respond(child, message.id, { turn: turn(turnId, "inProgress", []) });
        if (options.completeTurns === false) continue;
        queueMicrotask(() => {
          notify(child, "thread/tokenUsage/updated", {
            threadId,
            turnId,
            tokenUsage: {
              total: usage(19, 12, 7, 2),
              last: usage(19, 12, 7, 2),
              modelContextWindow: 128000,
            },
          });
          notify(child, "item/completed", {
            threadId,
            turnId,
            completedAtMs: Date.now(),
            item: { type: "agentMessage", id: `message-${turnSequence}`, text: "native codex completed", phase: null, memoryCitation: null, delivery: null, questions: null },
          });
          notify(child, "turn/completed", {
            threadId,
            turn: turn(turnId, "completed", [{ type: "agentMessage", id: `message-${turnSequence}`, text: "native codex completed" }]),
          });
        });
      }
    }
  });
  return { methods, prompts, turnInputs, extraRoots, deletedThreads };
}

function threadResponse(threadId: string, cwd: string): object {
  return {
    thread: {
      id: threadId,
      sessionId: `session-${threadId}`,
      cwd,
      modelProvider: "openai",
      model: "gpt-test-codex",
      ephemeral: false,
    },
    model: "gpt-test-codex",
    modelProvider: "openai",
    cwd,
  };
}

function turn(id: string, status: "inProgress" | "completed", items: unknown[]): object {
  return { id, status, error: null, items };
}

function usage(totalTokens: number, inputTokens: number, outputTokens: number, reasoningOutputTokens: number): object {
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens,
  };
}

function respond(child: FakeCodexProcess, id: number | string | undefined, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function notify(child: FakeCodexProcess, method: string, params: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}
