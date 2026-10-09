import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MAX_PLAYER_ID = 256;
const MAX_URI_LENGTH = 2048;

export type MediaControlAction = "play" | "pause" | "play-pause" | "stop" | "next" | "previous";

export interface DesktopMediaPlayer {
  id: string;
  name: string;
  playbackStatus?: "Playing" | "Paused" | "Stopped" | string;
}

export async function backgroundMediaControlAvailable(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  return platform === "linux" && Boolean(await gdbusPath()) && Boolean(sessionBusAddress());
}

export async function listBackgroundMediaPlayers(): Promise<DesktopMediaPlayer[]> {
  const gdbus = await requireGdbus();
  const { stdout } = await execFileAsync(gdbus, [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.DBus",
    "--object-path",
    "/org/freedesktop/DBus",
    "--method",
    "org.freedesktop.DBus.ListNames",
  ], commandOptions());
  const ids = parseDbusNames(stdout.toString()).filter((name) => name.startsWith(MPRIS_PREFIX));
  const players: DesktopMediaPlayer[] = [];
  for (const id of ids) {
    const playbackStatus = await readPlaybackStatus(gdbus, id).catch(() => undefined);
    players.push({ id, name: playerDisplayName(id), ...(playbackStatus ? { playbackStatus } : {}) });
  }
  return players;
}

export async function controlBackgroundMediaPlayer(playerId: string, action: MediaControlAction): Promise<{ playerId: string; action: MediaControlAction }> {
  const gdbus = await requireGdbus();
  const id = validatePlayerId(playerId);
  const method = mediaMethod(action);
  await execFileAsync(gdbus, [
    "call",
    "--session",
    "--dest",
    id,
    "--object-path",
    "/org/mpris/MediaPlayer2",
    "--method",
    `org.mpris.MediaPlayer2.Player.${method}`,
  ], commandOptions());
  return { playerId: id, action };
}

export async function openBackgroundMediaUri(playerId: string, uri: string): Promise<{ playerId: string; uri: string }> {
  const gdbus = await requireGdbus();
  const id = validatePlayerId(playerId);
  const safeUri = validateMediaUri(uri);
  await execFileAsync(gdbus, [
    "call",
    "--session",
    "--dest",
    id,
    "--object-path",
    "/org/mpris/MediaPlayer2",
    "--method",
    "org.mpris.MediaPlayer2.Player.OpenUri",
    safeUri,
  ], commandOptions());
  return { playerId: id, uri: safeUri };
}

export function parseDbusNames(output: string): string[] {
  const names: string[] = [];
  const pattern = /'([^']+)'/g;
  for (let match = pattern.exec(output); match; match = pattern.exec(output)) {
    if (match[1]) names.push(match[1]);
  }
  return [...new Set(names)];
}

export function validateMediaUri(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URI_LENGTH || /[\0\r\n]/.test(value)) {
    throw new Error("Media URI is invalid");
  }
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]?.toLowerCase();
  if (!scheme || !["spotify", "file", "http", "https"].includes(scheme)) {
    throw new Error("Media URI scheme is not allowed");
  }
  return value;
}

function validatePlayerId(value: unknown): string {
  if (typeof value !== "string" || value.length < MPRIS_PREFIX.length + 1 || value.length > MAX_PLAYER_ID) {
    throw new Error("Media player id is invalid");
  }
  if (!value.startsWith(MPRIS_PREFIX) || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Media player id is invalid");
  }
  return value;
}

function mediaMethod(action: MediaControlAction): string {
  switch (action) {
    case "play": return "Play";
    case "pause": return "Pause";
    case "play-pause": return "PlayPause";
    case "stop": return "Stop";
    case "next": return "Next";
    case "previous": return "Previous";
  }
}

async function readPlaybackStatus(gdbus: string, playerId: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync(gdbus, [
    "call",
    "--session",
    "--dest",
    playerId,
    "--object-path",
    "/org/mpris/MediaPlayer2",
    "--method",
    "org.freedesktop.DBus.Properties.Get",
    "org.mpris.MediaPlayer2.Player",
    "PlaybackStatus",
  ], commandOptions());
  return stdout.toString().match(/<\s*'([^']+)'\s*>/)?.[1];
}

function playerDisplayName(id: string): string {
  const suffix = id.slice(MPRIS_PREFIX.length).split(".")[0] || id;
  return suffix.charAt(0).toLocaleUpperCase() + suffix.slice(1);
}

async function requireGdbus(): Promise<string> {
  if (process.platform !== "linux") throw new Error("Background media control is currently available on Linux only");
  if (!sessionBusAddress()) throw new Error("Desktop session D-Bus is unavailable");
  const executable = await gdbusPath();
  if (!executable) throw new Error("Background media control is unavailable: gdbus is not installed");
  return executable;
}

async function gdbusPath(): Promise<string | null> {
  for (const candidate of ["/usr/bin/gdbus", "/bin/gdbus", "/usr/local/bin/gdbus"]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next fixed executable path.
    }
  }
  return null;
}

function sessionBusAddress(): string | null {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return process.env.DBUS_SESSION_BUS_ADDRESS;
  if (process.platform !== "linux" || typeof process.getuid !== "function") return null;
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return `unix:path=${runtimeDirectory}/bus`;
}

function commandOptions(): Parameters<typeof execFileAsync>[2] {
  const address = sessionBusAddress();
  return {
    timeout: 8_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
    ...(address ? { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: address } } : {}),
  };
}
