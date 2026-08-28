import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const notifications: Array<Record<string, unknown>> = [];
  class NotificationMock {
    static isSupported(): boolean { return true; }
    constructor(options: Record<string, unknown>) { notifications.push(options); }
    on(): void {}
    show(): void {}
  }
  return {
    notifications,
    NotificationMock,
  };
});

const sound = vi.hoisted(() => ({ play: vi.fn() }));

vi.mock("electron", () => ({
  Notification: electron.NotificationMock,
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  Tray: class {},
  app: {
    isPackaged: true,
    getPath: vi.fn(() => "/tmp"),
    setLoginItemSettings: vi.fn(),
  },
  nativeImage: { createFromDataURL: vi.fn(() => ({ setTemplateImage: vi.fn() })) },
  shell: { openPath: vi.fn(async () => ""), openExternal: vi.fn(async () => undefined) },
}));

vi.mock("./app-icon", () => ({
  loadDesktopAppIcon: vi.fn(() => ({ isEmpty: () => false })),
  resolveDesktopAppIconPath: vi.fn(() => "/tmp/sourcenerve-icon.png"),
}));

vi.mock("./notification-sound", () => ({
  playDesktopNotificationSound: sound.play,
}));

import { BackgroundController } from "./background-controller";

describe("BackgroundController notifications", () => {
  beforeEach(() => {
    electron.notifications.length = 0;
    sound.play.mockReset();
  });

  it("uses the SourceNerve icon and an explicit Linux chime for real completion events", () => {
    const preferences = {
      snapshot: () => ({
        schemaVersion: 1,
        backgroundMode: true,
        closeBehavior: "tray" as const,
        launchAtLogin: false,
        notificationsEnabled: true,
      }),
      update: vi.fn(),
      reset: vi.fn(),
    };
    const controller = new BackgroundController({
      preferences: preferences as never,
      policy: { allowBackgroundMode: true, allowLaunchAtLogin: true, allowNotifications: true },
      getDaemonState: () => null,
      getPublicMcpState: () => null,
      showWindow: vi.fn(),
      startDaemon: vi.fn(async () => undefined),
      stopDaemon: vi.fn(async () => undefined),
      restartDaemon: vi.fn(async () => undefined),
      openLogs: vi.fn(async () => undefined),
      quit: vi.fn(),
    });

    controller.handleRuntimeEvent({
      type: "state",
      component: "task",
      state: "completed",
      message: "Task finished",
    });

    expect(electron.notifications).toHaveLength(1);
    expect(electron.notifications[0]).toMatchObject({
      title: "SourceNerve task completed",
      body: "Task finished",
      silent: true,
      urgency: "normal",
    });
    expect(electron.notifications[0]?.icon).toBeTruthy();
    expect(sound.play).toHaveBeenCalledTimes(1);
  });

  it("does not synthesize a prompt-completed notification from an unsupported agent lifecycle", () => {
    const preferences = {
      snapshot: () => ({
        schemaVersion: 1,
        backgroundMode: true,
        closeBehavior: "tray" as const,
        launchAtLogin: false,
        notificationsEnabled: true,
      }),
      update: vi.fn(),
      reset: vi.fn(),
    };
    const controller = new BackgroundController({
      preferences: preferences as never,
      policy: { allowBackgroundMode: true, allowLaunchAtLogin: true, allowNotifications: true },
      getDaemonState: () => null,
      getPublicMcpState: () => null,
      showWindow: vi.fn(),
      startDaemon: vi.fn(async () => undefined),
      stopDaemon: vi.fn(async () => undefined),
      restartDaemon: vi.fn(async () => undefined),
      openLogs: vi.fn(async () => undefined),
      quit: vi.fn(),
    });

    controller.handleRuntimeEvent({
      type: "state",
      component: "desktop",
      state: "completed",
      message: "No prompt lifecycle signal exists",
    });

    expect(electron.notifications).toHaveLength(0);
    expect(sound.play).not.toHaveBeenCalled();
  });
});
