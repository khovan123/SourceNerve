import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { Readable } from "node:stream";

import type {
  DaemonSnapshot,
  DesktopRuntimeEvent,
  ReadinessPayload,
  ServiceStatusPayload,
} from "../shared/desktop-api";

// The daemon runs network-bound preflight checks (Auth0 JWT validation,
// observability, embedding provider) before binding to the HTTP port.
// On slow or cold-start connections these can take >20 s, so allow 60 s.
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 250;
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|CREDENTIAL|BEARER|PASSWORD|PRIVATE_KEY)/i;

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface DaemonClient {
  health(): Promise<{ status: "ok" }>;
  readiness(): Promise<ReadinessPayload>;
  serviceStatus(): Promise<ServiceStatusPayload>;
}

export interface DaemonLaunchPlan {
  configPath: string;
  environment: NodeJS.ProcessEnv;
  redactedSecrets?: string[];
}

export interface DaemonManagerOptions {
  binaryPath: string;
  expectedVersion: string;
  client: DaemonClient;
  onEvent?: (event: DesktopRuntimeEvent) => void;
  now?: () => Date;
}

interface ExistingDaemonProbe {
  version?: string;
  compatible: boolean;
  authenticated: boolean;
  message?: string;
}

export class DaemonManager {
  private readonly binaryPath: string;
  private readonly expectedVersion: string;
  private readonly client: DaemonClient;
  private readonly onEvent?: (event: DesktopRuntimeEvent) => void;
  private readonly now: () => Date;
  private child: ManagedChild | null = null;
  private launchPlan: DaemonLaunchPlan | null = null;
  private stopping = false;
  private snapshotValue: DaemonSnapshot = {
    state: "stopped",
    managed: false,
  };

  constructor(options: DaemonManagerOptions) {
    this.binaryPath = path.resolve(options.binaryPath);
    if (!options.expectedVersion.trim()) {
      throw new Error("expected SourceNerve daemon version must not be blank");
    }
    this.expectedVersion = options.expectedVersion;
    this.client = options.client;
    this.onEvent = options.onEvent;
    this.now = options.now ?? (() => new Date());
  }

  configure(plan: DaemonLaunchPlan): void {
    if (!path.isAbsolute(plan.configPath)) {
      throw new Error("managed SourceNerve config path must be absolute");
    }
    if (plan.environment.SOURCENERVE_CONFIG !== plan.configPath) {
      throw new Error("managed SourceNerve environment must use the configured SOURCENERVE_CONFIG path");
    }
    if (!plan.environment.SOURCENERVE_BEARER_TOKEN) {
      throw new Error("managed SourceNerve environment is missing local bearer");
    }

    const inferredSecrets = Object.entries(plan.environment)
      .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && typeof value === "string")
      .map(([, value]) => value as string);
    this.launchPlan = {
      configPath: plan.configPath,
      environment: { ...plan.environment },
      redactedSecrets: uniqueSecrets([
        ...(plan.redactedSecrets ?? []),
        ...inferredSecrets,
        plan.configPath,
      ]),
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
      const state = existing.compatible ? "external" : "incompatible";
      this.transition({
        state,
        managed: false,
        version: existing.version,
        message:
          existing.message ??
          (existing.compatible
            ? "An externally managed SourceNerve daemon is already running"
            : `Running SourceNerve version ${existing.version ?? "unknown"} is incompatible with Desktop ${this.expectedVersion}`),
      });
      return this.snapshot();
    }

    await ensureExecutable(this.binaryPath);
    this.stopping = false;
    this.transition({ state: "starting", managed: true });

    const child = spawn(this.binaryPath, [], {
      cwd: path.dirname(this.launchPlan.configPath),
      env: buildChildEnvironment(this.launchPlan.environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const secrets = this.launchPlan.redactedSecrets ?? [];
    this.attachLogs(child, secrets);

    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.transition({
        state: "crashed",
        managed: true,
        message: sanitizeLogLine(error.message, secrets),
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
        await this.stop().catch(() => undefined);
        this.transition({
          state: "incompatible",
          managed: true,
          version,
          message: `Bundled SourceNerve version ${version ?? "unknown"} does not match Desktop ${this.expectedVersion}`,
        });
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
          message:
            error instanceof Error
              ? sanitizeLogLine(error.message, secrets)
              : "SourceNerve daemon failed to become ready",
        });
      }
      throw error;
    }
  }

  async stop(): Promise<DaemonSnapshot> {
    const child = this.child;
    if (!child) {
      if (
        !this.snapshotValue.managed &&
        (this.snapshotValue.state === "external" || this.snapshotValue.state === "incompatible")
      ) {
        throw new Error("cannot stop an externally managed or conflicting SourceNerve daemon");
      }
      this.transition({ state: "stopped", managed: this.snapshotValue.managed });
      return this.snapshot();
    }

    this.stopping = true;
    this.transition({
      ...this.snapshotValue,
      state: "stopping",
      managed: true,
      pid: child.pid,
    });

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    let closed = await waitForClose(child, STOP_TIMEOUT_MS);
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      closed = await waitForClose(child, FORCE_STOP_TIMEOUT_MS);
    }
    if (!closed && child.exitCode === null && child.signalCode === null) {
      this.stopping = false;
      this.transition({
        state: "crashed",
        managed: true,
        pid: child.pid,
        message: "SourceNerve daemon did not terminate after forced shutdown",
      });
      throw new Error("SourceNerve daemon did not terminate");
    }

    if (this.child === child) this.child = null;
    this.stopping = false;
    this.transition({ state: "stopped", managed: true });
    return this.snapshot();
  }

  async restart(): Promise<DaemonSnapshot> {
    if (
      !this.snapshotValue.managed &&
      (this.snapshotValue.state === "external" || this.snapshotValue.state === "incompatible")
    ) {
      throw new Error("cannot restart an externally managed or conflicting SourceNerve daemon");
    }
    if (this.child) await this.stop();
    return this.start();
  }

  async attachExternal(): Promise<DaemonSnapshot> {
    if (this.child) throw new Error("managed SourceNerve daemon is already running");
    const existing = await this.probeExisting();
    if (!existing) throw new Error("no external SourceNerve daemon is available");
    if (!existing.authenticated) {
      throw new Error("external SourceNerve daemon uses a different local credential");
    }
    if (!existing.compatible) throw new Error("external SourceNerve daemon is incompatible");
    this.transition({
      state: "external",
      managed: false,
      version: existing.version,
      message: "Attached to externally managed SourceNerve daemon",
    });
    return this.snapshot();
  }

  private async probeExisting(): Promise<ExistingDaemonProbe | null> {
    try {
      await this.client.health();
    } catch {
      return null;
    }

    try {
      const version = await this.currentDaemonVersion();
      return {
        version,
        compatible: version === this.expectedVersion,
        authenticated: true,
      };
    } catch {
      return {
        compatible: false,
        authenticated: false,
        message: "A process is already serving the SourceNerve health endpoint but Desktop cannot authenticate it",
      };
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("SourceNerve daemon exited during startup");
      try {
        await this.client.health();
        const readiness = await this.client.readiness();
        if (readinessIsReady(readiness)) return;
        lastError = new Error("SourceNerve readiness reported not ready");
      } catch (error) {
        lastError = error;
      }
      await sleep(POLL_INTERVAL_MS);
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

  private attachLogs(child: ManagedChild, secrets: string[]): void {
    const consume = (stream: Readable, level: "info" | "error") => {
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
  const base = options.packaged ? options.resourcesPath : path.join(options.appPath, "resources");
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
    "SOURCENERVE_DEBUG_AUTH",
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
  let sanitized = line.replace(/[\0\r]/g, " ");
  const privatePaths = [process.env.HOME, process.env.USERPROFILE].filter(
    (value): value is string => typeof value === "string" && value.length >= 8,
  );
  for (const secret of uniqueSecrets([...secrets, ...privatePaths])) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(
    /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
    "$1[REDACTED]",
  );
  sanitized = sanitized.replace(
    /([?&](?:access_token|token|credential|secret)=)[^&\s"']+/gi,
    "$1[REDACTED]",
  );
  return sanitized.slice(0, 8 * 1024).trim();
}

export function readinessIsReady(value: ReadinessPayload): boolean {
  return value.ready === true;
}

function uniqueSecrets(secrets: string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
}

async function ensureExecutable(filePath: string): Promise<void> {
  try {
    await access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
  } catch {
    throw new Error(`bundled SourceNerve daemon is unavailable: ${path.basename(filePath)}`);
  }
}

function waitForClose(child: ManagedChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
