import { spawn, type ChildProcessByStdio } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import type { DesktopRuntimeEvent } from "../shared/desktop-api";

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_LOG_LINE = 4096;

type ManagedCloudflaredProcess = ChildProcessByStdio<null, Readable, Readable>;

export type CloudflaredRuntimeState = "stopped" | "starting" | "running" | "stopping" | "crashed";
export interface CloudflaredSnapshot {
  state: CloudflaredRuntimeState;
  managed: boolean;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
}

export class CloudflaredManager {
  private readonly binaryPath: string;
  private readonly onEvent: (event: DesktopRuntimeEvent) => void;
  private child: ManagedCloudflaredProcess | null = null;
  private current: CloudflaredSnapshot = { state: "stopped", managed: true };
  private token: string | null = null;

  constructor(options: { binaryPath: string; onEvent: (event: DesktopRuntimeEvent) => void }) {
    this.binaryPath = options.binaryPath;
    this.onEvent = options.onEvent;
  }

  snapshot(): CloudflaredSnapshot { return { ...this.current }; }

  async start(tunnelToken: string): Promise<CloudflaredSnapshot> {
    if (!validTunnelToken(tunnelToken)) throw new Error("Cloudflare tunnel credential is invalid");
    if (this.child && (this.current.state === "running" || this.current.state === "starting")) {
      if (this.token === tunnelToken) return this.snapshot();
      await this.stop();
    }
    await access(this.binaryPath);
    this.token = tunnelToken;
    this.setState({ state: "starting", managed: true });

    const child = spawn(
      this.binaryPath,
      ["tunnel", "--no-autoupdate", "--loglevel", "warn", "run"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: cloudflaredEnvironment(tunnelToken),
      },
    );
    this.child = child;
    this.attachLogs(child.stdout, "info");
    this.attachLogs(child.stderr, "warn");

    const started = new Promise<CloudflaredSnapshot>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("cloudflared startup timeout"));
      }, START_TIMEOUT_MS);
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.setState({ state: "running", managed: true, pid: child.pid });
        resolve(this.snapshot());
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
    });

    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.token = null;
      const stopping = this.current.state === "stopping";
      this.setState({
        state: stopping ? "stopped" : "crashed",
        managed: true,
        exitCode: code,
        signal,
        ...(stopping ? {} : { message: "Managed Cloudflare Tunnel process exited unexpectedly" }),
      });
    });

    try {
      return await started;
    } catch (error) {
      if (this.child === child) {
        child.kill();
        this.child = null;
      }
      this.token = null;
      this.setState({ state: "crashed", managed: true, message: safeMessage(error) });
      throw error;
    }
  }

  async restart(tunnelToken: string): Promise<CloudflaredSnapshot> {
    await this.stop();
    return this.start(tunnelToken);
  }

  async stop(): Promise<CloudflaredSnapshot> {
    const child = this.child;
    if (!child) {
      this.token = null;
      this.setState({ state: "stopped", managed: true });
      return this.snapshot();
    }
    if (this.current.state === "stopping") return this.snapshot();
    this.setState({ state: "stopping", managed: true, pid: child.pid });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish();
      }, STOP_TIMEOUT_MS);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
    if (this.child === child) this.child = null;
    this.token = null;
    this.setState({ state: "stopped", managed: true });
    return this.snapshot();
  }

  private attachLogs(stream: NodeJS.ReadableStream, level: "info" | "warn"): void {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.publishLog(level, line);
      }
      if (buffer.length > MAX_LOG_LINE * 2) {
        this.publishLog(level, buffer.slice(0, MAX_LOG_LINE));
        buffer = "";
      }
    });
  }

  private publishLog(level: "info" | "warn", raw: string): void {
    const line = sanitizeCloudflaredLog(raw, this.token).slice(0, MAX_LOG_LINE).trim();
    if (!line) return;
    this.onEvent({
      type: "log",
      component: "public-mcp",
      level,
      message: line,
      timestamp: new Date().toISOString(),
    });
  }

  private setState(snapshot: CloudflaredSnapshot): void {
    this.current = snapshot;
    this.onEvent({
      type: "state",
      component: "public-mcp",
      state: snapshot.state,
      message: snapshot.message,
    });
  }
}

export function resolveCloudflaredBinaryPath(options: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return options.packaged
    ? path.join(options.resourcesPath, "bin", executable)
    : path.join(options.appPath, "resources", "bin", executable);
}

function cloudflaredEnvironment(token: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { TUNNEL_TOKEN: token, NO_AUTOUPDATE: "true" };
  for (const name of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function validTunnelToken(value: string): boolean {
  return value.length >= 20 && value.length <= 32 * 1024 && /^[\x21-\x7e]+$/.test(value);
}

function sanitizeCloudflaredLog(value: string, token: string | null): string {
  let result = value.replace(/[\r\0]/g, " ");
  if (token) result = result.split(token).join("[REDACTED]");
  result = result
    .replace(/(token|credential|secret)=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9._~-]{20,}/g, "[REDACTED]");
  return result;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "cloudflared operation failed";
  return message.replace(/[\r\n\0]/g, " ").slice(0, 512).trim() || "cloudflared operation failed";
}
