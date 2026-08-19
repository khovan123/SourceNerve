import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  Menu,
  Notification,
  Tray,
  app,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import type {
  DaemonSnapshot,
  DesktopBehaviorPreferences,
  DesktopRuntimeEvent,
  PublicMcpView,
} from "../shared/desktop-api";
import type { DesktopPreferencesStore } from "./desktop-preferences";

export interface BackgroundControllerContext {
  preferences: DesktopPreferencesStore;
  getDaemonState(): DaemonSnapshot | null;
  getPublicMcpState(): PublicMcpView | null;
  showWindow(): void;
  startDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
  restartDaemon(): Promise<void>;
  openLogs(): Promise<void>;
  quit(): void;
}

export class BackgroundController {
  private tray: Tray | null = null;
  private latestPreferences: DesktopBehaviorPreferences;
  private lastNotificationKey = "";

  constructor(private readonly context: BackgroundControllerContext) {
    this.latestPreferences = context.preferences.snapshot();
  }

  initialize(): void {
    this.createTray();
    this.refreshTray();
  }

  preferences(): DesktopBehaviorPreferences {
    return { ...this.latestPreferences };
  }

  async updatePreferences(next: DesktopBehaviorPreferences): Promise<DesktopBehaviorPreferences> {
    const previous = this.latestPreferences;
    const saved = await this.context.preferences.update(next);
    try {
      await applyLaunchAtLogin(saved.launchAtLogin);
    } catch (error) {
      await this.context.preferences.update(previous);
      throw error;
    }
    this.latestPreferences = saved;
    this.refreshTray();
    return this.preferences();
  }

  shouldHideOnClose(): boolean {
    return this.latestPreferences.backgroundMode && this.latestPreferences.closeBehavior === "tray";
  }

  shouldKeepRunningWithoutWindows(): boolean {
    return this.latestPreferences.backgroundMode;
  }

  handleRuntimeEvent(event: DesktopRuntimeEvent): void {
    this.refreshTray();
    if (!this.latestPreferences.notificationsEnabled) return;

    if (event.type === "state") {
      const state = event.state.toLowerCase();
      if (event.component === "daemon" && (state.includes("crashed") || state.includes("incompatible"))) {
        this.notifyOnce(`daemon:${event.state}:${event.message ?? ""}`, "SourceNerve daemon needs attention", event.message ?? `Daemon is ${event.state}.`);
      } else if (event.component === "public-mcp" && (state.includes("offline") || state.includes("degraded"))) {
        this.notifyOnce(`public-mcp:${event.state}:${event.message ?? ""}`, "Public MCP needs attention", event.message ?? `Public MCP is ${event.state}.`);
      } else if (event.component === "auth" && (state.includes("expired") || state.includes("error"))) {
        this.notifyOnce(`auth:${event.state}:${event.message ?? ""}`, "SourceNerve account needs attention", event.message ?? `Account session is ${event.state}.`);
      }
      return;
    }

    if (event.type === "progress" && /(?:complete|completed|done)$/i.test(event.stage) && /^(?:workspace-index|task)[._-]/.test(event.operationId)) {
      this.notifyOnce(`progress:${event.operationId}:${event.stage}`, "SourceNerve operation completed", `${event.operationId}: ${event.stage}`);
    }
  }

  refreshTray(): void {
    if (!this.tray) return;
    const daemon = this.context.getDaemonState();
    const publicMcp = this.context.getPublicMcpState();
    const daemonState = daemon?.state ?? "unavailable";
    const publicState = publicMcp?.state ?? "unavailable";
    this.tray.setToolTip(`SourceNerve — daemon ${daemonState}, Public MCP ${publicState}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(this.menuTemplate(daemon)));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private createTray(): void {
    if (this.tray) return;
    const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    image.setTemplateImage(process.platform === "darwin");
    this.tray = new Tray(image);
    this.tray.on("click", () => this.context.showWindow());
    this.tray.on("double-click", () => this.context.showWindow());
  }

  private menuTemplate(daemon: DaemonSnapshot | null): MenuItemConstructorOptions[] {
    const state = daemon?.state ?? "stopped";
    const managed = daemon?.managed === true;
    const running = state === "ready" || state === "starting" || state === "stopping";
    return [
      { label: "Show SourceNerve", click: () => this.context.showWindow() },
      { type: "separator" },
      {
        label: "Start SourceNerve",
        enabled: state === "stopped" || state === "crashed",
        click: () => void this.context.startDaemon(),
      },
      {
        label: "Stop SourceNerve",
        enabled: managed && running && state !== "stopping",
        click: () => void this.context.stopDaemon(),
      },
      {
        label: "Restart SourceNerve",
        enabled: managed && state === "ready",
        click: () => void this.context.restartDaemon(),
      },
      { type: "separator" },
      { label: "Open Logs", click: () => void this.context.openLogs() },
      { type: "separator" },
      { label: "Quit SourceNerve", click: () => this.context.quit() },
    ];
  }

  private notifyOnce(key: string, title: string, body: string): void {
    if (key === this.lastNotificationKey || !Notification.isSupported()) return;
    this.lastNotificationKey = key;
    const notification = new Notification({ title, body: body.slice(0, 512), silent: false });
    notification.on("click", () => this.context.showWindow());
    notification.show();
  }
}

export async function applyLaunchAtLogin(enabled: boolean): Promise<void> {
  if (process.platform === "linux") {
    const autostartDir = path.join(app.getPath("config"), "autostart");
    const desktopFile = path.join(autostartDir, "sourcenerve-desktop.desktop");
    if (!enabled) {
      await rm(desktopFile, { force: true });
      return;
    }
    await mkdir(autostartDir, { recursive: true, mode: 0o700 });
    const exec = desktopExec(process.execPath);
    const content = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=SourceNerve",
      `Exec=${exec} --hidden`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "StartupNotify=false",
      "",
    ].join("\n");
    await writeFile(desktopFile, content, { encoding: "utf8", mode: 0o600 });
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: enabled && process.platform === "darwin",
    args: enabled ? ["--hidden"] : [],
  });
}

export async function openDesktopLogs(logDirectory: string): Promise<void> {
  const error = await shell.openPath(logDirectory);
  if (error) throw new Error(`Unable to open SourceNerve logs: ${error}`);
}

function desktopExec(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

const TRAY_ICON_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDE4IDE4Ij48cmVjdCB4PSIxIiB5PSIxIiB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHJ4PSI0IiBmaWxsPSIjMzU2QUU2Ii8+PHBhdGggZD0iTTQuNSA1LjVoMlYxMmg3di0ySDguNVY4aDV2LTJoLTdWNS41eiIgZmlsbD0iI2ZmZiIvPjwvc3ZnPg==";
