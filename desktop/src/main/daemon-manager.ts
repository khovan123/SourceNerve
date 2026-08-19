import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import type {
  DaemonRuntimeState,
  DaemonSnapshot,
  DesktopRuntimeEvent,
} from "../shared/desktop-api";
import { SourceNerveClient } from "./sourcenerve-client";

const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;

export interface DaemonLaunchPlan {
  configPath: string;
  environment: NodeJS.ProcessEnv;
  redactedSecrets: string[];
}

export interface DaemonManagerOptions {
  binaryPath: string;
  expectedVersion: string;
  client: SourceNerveClient;
  onEvent?: (event: DesktopRuntimeEvent) => void;
  now?: () => Date;
}

export class DaemonManager {
  private readonly binaryPath: string;
  private readonly expectedVersion: string;
  private readonly client: SourceNerveClient;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly now: () => Date;
  private child: ChildProcessWithoutNullStreams | null = null;
  private launchPlan: DaemonLaunchPlan | null = null;
  private stopping = false;
  private snapshotValue: DaemonSnapshot = {
    state: "stopped",
    managed: false,
  };

  constructor(options: DaemonManagerOptions) {
    this.binaryPath = path.resolve(options.binaryPath);
    this.expectedVersion = options.expectedVersion;
    this.client = options.client;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
  }

  configure(plan: DaemonLaunchPlan): void {
    if (!path.isAbsolute(plan.configPath)) {
      throw new Error("managed SourceNerve config path must be absolute");
    }
    if (!plan.environment.SOURCENERVE_CONFIG) {
      throw new Error("managed SourceNerve environment is missing SOURCENERVE_CONFIG");
    }
    if (!plan.environment.SOURCENERVE_BEARER_TOKEN) {
      throw new Error("managed SourceNerve environment is missing local bearer");
    }
    this.launchPlan = {
      configPath: plan.configPath,
      environment: { ...plan.environment },
      redactedSecrets: [...plan.redactedSecrets],
    };
  }

  snapshot(): DaemonSnapshot {
    return { ...this.snapshotValue };
  }

  async start(): Promise<DaemonSnapshot> {
    if (this.child) return this.snapshot();
    if (!this.launchPlan) throw new Error("SourceNerve daemon launch plan is not configured");

    const existing = await this.probeExisting();
    if (existing) {
      this.transition({
        state: existing.compatible ? "external" : "incompatible",
        managed: false,
        version: existing.version,
        message: existing.compatible
          ? "An externally managed SourceNerve daemon is already running"
          : `Running SourceNerve version ${existing.version ?? "unknown"} is incompatible with Desktop ${this.expectedVersion}`,
      });
      return this.snapshot();
    }

    this.stopping = false;
    this.transition({ state: "starting", managed: true });
    const child = spawn(this.binaryPath, [], {
      cwd: path.dirname(this.launchPlan.configPath),
      env: buildChildEnvironment(this.launchPlan.environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.attachLogs(child, this.launchPlan.redactedSecrets);
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.transition({
        state: "crashed",
        managed: true,
        message: sanitizeLogLine(error.message, this.launchPlan?.redactedSecrets ?? []),
      });
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      const intentional = this.stopping;
      this.stopping = false;
      this.transition({
        state: intentional ? "stopped" : "crashed",
        managed: true,
        exitCode: code,
        signal: signal ?? undefined,
        message: intentional
          ? undefined
          : `SourceNerve daemon exited unexpectedly${code === null ? "" : ` with code ${code}`}`,
      });
    });

    try {
      await this.waitUntilReady();
      const version = await this.currentDaemonVersion();
      if (version !== this.expectedVersion) {
        this.transition({
          state: "incompatible",
          managed: true,
          pid: child.pid,
          version,
          message: `Bundled SourceNerve version ${version ?? "unknown"} does not match Desktop ${this.expectedVersion}`,
        });
        await this.stop();
        throw new Error("bundled SourceNerve daemon version is incompatible");
      }
      this.transition({
        state: "ready",
        managed: true,
        pid: child.pid,
        version,
      });
      return this.snapshot();
    } catch (error) {
      if (this.child === child) {
        await this.stop().catch(() => undefined);
      }
      if (this.snapshotValue.state !== "incompatible") {
        this.transition({
          state: "crashed",
          managed: true,
          message: error instanceof Error ? sanitizeLogLine(error.message, this.launchPlan.redactedSecrets) : "SourceNerve daemon failed to become ready",
        });
      }
      throw error;
    }
  }

  async stop(): Promise<DaemonSnapshot> {
    const child = this.child;
    if (!child) {
      if (this.snapshotValue.state === "external") {
        throw new Error("cannot stop an externally managed SourceNerve daemon");
      }
      this.transition({ state: "stopped", managed: false });
      return this.snapshot();
    }

    this.stopping = true;
    this.transition({
      ...this.snapshotValue,
      state: "stopping",
      managed: true,
      pid: child.pid,
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGTERM");
    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS),
    );
    if ((await Promise.race([closed.then(() => "closed" as const), timer])) === "timeout") {
      child.kill("SIGKILL");
      await closed;
    }
    this.child = null;
    this.stopping = false;
    this.transition({ state: "stopped", managed: true });
    return this.snapshot();
  }

  async restart(): Promise<DaemonSnapshot> {
    if (this.snapshotValue.state === "external") {
      throw new Error("cannot restart an externally managed SourceNerve daemon");
    }
    if (this.child) await this.stop();
    return this.start();
  }

  async attachExternal(): Promise<DaemonSnapshot> {
    if (this.child) throw new Error("managed SourceNerve daemon is already running");
    const existing = await this.probeExisting();
    if (!existing) throw new Error("no external SourceNerve daemon is available");
    if (!existing.compatible) throw new Error("external SourceNerve daemon is incompatible");
    this.transition({
      state: "external",
      managed: false,
      version: existing.version,
      message: "Attached to externally managed SourceNerve daemon",
    });
    return this.snapshot();
  }

  private async probeExisting(): Promise<{ version?: string; compatible: boolean } | null> {
    try {
      await this.client.health();
      const version = await this.currentDaemonVersion();
      return { version, compatible: version === this.expectedVersion };
    } catch {
      return null;
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("SourceNerve daemon exited during startup");
      try {
        await this.client.health();
        await this.client.readiness();
        return;
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    throw new Error(
      lastError instanceof Error
        ? `SourceNerve readiness timeout: ${lastError.message}`
        : "SourceNerve readiness timeout",
    );
  }

  private async currentDaemonVersion(): Promise<string | undefined> {
    const status = await this.client.serviceStatus();
    const identity = status.identity;
    if (!isRecord(identity)) return undefined;
    return typeof identity.version === "string" ? identity.version : undefined;
  }

  private attachLogs(child: ChildProcessWithoutNullStreams, secrets: string[]): void {
    const consume = (stream: NodeJS.ReadableStream, level: "info" | "error") => {
      const lines = readline.createInterface({ input: stream });
      lines.on("line", (line) => {
        const message = sanitizeLogLine(line, secrets);
        if (!message) return;
        this.onEvent?.({
          type: "log",
          component: "daemon",
          level,
          message,
          timestamp: this.now().toISOString(),
        });
      });
    };
    consume(child.stdout, "info");
    consume(child.stderr, "error");
  }

  private transition(snapshot: DaemonSnapshot): void {
    this.snapshotValue = { ...snapshot };
    this.onEvent?.({
      type: "state",
      component: "daemon",
      state: snapshot.state,
      message: snapshot.message,
    });
  }
}

export function resolveDaemonBinaryPath(options: {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const executable = platform === "win32" ? "sourcenerve.exe" : "sourcenerve";
  const base = options.packaged
    ? path.join(options.resourcesPath, "resources")
    : path.join(options.appPath, "resources");
  return path.join(base, "bin", `${platform}-${arch}`, executable);
}

export function buildChildEnvironment(
  runtime: NodeJS.ProcessEnv,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowedParent = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "SSH_AUTH_SOCK",
    "GIT_CONFIG_GLOBAL",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowedParent) {
    if (parent[name]) environment[name] = parent[name];
  }
  for (const [name, value] of Object.entries(runtime)) {
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function sanitizeLogLine(line: string, secrets: string[]): string {
  let sanitized = line.replace(/[\0\r]/g, " ").slice(0, 8 * 1024);
  for (const secret of secrets) {
    if (secret.length >= 8) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
  return sanitized.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
