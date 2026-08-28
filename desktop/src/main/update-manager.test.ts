import { describe, expect, it, vi } from "vitest";
import type { AppUpdater } from "electron-updater";

import { DesktopUpdateManager } from "./update-manager";

describe("DesktopUpdateManager stable channel", () => {
  it("restores allowDowngrade=false after electron-updater channel selection", () => {
    let allowDowngrade = false;
    let channel: string | null = null;
    const fake: Record<string, unknown> = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
    };
    Object.defineProperties(fake, {
      channel: {
        get: () => channel,
        set: (value: string | null) => {
          channel = value;
          // Mirrors electron-updater AppUpdater.channel: selecting a channel opts into downgrade.
          allowDowngrade = true;
        },
        enumerable: true,
      },
      allowDowngrade: {
        get: () => allowDowngrade,
        set: (value: boolean) => {
          allowDowngrade = value;
        },
        enumerable: true,
      },
    });
    fake.on = vi.fn(() => fake);

    const manager = new DesktopUpdateManager({
      currentVersion: "0.1.0",
      packaged: true,
      platform: "win32",
      arch: "x64",
      updater: fake as unknown as AppUpdater,
    });

    const view = manager.initialize();

    expect(channel).toBe("latest-x64");
    expect(allowDowngrade).toBe(false);
    expect(fake.allowPrerelease).toBe(false);
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(false);
    expect(view).toMatchObject({ enabled: true, channel: "stable", updaterChannel: "latest-x64" });
  });

  it("keeps local development builds updater-disabled", () => {
    const manager = new DesktopUpdateManager({
      currentVersion: "0.1.0",
      packaged: false,
      platform: "linux",
      arch: "x64",
      updater: null,
    });

    expect(manager.initialize()).toMatchObject({
      enabled: false,
      state: "disabled",
      channel: "stable",
      updaterChannel: "latest-x64",
    });
  });

  it("completes the packaged check, verified download, and restart lifecycle", async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    };
    const updateInfo = {
      version: "0.2.0",
      files: [{ url: "SourceNerve-Setup-0.2.0-x64.exe", sha512: "verified-sha512" }],
      sourcenerve: {
        daemonVersion: "0.2.0",
        profileSchemaVersion: 1,
      },
    };
    const quitAndInstall = vi.fn();
    const fake = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      allowDowngrade: false,
      channel: null as string | null,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
        return fake;
      }),
      checkForUpdates: vi.fn(async () => ({ updateInfo })),
      downloadUpdate: vi.fn(async () => {
        emit("download-progress", {
          percent: 100,
          transferred: 1024,
          total: 1024,
          bytesPerSecond: 1024,
        });
        emit("update-downloaded", updateInfo);
        return ["SourceNerve-Setup-0.2.0-x64.exe"];
      }),
      quitAndInstall,
    };
    const manager = new DesktopUpdateManager({
      currentVersion: "0.1.0",
      packaged: true,
      platform: "win32",
      arch: "x64",
      updater: fake as unknown as AppUpdater,
    });

    manager.initialize();
    await expect(manager.check()).resolves.toMatchObject({
      state: "available",
      release: { version: "0.2.0", daemonVersion: "0.2.0" },
    });
    await expect(manager.download()).resolves.toMatchObject({
      state: "downloaded",
      progress: { percent: 100 },
    });
    expect(manager.restartToUpdate()).toEqual({ installing: true });
    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(manager.snapshot().state).toBe("installing");
  });
});
