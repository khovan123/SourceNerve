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
});
