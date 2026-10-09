import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_DISCOVERY_FILES = 4_000;
const DEFAULT_MAX_APPLICATIONS = 40;
const MAX_APPLICATIONS = 100;

export type DesktopNativeApplicationLauncher =
  | "linux-desktop-entry"
  | "macos-application"
  | "windows-start-menu";

export interface DesktopNativeApplication {
  id: string;
  name: string;
  launcher: DesktopNativeApplicationLauncher;
}

export interface NativeApplicationListInput {
  query?: string;
  maxApplications?: number;
}

interface DiscoveredNativeApplication extends DesktopNativeApplication {
  launchTarget: string;
}

export async function nativeApplicationLauncherAvailable(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "linux") return Boolean(await commandPath("gtk-launch"));
  if (platform === "darwin") return pathAccessible("/usr/bin/open");
  if (platform === "win32") return true;
  return false;
}

export async function listNativeApplications(
  input: NativeApplicationListInput = {},
): Promise<DesktopNativeApplication[]> {
  const query = normalizeQuery(input.query);
  const maxApplications = boundMaxApplications(input.maxApplications);
  const applications = await discoverNativeApplications();
  return applications
    .filter((application) => !query
      || application.name.toLocaleLowerCase().includes(query)
      || application.id.toLocaleLowerCase().includes(query))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, maxApplications)
    .map(publicApplication);
}

export async function launchNativeApplication(applicationId: string): Promise<DesktopNativeApplication> {
  const id = boundApplicationId(applicationId);
  const application = (await discoverNativeApplications()).find((candidate) => candidate.id === id);
  if (!application) {
    throw new Error(`Native desktop application ${id} is not installed or is no longer available`);
  }

  if (process.platform === "linux") {
    const gtkLaunch = await commandPath("gtk-launch");
    if (!gtkLaunch) throw new Error("Linux native application launcher is unavailable: gtk-launch is not installed");
    await runLauncher(gtkLaunch, [application.launchTarget], linuxLaunchEnvironment());
  } else if (process.platform === "darwin") {
    await runLauncher("/usr/bin/open", ["-a", application.launchTarget]);
  } else if (process.platform === "win32") {
    await runLauncher("explorer.exe", [`shell:AppsFolder\\${application.launchTarget}`]);
  } else {
    throw new Error(`Native application launch is unavailable on ${process.platform}`);
  }

  return publicApplication(application);
}

async function discoverNativeApplications(): Promise<DiscoveredNativeApplication[]> {
  if (process.platform === "linux") return discoverLinuxApplications();
  if (process.platform === "darwin") return discoverMacApplications();
  if (process.platform === "win32") return discoverWindowsApplications();
  return [];
}

async function discoverLinuxApplications(): Promise<DiscoveredNativeApplication[]> {
  const applications: DiscoveredNativeApplication[] = [];
  let scanned = 0;
  for (const directory of linuxApplicationDirectories()) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= MAX_DISCOVERY_FILES) break;
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".desktop")) continue;
      scanned += 1;
      const id = entry.name.slice(0, -".desktop".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)) continue;
      try {
        const parsed = parseLinuxDesktopEntry(await readFile(path.join(directory, entry.name), "utf8"));
        if (!parsed) continue;
        applications.push({
          id,
          name: parsed.name,
          launcher: "linux-desktop-entry",
          launchTarget: id,
        });
      } catch {
        // Broken or unreadable desktop entries are omitted rather than executed.
      }
    }
    if (scanned >= MAX_DISCOVERY_FILES) break;
  }
  return dedupeApplications(applications);
}

export function parseLinuxDesktopEntry(content: string): { name: string } | null {
  let inDesktopEntry = false;
  let sawDesktopEntry = false;
  let name = "";
  let type = "";
  let hidden = false;
  let noDisplay = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      if (sawDesktopEntry && line !== "[Desktop Entry]") break;
      inDesktopEntry = line === "[Desktop Entry]";
      sawDesktopEntry ||= inDesktopEntry;
      continue;
    }
    if (!inDesktopEntry) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === "Name") name = value;
    else if (key === "Type") type = value;
    else if (key === "Hidden") hidden = value.toLowerCase() === "true";
    else if (key === "NoDisplay") noDisplay = value.toLowerCase() === "true";
  }
  if (!sawDesktopEntry || type !== "Application" || hidden || noDisplay || !validVisibleText(name, 256)) return null;
  return { name };
}

async function discoverMacApplications(): Promise<DiscoveredNativeApplication[]> {
  const applications: DiscoveredNativeApplication[] = [];
  const directories = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    path.join(homedir(), "Applications"),
  ];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
      const name = entry.name.slice(0, -".app".length);
      if (!validVisibleText(name, 256)) continue;
      applications.push({ id: name, name, launcher: "macos-application", launchTarget: name });
    }
  }
  return dedupeApplications(applications);
}

async function discoverWindowsApplications(): Promise<DiscoveredNativeApplication[]> {
  const script = "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: 8_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(stdout || "[]") as unknown;
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  const applications: DiscoveredNativeApplication[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { Name?: unknown; AppID?: unknown };
    const name = record.Name;
    const id = record.AppID;
    if (!validVisibleText(name, 256) || !validVisibleText(id, 512)) continue;
    applications.push({
      id,
      name,
      launcher: "windows-start-menu",
      launchTarget: id,
    });
  }
  return dedupeApplications(applications);
}

function linuxApplicationDirectories(): string[] {
  const home = homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter(Boolean);
  const roots = [
    dataHome,
    ...dataDirs,
    "/var/lib/flatpak/exports/share",
    path.join(home, ".local", "share", "flatpak", "exports", "share"),
  ];
  return [...new Set(roots.map((root) => path.join(root, "applications")))];
}

function linuxLaunchEnvironment(): NodeJS.ProcessEnv {
  const home = homedir();
  const current = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const roots = [...new Set([
    ...current,
    "/var/lib/flatpak/exports/share",
    path.join(home, ".local", "share", "flatpak", "exports", "share"),
  ])];
  return { ...process.env, XDG_DATA_DIRS: roots.join(":") };
}

function dedupeApplications(applications: DiscoveredNativeApplication[]): DiscoveredNativeApplication[] {
  const unique = new Map<string, DiscoveredNativeApplication>();
  for (const application of applications) {
    if (!unique.has(application.id)) unique.set(application.id, application);
  }
  return [...unique.values()];
}

function publicApplication(application: DiscoveredNativeApplication): DesktopNativeApplication {
  return { id: application.id, name: application.name, launcher: application.launcher };
}

function normalizeQuery(value: unknown): string {
  if (value === undefined) return "";
  if (!validVisibleText(value, 128)) throw new Error("Native application query is invalid");
  return value.trim().toLocaleLowerCase();
}

function boundMaxApplications(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_APPLICATIONS
    ? Number(value)
    : DEFAULT_MAX_APPLICATIONS;
}

function boundApplicationId(value: unknown): string {
  if (!validVisibleText(value, 512)) throw new Error("Native application id is invalid");
  return value;
}

function validVisibleText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value)
    && ![...value].some((character) => character.charCodeAt(0) < 32 && character !== "\t");
}

async function commandPath(command: string): Promise<string | null> {
  const candidates = [`/usr/bin/${command}`, `/bin/${command}`, `/usr/local/bin/${command}`];
  for (const candidate of candidates) {
    if (await pathAccessible(candidate)) return candidate;
  }
  return null;
}

async function pathAccessible(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function runLauncher(program: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(program, args, {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
}
