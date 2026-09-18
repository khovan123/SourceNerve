import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import { clipboard, desktopCapturer, type DesktopCapturerSource } from "electron";

export type DesktopControlCapability = "screen" | "mouse" | "keyboard" | "clipboard";
export type DesktopControlAction = "observe" | "screenshot" | "mouse-click" | "mouse-move" | "key-press" | "type-text" | "clipboard-read" | "clipboard-write";

export interface DesktopControlPermissions {
  screen: boolean;
  mouse: boolean;
  keyboard: boolean;
  clipboard: boolean;
}

export interface DesktopInputBackendView {
  id: "none" | "xdotool" | "cliclick-osascript" | "powershell-sendinput";
  mouse: boolean;
  keyboard: boolean;
  notes: string[];
}

export interface DesktopControlState {
  enabled: boolean;
  platform: NodeJS.Platform;
  permissions: DesktopControlPermissions;
  inputBackend: DesktopInputBackendView;
  availableActions: DesktopControlAction[];
  notes: string[];
}

export interface DesktopControlObserveInput {
  includeScreenshot?: boolean;
  maxSources?: number;
}

export interface DesktopControlObservation {
  platform: NodeJS.Platform;
  sources: Array<{ id: string; name: string; thumbnailDataUrl?: string }>;
}

export interface DesktopControlCommandInput {
  action: Exclude<DesktopControlAction, "observe">;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
}

const execFileAsync = promisify(execFile);
const DEFAULT_PERMISSIONS: DesktopControlPermissions = Object.freeze({
  screen: false,
  mouse: false,
  keyboard: false,
  clipboard: false,
});

/**
 * Explicit Desktop control boundary. Nothing is available merely because the
 * bridge exists: the user must enable each capability, and mouse/keyboard are
 * additionally gated by a concrete platform backend instead of a fake fallback.
 */
export class DesktopControlBridge {
  private permissions: DesktopControlPermissions;

  constructor(options: { permissions?: Partial<DesktopControlPermissions> } = {}) {
    this.permissions = { ...DEFAULT_PERMISSIONS, ...options.permissions };
  }

  async state(): Promise<DesktopControlState> {
    const inputBackend = await detectDesktopInputBackend();
    const availableActions: DesktopControlAction[] = ["observe"];
    if (this.permissions.screen) availableActions.push("screenshot");
    if (this.permissions.clipboard) availableActions.push("clipboard-read", "clipboard-write");
    if (this.permissions.mouse && inputBackend.mouse) availableActions.push("mouse-click", "mouse-move");
    if (this.permissions.keyboard && inputBackend.keyboard) availableActions.push("key-press", "type-text");
    return {
      enabled: Object.values(this.permissions).some(Boolean),
      platform: process.platform,
      permissions: { ...this.permissions },
      inputBackend,
      availableActions,
      notes: [
        "Desktop control is explicit opt-in per capability.",
        "Screen observation uses Electron desktopCapturer only after screen permission is enabled.",
        "Mouse and keyboard actions require a concrete platform backend; otherwise the action is unavailable and fails closed.",
      ],
    };
  }

  async updatePermissions(next: Partial<DesktopControlPermissions>): Promise<DesktopControlState> {
    this.permissions = {
      screen: next.screen ?? this.permissions.screen,
      mouse: next.mouse ?? this.permissions.mouse,
      keyboard: next.keyboard ?? this.permissions.keyboard,
      clipboard: next.clipboard ?? this.permissions.clipboard,
    };
    return this.state();
  }

  async observe(input: DesktopControlObserveInput = {}): Promise<DesktopControlObservation> {
    this.require("screen", "screen observation");
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: input.includeScreenshot ? { width: 1280, height: 720 } : { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return {
      platform: process.platform,
      sources: sources.slice(0, boundMaxSources(input.maxSources)).map((source) => sourceView(source, Boolean(input.includeScreenshot))),
    };
  }

  async run(input: DesktopControlCommandInput): Promise<{ action: DesktopControlAction; status: "completed"; result?: string }> {
    switch (input.action) {
      case "screenshot": {
        const observed = await this.observe({ includeScreenshot: true, maxSources: 1 });
        return { action: input.action, status: "completed", result: observed.sources[0]?.thumbnailDataUrl ?? "" };
      }
      case "clipboard-read":
        this.require("clipboard", "clipboard read");
        return { action: input.action, status: "completed", result: clipboard.readText() };
      case "clipboard-write":
        this.require("clipboard", "clipboard write");
        clipboard.writeText(boundText(input.text ?? "", 16 * 1024));
        return { action: input.action, status: "completed" };
      case "mouse-click":
      case "mouse-move":
        this.require("mouse", input.action);
        await runMouseAction(input);
        return { action: input.action, status: "completed" };
      case "key-press":
      case "type-text":
        this.require("keyboard", input.action);
        await runKeyboardAction(input);
        return { action: input.action, status: "completed" };
      default:
        throw new Error("Unsupported desktop-control action");
    }
  }

  private require(capability: DesktopControlCapability, label: string): void {
    if (!this.permissions[capability]) throw new Error(`Desktop ${label} permission is disabled`);
  }
}

function sourceView(source: DesktopCapturerSource, includeScreenshot: boolean): { id: string; name: string; thumbnailDataUrl?: string } {
  return {
    id: source.id,
    name: source.name,
    ...(includeScreenshot && !source.thumbnail.isEmpty() ? { thumbnailDataUrl: source.thumbnail.toDataURL() } : {}),
  };
}

async function detectDesktopInputBackend(): Promise<DesktopInputBackendView> {
  if (process.platform === "linux") {
    const xdotool = await commandPath("xdotool");
    if (xdotool) return { id: "xdotool", mouse: true, keyboard: true, notes: [`Using ${xdotool} for Linux desktop input.`] };
    return { id: "none", mouse: false, keyboard: false, notes: ["Install xdotool or wire a Wayland-safe backend before enabling Linux mouse/keyboard input."] };
  }
  if (process.platform === "darwin") {
    const cliclick = await commandPath("cliclick");
    return {
      id: "cliclick-osascript",
      mouse: Boolean(cliclick),
      keyboard: true,
      notes: [cliclick ? `Using ${cliclick} for mouse and osascript for keyboard.` : "Install cliclick to enable macOS mouse input; keyboard uses osascript/System Events."],
    };
  }
  if (process.platform === "win32") {
    return { id: "powershell-sendinput", mouse: true, keyboard: true, notes: ["Using Windows PowerShell with User32/System.Windows.Forms for desktop input."] };
  }
  return { id: "none", mouse: false, keyboard: false, notes: [`No desktop input backend is defined for ${process.platform}.`] };
}

async function runMouseAction(input: DesktopControlCommandInput): Promise<void> {
  const x = boundCoordinate(input.x, "x");
  const y = boundCoordinate(input.y, "y");
  if (process.platform === "linux") {
    const xdotool = await commandPath("xdotool");
    if (!xdotool) throw new Error("Linux desktop mouse backend is unavailable: xdotool is not installed");
    const args = input.action === "mouse-click" ? ["mousemove", String(x), String(y), "click", "1"] : ["mousemove", String(x), String(y)];
    await runBackend(xdotool, args);
    return;
  }
  if (process.platform === "darwin") {
    const cliclick = await commandPath("cliclick");
    if (!cliclick) throw new Error("macOS desktop mouse backend is unavailable: cliclick is not installed");
    await runBackend(cliclick, [input.action === "mouse-click" ? `c:${x},${y}` : `m:${x},${y}`]);
    return;
  }
  if (process.platform === "win32") {
    await runWindowsMouse(input.action, x, y);
    return;
  }
  throw new Error(`Desktop mouse backend is unavailable on ${process.platform}`);
}

async function runKeyboardAction(input: DesktopControlCommandInput): Promise<void> {
  if (input.action === "type-text") {
    const text = boundText(input.text ?? "", 16 * 1024);
    if (process.platform === "linux") {
      const xdotool = await commandPath("xdotool");
      if (!xdotool) throw new Error("Linux desktop keyboard backend is unavailable: xdotool is not installed");
      await runBackend(xdotool, ["type", "--delay", "0", "--", text]);
      return;
    }
    if (process.platform === "darwin") {
      await runBackend("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
      return;
    }
    if (process.platform === "win32") {
      await runWindowsSendKeys(text);
      return;
    }
    throw new Error(`Desktop keyboard backend is unavailable on ${process.platform}`);
  }

  const key = boundKey(input.key);
  if (process.platform === "linux") {
    const xdotool = await commandPath("xdotool");
    if (!xdotool) throw new Error("Linux desktop keyboard backend is unavailable: xdotool is not installed");
    await runBackend(xdotool, ["key", "--", key]);
    return;
  }
  if (process.platform === "darwin") {
    await runBackend("osascript", ["-e", macKeyScript(key)]);
    return;
  }
  if (process.platform === "win32") {
    await runWindowsSendKeys(key);
    return;
  }
  throw new Error(`Desktop keyboard backend is unavailable on ${process.platform}`);
}

async function runWindowsMouse(action: DesktopControlAction, x: number, y: number): Promise<void> {
  const flags = action === "mouse-click" ? "0x0002; [Mouse]::mouse_event(0x0004,0,0,0,0);" : "";
  await runBackend("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -Name Mouse -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(int flags,int dx,int dy,int data,int extra);'; [Native.Mouse]::SetCursorPos(${x}, ${y}) | Out-Null; ${flags}`]);
}

async function runWindowsSendKeys(value: string): Promise<void> {
  await runBackend("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($args[0])", value]);
}

function macKeyScript(key: string): string {
  if (key.length === 1) return `tell application "System Events" to keystroke ${JSON.stringify(key)}`;
  return `tell application "System Events" to key code ${macKeyCode(key)}`;
}

function macKeyCode(key: string): number {
  const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 117, left: 123, right: 124, down: 125, up: 126 };
  const code = codes[key.toLowerCase()];
  if (code === undefined) throw new Error(`Unsupported macOS key: ${key}`);
  return code;
}

async function commandPath(command: string): Promise<string | null> {
  if (process.platform === "win32") return command;
  const common = [`/usr/bin/${command}`, `/bin/${command}`, `/usr/local/bin/${command}`, `/opt/homebrew/bin/${command}`];
  for (const candidate of common) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  try {
    const result = await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], { timeout: 2_000, maxBuffer: 4096, windowsHide: true });
    const found = result.stdout.trim().split(/\r?\n/)[0];
    return found || null;
  } catch {
    return null;
  }
}

async function runBackend(program: string, args: string[]): Promise<void> {
  await execFileAsync(program, args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
}

function boundMaxSources(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 20 ? Number(value) : 8;
}

function boundCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100_000) throw new Error(`Desktop mouse ${label} coordinate is invalid`);
  return Number(value);
}

function boundKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || !/^[A-Za-z0-9_+:. -]+$/.test(value)) throw new Error("Desktop key value is invalid");
  return value;
}

function boundText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
