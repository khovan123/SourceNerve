import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourceNerveClient, SourceNerveHttpError } from "../main/sourcenerve-client";

const WORKSPACE_ID = "desktop-integration";
const INITIAL_BEARER = "desktop-integration-bearer-a-0123456789abcdef";
const ROTATED_BEARER = "desktop-integration-bearer-b-0123456789abcdef";

let fixtureRoot = "";
let configPath = "";
let daemon: ChildProcessWithoutNullStreams | null = null;
let baseUrl = "";
let daemonLogs = "";
let taskId = "";

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "sourcenerve-desktop-integration-"));
  const repo = path.join(fixtureRoot, "repo");
  const remote = path.join(fixtureRoot, "remote.git");
  const state = path.join(fixtureRoot, "state");
  await Promise.all([mkdir(repo), mkdir(remote), mkdir(state)]);

  git(["init", "--bare"], remote);
  git(["init", "-b", "main"], repo);
  git(["config", "user.name", "SourceNerve Desktop CI"], repo);
  git(["config", "user.email", "desktop-ci@example.invalid"], repo);
  await writeFile(path.join(repo, "lib.rs"), "pub fn desktop_integration() -> bool { true }\n", "utf8");
  git(["add", "lib.rs"], repo);
  git(["commit", "-m", "desktop integration fixture"], repo);
  git(["remote", "add", "origin", remote], repo);
  git(["push", "-u", "origin", "main"], repo);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  configPath = path.join(fixtureRoot, "sourcenerve.toml");
  await writeFile(
    configPath,
    [
      "[server]",
      `bind = ${tomlString(`127.0.0.1:${port}`)}`,
      "",
      "[storage]",
      `state_dir = ${tomlString(state)}`,
      "",
      "[auth]",
      'bearer_token = "placeholder-overridden-by-child-env"',
      "",
      "[[workspace]]",
      `id = ${tomlString(WORKSPACE_ID)}`,
      'name = "Desktop Integration"',
      `root = ${tomlString(repo)}`,
      'access = "read-write"',
      'remote = "origin"',
      'default_branch = "main"',
      "",
    ].join("\n"),
    "utf8",
  );

  daemon = startDaemon(INITIAL_BEARER);
  await waitUntilReady(INITIAL_BEARER);
  await clientFor(INITIAL_BEARER).indexWorkspace(WORKSPACE_ID);
});

afterAll(async () => {
  await stopDaemon();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe("Desktop real-daemon integration", () => {
  it("indexes a temporary repository and exposes graph/readiness through the Desktop client", async () => {
    const client = clientFor(INITIAL_BEARER);

    await expect(client.health()).resolves.toEqual({ status: "ok" });
    await expect(client.listWorkspaces()).resolves.toEqual([
      { id: WORKSPACE_ID, name: "Desktop Integration", writable: true },
    ]);

    const before = await client.workspaceSnapshot(WORKSPACE_ID);
    expect(before.dirty).toBe(false);
    expect(before.head).toMatch(/^[0-9a-f]{40}$/);

    const indexed = await client.indexWorkspace(WORKSPACE_ID);
    expect(indexed.workspace).toBe(WORKSPACE_ID);
    expect(indexed.head).toBe(before.head);
    expect(indexed.indexedTextFiles).toBeGreaterThan(0);

    const graph = await client.workspaceGraphStatus(WORKSPACE_ID);
    expect(graph.indexedHead).toBe(before.head);
    expect(graph.graphVersion).toBeGreaterThan(0);
    expect(graph.parsedFiles).toBeGreaterThan(0);

    const readiness = await client.readiness();
    expect(readiness.ready).toBe(true);

    const search = await client.intelligenceRequest("/api/v1/search", {
      workspace: WORKSPACE_ID,
      query: "desktop_integration",
      limit: 10,
    });
    expect(search).toMatchObject({ truncated: false });
    expect(Array.isArray((search as { hits?: unknown[] }).hits)).toBe(true);
    expect((search as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
  });

  it("persists durable task state across a real daemon restart", async () => {
    const client = clientFor(INITIAL_BEARER);
    const begun = await client.taskRequest("/api/v1/tasks/begin", {
      workspace: WORKSPACE_ID,
      client_request_id: "desktop-integration:task",
      context_query: "desktop_integration",
      context_max_bytes: 4096,
      context_max_items: 5,
    }) as { task: { id: string; base_head: string; graph_version: number }; replayed: boolean };

    taskId = begun.task.id;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(begun.replayed).toBe(false);

    await stopDaemon();
    daemon = startDaemon(INITIAL_BEARER);
    await waitUntilReady(INITIAL_BEARER);

    const recovered = await client.taskRequest("/api/v1/tasks/get", { task_id: taskId }) as {
      task: { id: string; status: string };
      lifecycle: { phase: string };
    };
    expect(recovered.task.id).toBe(taskId);
    expect(recovered.task.status).toBe("active");
    expect(recovered.lifecycle.phase).toBe("snapshot");
  });

  it("rotates the per-install bearer without writing either credential to TOML", async () => {
    await stopDaemon();
    daemon = startDaemon(ROTATED_BEARER);
    await waitUntilReady(ROTATED_BEARER);

    const oldClient = clientFor(INITIAL_BEARER);
    await expect(oldClient.serviceStatus()).rejects.toMatchObject({
      name: "SourceNerveHttpError",
      status: 401,
    } satisfies Partial<SourceNerveHttpError>);

    const rotatedClient = clientFor(ROTATED_BEARER);
    const status = await rotatedClient.serviceStatus();
    expect(status.identity).toBeTruthy();
    const recovered = await rotatedClient.taskRequest("/api/v1/tasks/get", { task_id: taskId }) as {
      task: { id: string };
    };
    expect(recovered.task.id).toBe(taskId);

    const config = await readFile(configPath, "utf8");
    expect(config).not.toContain(INITIAL_BEARER);
    expect(config).not.toContain(ROTATED_BEARER);
  });
});

function clientFor(bearer: string): SourceNerveClient {
  return new SourceNerveClient({
    baseUrl,
    getBearer: async () => bearer,
    timeoutMs: 5_000,
  });
}

function startDaemon(bearer: string): ChildProcessWithoutNullStreams {
  const binary = path.resolve(
    process.cwd(),
    "..",
    "target",
    "debug",
    process.platform === "win32" ? "sourcenerve.exe" : "sourcenerve",
  );
  daemonLogs = "";
  const child = spawn(binary, [], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      SOURCENERVE_CONFIG: configPath,
      SOURCENERVE_BEARER_TOKEN: bearer,
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => captureLog(chunk));
  child.stderr.on("data", (chunk) => captureLog(chunk));
  return child;
}

function captureLog(chunk: Buffer): void {
  daemonLogs = `${daemonLogs}${chunk.toString("utf8")}`.slice(-64 * 1024);
}

async function waitUntilReady(bearer: string): Promise<void> {
  const client = clientFor(bearer);
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (daemon?.exitCode !== null) {
      throw new Error(`SourceNerve integration daemon exited early (${daemon?.exitCode})\n${daemonLogs}`);
    }
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`SourceNerve integration daemon did not become ready: ${String(lastError)}\n${daemonLogs}`);
}

async function stopDaemon(): Promise<void> {
  const child = daemon;
  daemon = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate integration test port")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
