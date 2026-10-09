import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { clipboard, desktopCapturer, screen, type DesktopCapturerSource, type Display, type NativeImage } from "electron";

import { WaylandRemoteDesktopPortal, type WaylandPortalStream } from "./desktop-control-wayland-portal";
import {
  launchNativeApplication,
  listNativeApplications,
  nativeApplicationLauncherAvailable,
  type DesktopNativeApplication,
  type NativeApplicationListInput,
} from "./desktop-control-native-apps";

export type DesktopControlCapability = "screen" | "mouse" | "keyboard" | "clipboard";
export type DesktopControlAction = "observe" | "screenshot" | "applications-list" | "application-launch" | "mouse-click" | "mouse-move" | "key-press" | "type-text" | "clipboard-read" | "clipboard-write";

export interface DesktopControlPermissions {
  screen: boolean;
  mouse: boolean;
  keyboard: boolean;
  clipboard: boolean;
}

export interface DesktopInputBackendView {
  id: "none" | "wayland-portal" | "xdotool" | "ydotool" | "cliclick-osascript" | "powershell-sendinput";
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
  sources: Array<{ id: string; name: string; displayId?: string; thumbnailDataUrl?: string }>;
}

export interface DesktopControlScreenshot {
  dataUrl: string;
  mimeType: "image/png";
  sourceId: string;
  sourceName: string;
  displayId: string;
  bounds: { x: number; y: number; width: number; height: number };
  imageSize: { width: number; height: number };
  scaleFactor: number;
}

export interface DesktopControlCommandInput {
  action: Exclude<DesktopControlAction, "observe">;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  coordinateSpace?: "screen" | "last-screenshot";
  displayId?: string;
}

interface ScreenshotGeometry {
  displayId: string;
  bounds: { x: number; y: number; width: number; height: number };
  imageSize: { width: number; height: number };
}

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_DATA_URL_BYTES = 1_700_000;
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
  private lastScreenshotGeometry: ScreenshotGeometry | null = null;
  private readonly waylandPortal = new WaylandRemoteDesktopPortal();

  constructor(options: { permissions?: Partial<DesktopControlPermissions> } = {}) {
    this.permissions = { ...DEFAULT_PERMISSIONS, ...options.permissions };
  }

  async state(): Promise<DesktopControlState> {
    const inputBackend = this.permissions.mouse || this.permissions.keyboard
      ? await detectDesktopInputBackend(this.waylandPortal)
      : disabledInputBackend();
    const applicationLauncher = this.permissions.screen
      ? await nativeApplicationLauncherAvailable()
      : false;
    const availableActions: DesktopControlAction[] = [];
    if (this.permissions.screen) availableActions.push("observe", "screenshot");
    if (this.permissions.screen && applicationLauncher) availableActions.push("applications-list");
    if (this.permissions.screen && this.permissions.keyboard && applicationLauncher) availableActions.push("application-launch");
    if (this.permissions.clipboard) availableActions.push("clipboard-read", "clipboard-write");
    if (this.permissions.mouse && inputBackend.mouse) availableActions.push("mouse-click", "mouse-move");
    if (this.permissions.keyboard && inputBackend.keyboard) availableActions.push("key-press", "type-text");
    return {
      enabled: availableActions.length > 0,
      platform: process.platform,
      permissions: { ...this.permissions },
      inputBackend,
      availableActions,
      notes: [
        "Desktop control is explicit opt-in per capability.",
        "Screen observation uses Electron desktopCapturer only after screen permission is enabled.",
        "Mouse and keyboard actions require a concrete platform backend; otherwise the action is unavailable and fails closed.",
        "Native application discovery requires screen permission; launch additionally requires keyboard permission and only accepts an installed application id returned by discovery.",
      ],
    };
  }

  async updatePermissions(next: Partial<DesktopControlPermissions>): Promise<DesktopControlState> {
    const previous = this.permissions;
    this.permissions = {
      screen: next.screen ?? this.permissions.screen,
      mouse: next.mouse ?? this.permissions.mouse,
      keyboard: next.keyboard ?? this.permissions.keyboard,
      clipboard: next.clipboard ?? this.permissions.clipboard,
    };
    if ((previous.mouse || previous.keyboard) && !this.permissions.mouse && !this.permissions.keyboard) {
      await this.waylandPortal.stop();
    }
    return this.state();
  }

  async close(): Promise<void> {
    await this.waylandPortal.stop();
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

  async listApplications(input: NativeApplicationListInput = {}): Promise<{
    platform: NodeJS.Platform;
    applications: DesktopNativeApplication[];
  }> {
    this.require("screen", "native application discovery");
    if (!await nativeApplicationLauncherAvailable()) {
      throw new Error(`Native application discovery is unavailable on ${process.platform}`);
    }
    return {
      platform: process.platform,
      applications: await listNativeApplications(input),
    };
  }

  async launchApplication(applicationId: string): Promise<{ application: DesktopNativeApplication }> {
    this.require("screen", "native application launch");
    this.require("keyboard", "native application launch");
    if (!await nativeApplicationLauncherAvailable()) {
      throw new Error(`Native application launch is unavailable on ${process.platform}`);
    }
    return { application: await launchNativeApplication(applicationId) };
  }

  async run(input: DesktopControlCommandInput): Promise<{ action: DesktopControlAction; status: "completed"; result?: string | DesktopControlScreenshot }> {
    switch (input.action) {
      case "screenshot": {
        return { action: input.action, status: "completed", result: await this.captureScreenshot(input.displayId) };
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
        await runMouseAction(input, this.lastScreenshotGeometry, this.waylandPortal);
        return { action: input.action, status: "completed" };
      case "key-press":
      case "type-text":
        this.require("keyboard", input.action);
        await runKeyboardAction(input, this.waylandPortal);
        return { action: input.action, status: "completed" };
      default:
        throw new Error("Unsupported desktop-control action");
    }
  }

  private require(capability: DesktopControlCapability, label: string): void {
    if (!this.permissions[capability]) throw new Error(`Desktop ${label} permission is disabled`);
  }

  private async captureScreenshot(requestedDisplayId?: string): Promise<DesktopControlScreenshot> {
    this.require("screen", "screenshot");
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: false,
    });
    const targetDisplayId = requestedDisplayId?.trim() || String(primary.id);
    const matchedSource = sources.find((candidate) => candidate.display_id === targetDisplayId);
    const source = matchedSource ?? (!requestedDisplayId && displays.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(`Desktop screenshot source is unavailable for display ${targetDisplayId}`);
    }
    const display = displayForSource(source, displays, primary);
    const encoded = encodeScreenshotWithinBudget(source.thumbnail);
    if (encoded.imageSize.width < 1 || encoded.imageSize.height < 1 || display.bounds.width < 1 || display.bounds.height < 1) {
      throw new Error("Desktop screenshot geometry is invalid");
    }
    const screenshot: DesktopControlScreenshot = {
      dataUrl: encoded.dataUrl,
      mimeType: "image/png",
      sourceId: source.id,
      sourceName: source.name,
      displayId: source.display_id || String(display.id),
      bounds: { ...display.bounds },
      imageSize: encoded.imageSize,
      scaleFactor: display.scaleFactor,
    };
    this.lastScreenshotGeometry = {
      displayId: screenshot.displayId,
      bounds: { ...screenshot.bounds },
      imageSize: { ...screenshot.imageSize },
    };
    return screenshot;
  }
}

function encodeScreenshotWithinBudget(image: NativeImage): { dataUrl: string; imageSize: { width: number; height: number } } {
  let current = image;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const imageSize = current.getSize();
    if (imageSize.width < 1 || imageSize.height < 1) throw new Error("Desktop screenshot image is empty");
    const dataUrl = current.toDataURL();
    const encodedBytes = Buffer.byteLength(dataUrl, "utf8");
    if (encodedBytes <= MAX_SCREENSHOT_DATA_URL_BYTES) return { dataUrl, imageSize };

    const budgetRatio = Math.sqrt(MAX_SCREENSHOT_DATA_URL_BYTES / encodedBytes) * 0.9;
    const ratio = Math.min(0.8, Math.max(0.35, budgetRatio));
    const width = Math.max(192, Math.floor(imageSize.width * ratio));
    const height = Math.max(108, Math.floor(imageSize.height * ratio));
    if (width >= imageSize.width || height >= imageSize.height) break;
    current = current.resize({ width, height, quality: "good" });
  }
  throw new Error("Desktop screenshot could not be reduced to the bounded MCP payload size");
}

function sourceView(source: DesktopCapturerSource, includeScreenshot: boolean): { id: string; name: string; displayId?: string; thumbnailDataUrl?: string } {
  return {
    id: source.id,
    name: source.name,
    ...(source.display_id ? { displayId: source.display_id } : {}),
    ...(includeScreenshot && !source.thumbnail.isEmpty() ? { thumbnailDataUrl: source.thumbnail.toDataURL() } : {}),
  };
}

function disabledInputBackend(): DesktopInputBackendView {
  return {
    id: "none",
    mouse: false,
    keyboard: false,
    notes: ["Native input backend discovery starts only after mouse or keyboard permission is explicitly enabled."],
  };
}

function displayForSource(source: DesktopCapturerSource, displays: Display[], fallback: Display): Display {
  if (source.display_id) {
    const matched = displays.find((display) => String(display.id) === source.display_id);
    if (matched) return matched;
  }
  if (displays.length === 1) return displays[0] ?? fallback;
  throw new Error("Desktop screenshot source cannot be matched safely to a display");
}

async function detectDesktopInputBackend(portal: WaylandRemoteDesktopPortal): Promise<DesktopInputBackendView> {
  if (process.platform === "linux") {
    const backend = await resolveLinuxInputBackend(portal);
    if (backend?.id === "wayland-portal") {
      return {
        id: "wayland-portal",
        mouse: true,
        keyboard: true,
        notes: ["Using XDG RemoteDesktop + ScreenCast portals for Wayland mouse and keyboard input. The OS will request consent when an input action starts a session."],
      };
    }
    if (backend?.id === "ydotool") {
      return {
        id: "ydotool",
        mouse: true,
        keyboard: true,
        notes: [`Using ${backend.path} with ${backend.socketPath} for Linux desktop input.`],
      };
    }
    if (backend?.id === "xdotool") {
      return { id: "xdotool", mouse: true, keyboard: true, notes: [`Using ${backend.path} for X11 desktop input.`] };
    }
    return {
      id: "none",
      mouse: false,
      keyboard: false,
      notes: [isWaylandSession()
        ? "Wayland computer use requires the XDG RemoteDesktop portal or ydotool plus a user-accessible ydotoold socket."
        : "Install xdotool, or configure ydotool plus ydotoold, before enabling Linux mouse/keyboard input."],
    };
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

async function runMouseAction(
  input: DesktopControlCommandInput,
  screenshot: ScreenshotGeometry | null,
  portal: WaylandRemoteDesktopPortal,
): Promise<void> {
  const { x, y } = resolveMousePoint(input, screenshot);
  if (process.platform === "linux") {
    const backend = await resolveLinuxInputBackend(portal);
    if (!backend) throw new Error("Linux desktop mouse backend is unavailable");
    if (backend.id === "wayland-portal") {
      const session = await portal.ensureSession();
      const target = resolvePortalPointerTarget(input, screenshot, session.streams);
      await portal.pointerMotionAbsolute(target.stream, target.x, target.y);
      if (input.action === "mouse-click") await portal.clickLeft();
      return;
    }
    if (backend.id === "ydotool") {
      await runBackend(backend.path, ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], ydotoolEnvironment(backend.socketPath));
      if (input.action === "mouse-click") await runBackend(backend.path, ["click", "0xC0"], ydotoolEnvironment(backend.socketPath));
      return;
    }
    const args = input.action === "mouse-click" ? ["mousemove", String(x), String(y), "click", "1"] : ["mousemove", String(x), String(y)];
    await runBackend(backend.path, args);
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

function resolveMousePoint(input: DesktopControlCommandInput, screenshot: ScreenshotGeometry | null): { x: number; y: number } {
  if (input.coordinateSpace === "last-screenshot") {
    if (!screenshot) throw new Error("Capture a desktop screenshot before using screenshot-relative mouse coordinates");
    return mapScreenshotPoint(input.x, input.y, screenshot);
  }
  return {
    x: boundScreenCoordinate(input.x, "x"),
    y: boundScreenCoordinate(input.y, "y"),
  };
}

export function mapScreenshotPoint(
  xValue: unknown,
  yValue: unknown,
  geometry: ScreenshotGeometry,
): { x: number; y: number } {
  const x = boundImageCoordinate(xValue, geometry.imageSize.width, "x");
  const y = boundImageCoordinate(yValue, geometry.imageSize.height, "y");
  const right = geometry.bounds.x + geometry.bounds.width - 1;
  const bottom = geometry.bounds.y + geometry.bounds.height - 1;
  return {
    x: clamp(geometry.bounds.x + Math.floor((x * geometry.bounds.width) / geometry.imageSize.width), geometry.bounds.x, right),
    y: clamp(geometry.bounds.y + Math.floor((y * geometry.bounds.height) / geometry.imageSize.height), geometry.bounds.y, bottom),
  };
}

export function mapScreenshotPointToPortal(
  xValue: unknown,
  yValue: unknown,
  geometry: ScreenshotGeometry,
  streams: WaylandPortalStream[],
): { stream: number; x: number; y: number } {
  const imageX = boundImageCoordinate(xValue, geometry.imageSize.width, "x");
  const imageY = boundImageCoordinate(yValue, geometry.imageSize.height, "y");
  const centerX = geometry.bounds.x + geometry.bounds.width / 2;
  const centerY = geometry.bounds.y + geometry.bounds.height / 2;
  const exactOrigin = streams.find((stream) => stream.position
    && stream.position.x === geometry.bounds.x
    && stream.position.y === geometry.bounds.y);
  const containsCenter = streams.find((stream) => stream.position && stream.size
    && centerX >= stream.position.x
    && centerY >= stream.position.y
    && centerX < stream.position.x + stream.size.width
    && centerY < stream.position.y + stream.size.height);
  const target = exactOrigin ?? containsCenter ?? (streams.length === 1 ? streams[0] : undefined);
  if (!target?.size) {
    throw new Error("Wayland portal monitor stream could not be matched to the captured display");
  }
  return {
    stream: target.nodeId,
    x: clamp((imageX * target.size.width) / geometry.imageSize.width, 0, Math.max(0, target.size.width - 1)),
    y: clamp((imageY * target.size.height) / geometry.imageSize.height, 0, Math.max(0, target.size.height - 1)),
  };
}

function resolvePortalPointerTarget(
  input: DesktopControlCommandInput,
  screenshot: ScreenshotGeometry | null,
  streams: WaylandPortalStream[],
): { stream: number; x: number; y: number } {
  if (input.coordinateSpace === "last-screenshot") {
    if (!screenshot) throw new Error("Capture a desktop screenshot before using screenshot-relative mouse coordinates");
    return mapScreenshotPointToPortal(input.x, input.y, screenshot, streams);
  }
  const x = boundScreenCoordinate(input.x, "x");
  const y = boundScreenCoordinate(input.y, "y");
  const target = streams.find((stream) => stream.position && stream.size
    && x >= stream.position.x
    && y >= stream.position.y
    && x < stream.position.x + stream.size.width
    && y < stream.position.y + stream.size.height);
  if (!target?.position || !target.size) {
    throw new Error("Wayland portal monitor stream could not be matched to the requested screen coordinates");
  }
  return { stream: target.nodeId, x: x - target.position.x, y: y - target.position.y };
}

async function runKeyboardAction(input: DesktopControlCommandInput, portal: WaylandRemoteDesktopPortal): Promise<void> {
  if (input.action === "type-text") {
    const text = boundText(input.text ?? "", 16 * 1024);
    if (process.platform === "linux") {
      const backend = await resolveLinuxInputBackend(portal);
      if (!backend) throw new Error("Linux desktop keyboard backend is unavailable");
      if (backend.id === "wayland-portal") {
        await portal.ensureSession();
        await portal.typeText(text);
      } else if (backend.id === "ydotool") {
        await runBackend(backend.path, ["type", text], ydotoolEnvironment(backend.socketPath));
      } else {
        await runBackend(backend.path, ["type", "--delay", "0", "--", text]);
      }
      return;
    }
    if (process.platform === "darwin") {
      await runBackend("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
      return;
    }
    if (process.platform === "win32") {
      await runWindowsSendKeys(windowsLiteralKeys(text));
      return;
    }
    throw new Error(`Desktop keyboard backend is unavailable on ${process.platform}`);
  }

  const key = boundKey(input.key);
  if (process.platform === "linux") {
    const backend = await resolveLinuxInputBackend(portal);
    if (!backend) throw new Error("Linux desktop keyboard backend is unavailable");
    if (backend.id === "wayland-portal") {
      await portal.ensureSession();
      await portal.keysymSequence(portalKeysymSequence(key));
    } else if (backend.id === "ydotool") {
      await runBackend(backend.path, ["key", ...ydotoolKeySequence(key)], ydotoolEnvironment(backend.socketPath));
    } else {
      await runBackend(backend.path, ["key", "--", key]);
    }
    return;
  }
  if (process.platform === "darwin") {
    await runBackend("osascript", ["-e", macKeyScript(key)]);
    return;
  }
  if (process.platform === "win32") {
    await runWindowsSendKeys(windowsKeyChord(key));
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

export function macKeyScript(value: string): string {
  const chord = parseKeyChord(value);
  const modifiers = chord.modifiers.map((modifier) => {
    switch (modifier) {
      case "control": return "control down";
      case "shift": return "shift down";
      case "alt": return "option down";
      case "meta": return "command down";
    }
  });
  const using = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
  if (chord.key.length === 1) {
    return `tell application "System Events" to keystroke ${JSON.stringify(chord.key)}${using}`;
  }
  return `tell application "System Events" to key code ${macKeyCode(chord.key)}${using}`;
}

export function windowsKeyChord(value: string): string {
  const chord = parseKeyChord(value);
  let prefix = "";
  for (const modifier of chord.modifiers) {
    if (modifier === "control") prefix += "^";
    else if (modifier === "shift") prefix += "+";
    else if (modifier === "alt") prefix += "%";
    else throw new Error("Windows Meta/Super key combinations are not supported by the current keyboard backend");
  }
  const named: Record<string, string> = {
    enter: "{ENTER}", return: "{ENTER}", tab: "{TAB}", escape: "{ESC}", esc: "{ESC}",
    space: " ", backspace: "{BACKSPACE}", delete: "{DELETE}", left: "{LEFT}", right: "{RIGHT}",
    down: "{DOWN}", up: "{UP}", home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}", f6: "{F6}",
    f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
  };
  const normalized = chord.key.toLowerCase();
  const encoded = named[normalized] ?? (chord.key.length === 1 ? windowsLiteralKeys(chord.key) : undefined);
  if (!encoded) throw new Error(`Unsupported Windows key: ${chord.key}`);
  return `${prefix}${encoded}`;
}

export function windowsLiteralKeys(value: string): string {
  const special = new Set(["+", "^", "%", "~", "(", ")", "[", "]", "{", "}"]);
  let result = "";
  for (const char of value) {
    if (char === "\n") result += "{ENTER}";
    else if (char === "\r") continue;
    else if (char === "\t") result += "{TAB}";
    else if (special.has(char)) result += `{${char}}`;
    else result += char;
  }
  return result;
}

type KeyModifier = "control" | "shift" | "alt" | "meta";

function parseKeyChord(value: string): { modifiers: KeyModifier[]; key: string } {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 1) throw new Error("Desktop key value is invalid");
  const aliases: Record<string, KeyModifier> = {
    control: "control", ctrl: "control", shift: "shift", alt: "alt", option: "alt",
    meta: "meta", super: "meta", command: "meta", cmd: "meta",
  };
  const modifiers: KeyModifier[] = [];
  let key: string | undefined;
  for (const part of parts) {
    const modifier = aliases[part.toLowerCase()];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== undefined) throw new Error(`Unsupported key combination: ${value}`);
    key = part;
  }
  if (!key) throw new Error(`Unsupported key combination: ${value}`);
  return { modifiers, key };
}

function macKeyCode(key: string): number {
  const codes: Record<string, number> = { enter: 36, return: 36, tab: 48, escape: 53, esc: 53, space: 49, backspace: 51, delete: 117, left: 123, right: 124, down: 125, up: 126 };
  const code = codes[key.toLowerCase()];
  if (code === undefined) throw new Error(`Unsupported macOS key: ${key}`);
  return code;
}

type LinuxInputBackend =
  | { id: "wayland-portal" }
  | { id: "xdotool"; path: string }
  | { id: "ydotool"; path: string; socketPath: string };

async function resolveLinuxInputBackend(portal: WaylandRemoteDesktopPortal): Promise<LinuxInputBackend | null> {
  const wayland = isWaylandSession();
  if (wayland) {
    try {
      const probe = await portal.probe();
      if (probe.keyboard && probe.pointer && probe.screenCastMonitor) return { id: "wayland-portal" };
    } catch {
      // Fall through to ydotool. Portal availability is environment-dependent.
    }
  }
  if (!wayland) {
    const xdotool = await commandPath("xdotool");
    if (xdotool) return { id: "xdotool", path: xdotool };
  }

  const ydotool = await commandPath("ydotool");
  const socketPath = ydotoolSocketPath();
  if (ydotool && await isUsableYdotoolSocket(socketPath)) {
    return { id: "ydotool", path: ydotool, socketPath };
  }
  return null;
}

function isWaylandSession(): boolean {
  return process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || Boolean(process.env.WAYLAND_DISPLAY);
}

function ydotoolSocketPath(): string {
  if (process.env.YDOTOOL_SOCKET) return process.env.YDOTOOL_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return `${process.env.XDG_RUNTIME_DIR}/.ydotool_socket`;
  return "/tmp/.ydotool_socket";
}

function ydotoolEnvironment(socketPath: string): NodeJS.ProcessEnv {
  return { ...process.env, YDOTOOL_SOCKET: socketPath };
}

async function isUsableYdotoolSocket(socketPath: string): Promise<boolean> {
  try {
    const metadata = await stat(socketPath);
    if (!metadata.isSocket()) return false;
    await access(socketPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function portalKeysymSequence(value: string): Array<{ keysym: number; state: 0 | 1 }> {
  const chord = parseKeyChord(value);
  const modifierKeysyms: Record<KeyModifier, number> = {
    control: 0xffe3,
    shift: 0xffe1,
    alt: 0xffe9,
    meta: 0xffeb,
  };
  const modifiers = chord.modifiers.map((modifier) => modifierKeysyms[modifier]);
  const key = portalKeysym(chord.key);
  return [
    ...modifiers.map((keysym) => ({ keysym, state: 1 as const })),
    { keysym: key, state: 1 as const },
    { keysym: key, state: 0 as const },
    ...[...modifiers].reverse().map((keysym) => ({ keysym, state: 0 as const })),
  ];
}

function portalKeysym(key: string): number {
  if (key.length === 1) {
    const codepoint = key.codePointAt(0);
    if (codepoint === undefined) throw new Error("Desktop key value is invalid");
    return codepoint <= 0xff ? codepoint : 0x01000000 | codepoint;
  }
  const named: Record<string, number> = {
    enter: 0xff0d, return: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b,
    space: 0x20, backspace: 0xff08, delete: 0xffff, home: 0xff50, left: 0xff51,
    up: 0xff52, right: 0xff53, down: 0xff54, pageup: 0xff55, pagedown: 0xff56, end: 0xff57,
    f1: 0xffbe, f2: 0xffbf, f3: 0xffc0, f4: 0xffc1, f5: 0xffc2, f6: 0xffc3,
    f7: 0xffc4, f8: 0xffc5, f9: 0xffc6, f10: 0xffc7, f11: 0xffc8, f12: 0xffc9,
  };
  const keysym = named[key.toLowerCase()];
  if (keysym === undefined) throw new Error(`Unsupported Wayland portal key: ${key}`);
  return keysym;
}

export function ydotoolKeySequence(value: string): string[] {
  let chord: ReturnType<typeof parseKeyChord>;
  try {
    chord = parseKeyChord(value);
  } catch {
    throw new Error(`Unsupported Linux key combination: ${value}`);
  }
  const modifierCodes: Record<KeyModifier, number> = {
    control: 29, shift: 42, alt: 56, meta: 125,
  };
  const modifiers = chord.modifiers.map((modifier) => modifierCodes[modifier]);
  const keyCode = linuxKeyCode(chord.key.toLowerCase());
  return [
    ...modifiers.map((code) => `${code}:1`),
    `${keyCode}:1`,
    `${keyCode}:0`,
    ...[...modifiers].reverse().map((code) => `${code}:0`),
  ];
}

function linuxKeyCode(key: string): number {
  const letters: Record<string, number> = {
    a: 30, b: 48, c: 46, d: 32, e: 18, f: 33, g: 34, h: 35, i: 23, j: 36, k: 37, l: 38, m: 50,
    n: 49, o: 24, p: 25, q: 16, r: 19, s: 31, t: 20, u: 22, v: 47, w: 17, x: 45, y: 21, z: 44,
  };
  if (letters[key] !== undefined) return letters[key];
  const digits: Record<string, number> = { "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11 };
  if (digits[key] !== undefined) return digits[key];
  const named: Record<string, number> = {
    escape: 1, esc: 1, backspace: 14, tab: 15, enter: 28, return: 28, space: 57,
    home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, delete: 111,
    f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
  };
  const code = named[key];
  if (code === undefined) throw new Error(`Unsupported Linux key: ${key}`);
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

async function runBackend(program: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(program, args, {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
}

function boundMaxSources(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 20 ? Number(value) : 8;
}

function boundScreenCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < -100_000 || Number(value) > 100_000) throw new Error(`Desktop mouse ${label} coordinate is invalid`);
  return Number(value);
}

function boundImageCoordinate(value: unknown, limit: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= limit) {
    throw new Error(`Desktop screenshot ${label} coordinate is outside the captured image`);
  }
  return Number(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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
