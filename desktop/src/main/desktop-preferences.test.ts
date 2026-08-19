import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopPreferencesStore,
  defaultDesktopPreferences,
  validateDesktopPreferencesInput,
} from "./desktop-preferences";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("DesktopPreferencesStore", () => {
  it("uses native macOS background defaults and quit defaults elsewhere", () => {
    expect(defaultDesktopPreferences("darwin")).toMatchObject({
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: false,
    });
    expect(defaultDesktopPreferences("linux")).toMatchObject({
      backgroundMode: false,
      closeBehavior: "quit",
      launchAtLogin: false,
    });
    expect(defaultDesktopPreferences("win32")).toMatchObject({
      backgroundMode: false,
      closeBehavior: "quit",
      launchAtLogin: false,
    });
  });

  it("rejects unknown fields and tray close behavior without background mode", () => {
    expect(validateDesktopPreferencesInput({
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: false,
      notificationsEnabled: true,
    })).toBe(true);
    expect(validateDesktopPreferencesInput({
      backgroundMode: false,
      closeBehavior: "tray",
      launchAtLogin: false,
      notificationsEnabled: true,
    })).toBe(false);
    expect(validateDesktopPreferencesInput({
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: false,
      notificationsEnabled: true,
      command: "rm -rf /",
    })).toBe(false);
  });

  it("persists only the bounded preference schema atomically", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "managed", "desktop-preferences.json");
    const store = new DesktopPreferencesStore(filePath, "linux");
    await store.initialize();

    const saved = await store.update({
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: true,
      notificationsEnabled: false,
    });
    expect(saved).toEqual({
      backgroundMode: true,
      closeBehavior: "tray",
      launchAtLogin: true,
      notificationsEnabled: false,
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(1);
    expect(Object.keys(raw).sort()).toEqual([
      "backgroundMode",
      "closeBehavior",
      "launchAtLogin",
      "notificationsEnabled",
      "schemaVersion",
    ]);
  });

  it("falls back safely when stored schema is unknown", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "desktop-preferences.json");
    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, backgroundMode: true }), "utf8");
    const store = new DesktopPreferencesStore(filePath, "linux");
    expect(await store.initialize()).toEqual(defaultDesktopPreferences("linux"));
  });
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sourcenerve-desktop-prefs-"));
  temporaryDirectories.push(directory);
  return directory;
}
