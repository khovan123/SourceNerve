import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopBehaviorPreferences, DesktopCloseBehavior } from "../shared/desktop-api";
import type { DesktopBehaviorPolicy } from "./runtime-profile";

const SCHEMA_VERSION = 1;

interface StoredPreferences extends DesktopBehaviorPreferences {
  schemaVersion: typeof SCHEMA_VERSION;
}

export class DesktopPreferencesStore {
  private current: DesktopBehaviorPreferences;

  constructor(
    private readonly filePath: string,
    private readonly platform: NodeJS.Platform,
  ) {
    this.current = defaultDesktopPreferences(platform);
  }

  async initialize(): Promise<DesktopBehaviorPreferences> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.current = defaultDesktopPreferences(this.platform);
      return this.snapshot();
    }

    try {
      this.current = validateStoredPreferences(JSON.parse(raw) as unknown, this.platform);
    } catch {
      this.current = defaultDesktopPreferences(this.platform);
    }
    return this.snapshot();
  }

  snapshot(): DesktopBehaviorPreferences {
    return { ...this.current };
  }

  async update(next: DesktopBehaviorPreferences): Promise<DesktopBehaviorPreferences> {
    const validated = validatePreferences(next);
    await atomicWrite(
      this.filePath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...validated }, null, 2),
    );
    this.current = validated;
    return this.snapshot();
  }
}

export function defaultDesktopPreferences(platform: NodeJS.Platform): DesktopBehaviorPreferences {
  const nativeBackground = platform === "darwin";
  return {
    backgroundMode: nativeBackground,
    closeBehavior: nativeBackground ? "tray" : "quit",
    launchAtLogin: false,
    notificationsEnabled: true,
  };
}

export function effectiveDesktopPreferences(
  preferences: DesktopBehaviorPreferences,
  policy: DesktopBehaviorPolicy,
): DesktopBehaviorPreferences {
  const backgroundMode = policy.allowBackgroundMode && preferences.backgroundMode;
  return {
    backgroundMode,
    closeBehavior: backgroundMode ? preferences.closeBehavior : "quit",
    launchAtLogin: policy.allowLaunchAtLogin && preferences.launchAtLogin,
    notificationsEnabled: policy.allowNotifications && preferences.notificationsEnabled,
  };
}

export function assertDesktopPreferencesAllowed(
  preferences: DesktopBehaviorPreferences,
  policy: DesktopBehaviorPolicy,
): void {
  if (preferences.backgroundMode && !policy.allowBackgroundMode) {
    throw new Error("Background mode is disabled by the SourceNerve product policy");
  }
  if (preferences.launchAtLogin && !policy.allowLaunchAtLogin) {
    throw new Error("Launch at login is disabled by the SourceNerve product policy");
  }
  if (preferences.notificationsEnabled && !policy.allowNotifications) {
    throw new Error("Native notifications are disabled by the SourceNerve product policy");
  }
}

export function validateDesktopPreferencesInput(value: unknown): value is DesktopBehaviorPreferences {
  try {
    validatePreferences(value);
    return true;
  } catch {
    return false;
  }
}

function validateStoredPreferences(value: unknown, platform: NodeJS.Platform): DesktopBehaviorPreferences {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return defaultDesktopPreferences(platform);
  }
  return validatePreferences(value);
}

function validatePreferences(value: unknown): DesktopBehaviorPreferences {
  if (!isRecord(value)) throw new Error("Desktop preferences must be an object");
  const allowed = new Set(["schemaVersion", "backgroundMode", "closeBehavior", "launchAtLogin", "notificationsEnabled"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Desktop preferences contain unknown fields");
  if (typeof value.backgroundMode !== "boolean") throw new Error("backgroundMode must be boolean");
  if (!isCloseBehavior(value.closeBehavior)) throw new Error("closeBehavior must be quit or tray");
  if (typeof value.launchAtLogin !== "boolean") throw new Error("launchAtLogin must be boolean");
  if (typeof value.notificationsEnabled !== "boolean") throw new Error("notificationsEnabled must be boolean");
  if (!value.backgroundMode && value.closeBehavior === "tray") {
    throw new Error("tray close behavior requires background mode");
  }
  return {
    backgroundMode: value.backgroundMode,
    closeBehavior: value.closeBehavior,
    launchAtLogin: value.launchAtLogin,
    notificationsEnabled: value.notificationsEnabled,
  };
}

function isCloseBehavior(value: unknown): value is DesktopCloseBehavior {
  return value === "quit" || value === "tray";
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
