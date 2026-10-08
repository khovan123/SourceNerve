import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import { app } from "electron";

const HELPER_REQUEST_LIMIT = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SESSION_REQUEST_TIMEOUT_MS = 130_000;
const PROBE_CACHE_MS = 30_000;

export interface WaylandPortalProbe {
  availableDeviceTypes: number;
  version: number;
  keyboard: boolean;
  pointer: boolean;
  screenCastMonitor: boolean;
  screenCastVersion: number;
}

export interface WaylandPortalStream {
  nodeId: number;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

export interface WaylandPortalSession {
  devices: number;
  streams: WaylandPortalStream[];
}

interface HelperResponse {
  id: number | null;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Maintains one helper process and therefore one D-Bus connection. XDG
 * RemoteDesktop sessions are scoped to the caller connection and cannot be
 * implemented correctly by issuing separate one-shot gdbus commands.
 */
export class WaylandRemoteDesktopPortal {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrTail = "";
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private probeCache: { at: number; value: WaylandPortalProbe } | null = null;

  async probe(): Promise<WaylandPortalProbe> {
    if (this.probeCache && Date.now() - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.value;
    }
    const value = await this.request("probe", {}, DEFAULT_REQUEST_TIMEOUT_MS);
    const probe = parseProbe(value);
    this.probeCache = { at: Date.now(), value: probe };
    return probe;
  }

  async ensureSession(): Promise<WaylandPortalSession> {
    return parseSession(await this.request("ensure_session", {}, SESSION_REQUEST_TIMEOUT_MS));
  }

  async pointerMotion(dx: number, dy: number): Promise<void> {
    await this.request("pointer_motion", { dx, dy }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async pointerMotionAbsolute(stream: number, x: number, y: number): Promise<void> {
    await this.request("pointer_motion_absolute", { stream, x, y }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async clickLeft(): Promise<void> {
    await this.request("click_left", {}, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async keySequence(events: Array<{ code: number; state: 0 | 1 }>): Promise<void> {
    await this.request("key_sequence", { events }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async keysymSequence(events: Array<{ keysym: number; state: 0 | 1 }>): Promise<void> {
    await this.request("keysym_sequence", { events }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  async typeText(text: string): Promise<void> {
    await this.request("type_text", { text }, Math.max(DEFAULT_REQUEST_TIMEOUT_MS, Math.min(60_000, text.length * 20)));
  }

  async closeSession(): Promise<void> {
    if (!this.child) return;
    await this.request("close", {}, DEFAULT_REQUEST_TIMEOUT_MS).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.request("shutdown", {}, 2_000).catch(() => undefined);
    if (this.child === child) {
      child.kill("SIGTERM");
      this.resetChild(new Error("Wayland RemoteDesktop helper stopped"));
    }
  }

  private async request(operation: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = await this.ensureChild();
    const id = this.nextId++;
    const encoded = JSON.stringify({ id, op: operation, ...payload });
    if (Buffer.byteLength(encoded, "utf8") > HELPER_REQUEST_LIMIT) {
      throw new Error("Wayland RemoteDesktop helper request exceeds the bounded payload limit");
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Wayland RemoteDesktop helper ${operation} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${encoded}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private async ensureChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return this.child;
    if (this.startPromise) return this.startPromise;
    const pending = this.spawnChild().finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  private async spawnChild(): Promise<ChildProcessWithoutNullStreams> {
    const helperPath = resolvePortalHelperPath();
    const child = spawn("python3", [helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    this.stderrTail = "";

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4096);
    });

    const startup = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve(child);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    child.once("close", (code, signal) => {
      lines.close();
      const details = this.stderrTail.trim();
      this.resetChild(new Error(
        `Wayland RemoteDesktop helper exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}${details ? `: ${details}` : ""}`,
      ));
    });

    return startup;
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > HELPER_REQUEST_LIMIT) return;
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      return;
    }
    if (!Number.isSafeInteger(response.id)) return;
    const id = Number(response.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.slice(0, 1024) || "Wayland RemoteDesktop helper request failed"));
  }

  private resetChild(error: Error): void {
    this.child = null;
    this.probeCache = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function parseProbe(value: unknown): WaylandPortalProbe {
  if (!isRecord(value)) throw new Error("Wayland RemoteDesktop helper returned an invalid probe");
  const availableDeviceTypes = Number(value.availableDeviceTypes);
  const version = Number(value.version);
  if (!Number.isSafeInteger(availableDeviceTypes) || availableDeviceTypes < 0 || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("Wayland RemoteDesktop helper returned invalid device metadata");
  }
  const screenCastVersion = Number(value.screenCastVersion);
  if (!Number.isSafeInteger(screenCastVersion) || screenCastVersion < 1) {
    throw new Error("Wayland RemoteDesktop helper returned invalid ScreenCast metadata");
  }
  return {
    availableDeviceTypes,
    version,
    keyboard: value.keyboard === true,
    pointer: value.pointer === true,
    screenCastMonitor: value.screenCastMonitor === true,
    screenCastVersion,
  };
}

export function parseSession(value: unknown): WaylandPortalSession {
  if (!isRecord(value)) throw new Error("Wayland RemoteDesktop helper returned an invalid session");
  const devices = Number(value.devices);
  if (!Number.isSafeInteger(devices) || devices < 0 || !Array.isArray(value.streams)) {
    throw new Error("Wayland RemoteDesktop helper returned invalid session metadata");
  }
  const streams = value.streams.map((stream) => parseStream(stream));
  if (streams.length < 1) throw new Error("Wayland RemoteDesktop session has no monitor streams");
  return { devices, streams };
}

function parseStream(value: unknown): WaylandPortalStream {
  if (!Array.isArray(value) || value.length < 2 || !isRecord(value[1])) {
    throw new Error("Wayland RemoteDesktop helper returned an invalid monitor stream");
  }
  const nodeId = Number(value[0]);
  if (!Number.isSafeInteger(nodeId) || nodeId < 0) throw new Error("Wayland RemoteDesktop stream id is invalid");
  const properties = value[1];
  const position = parsePair(properties.position);
  const size = parsePair(properties.size);
  return {
    nodeId,
    ...(position ? { position: { x: position[0], y: position[1] } } : {}),
    ...(size && size[0] > 0 && size[1] > 0 ? { size: { width: size[0], height: size[1] } } : {}),
  };
}

function parsePair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const first = Number(value[0]);
  const second = Number(value[1]);
  return Number.isFinite(first) && Number.isFinite(second) ? [first, second] : null;
}

function resolvePortalHelperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "portal", "remote-desktop-helper.py")
    : path.join(app.getAppPath(), "resources", "portal", "remote-desktop-helper.py");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
