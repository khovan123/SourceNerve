import { app } from "electron";
import electronUpdater, {
  AppImageUpdater,
  MacUpdater,
  NsisUpdater,
  RpmUpdater,
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";

import {
  UPDATE_API_VERSION,
  type DesktopUpdateProgress,
  type DesktopUpdateRelease,
  type DesktopUpdateView,
} from "../shared/update-api";
import {
  compareSemver,
  updateReleaseFromInfo,
  updaterChannelForArch,
} from "./update-compatibility";

const GITHUB_UPDATE_PROVIDER = {
  provider: "github" as const,
  owner: "khovan123",
  repo: "SourceNerve",
};

export interface DesktopUpdateManagerOptions {
  currentVersion?: string;
  packaged?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  updater?: AppUpdater | null;
}

type UpdateListener = (view: DesktopUpdateView) => void;

export class DesktopUpdateManager {
  private readonly currentVersion: string;
  private readonly packaged: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly updaterChannel: string;
  private readonly updater: AppUpdater | null;
  private readonly listeners = new Set<UpdateListener>();
  private initialized = false;
  private view: DesktopUpdateView;

  constructor(options: DesktopUpdateManagerOptions = {}) {
    this.currentVersion = options.currentVersion ?? app.getVersion();
    this.packaged = options.packaged ?? app.isPackaged;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.updaterChannel = updaterChannelForArch(this.arch);
    const enabled = this.packaged && isSupportedPlatform(this.platform);
    this.updater = options.updater === undefined
      ? enabled
        ? createPlatformUpdater(this.platform, this.updaterChannel)
        : null
      : options.updater;
    this.view = {
      apiVersion: UPDATE_API_VERSION,
      enabled: Boolean(enabled && this.updater),
      state: enabled && this.updater ? "idle" : "disabled",
      channel: "stable",
      updaterChannel: this.updaterChannel,
      currentVersion: this.currentVersion,
      ...(!this.packaged ? { message: "Updates are disabled in local development builds." } : {}),
    };
  }

  initialize(): DesktopUpdateView {
    if (this.initialized || !this.updater) return this.snapshot();
    this.initialized = true;
    const updater = this.updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.channel = this.updaterChannel;

    updater.on("checking-for-update", () => {
      this.patch({ state: "checking", message: "Checking GitHub Releases for a stable update." });
    });
    updater.on("update-not-available", () => {
      this.patch({ state: "up-to-date", release: undefined, progress: undefined, message: "SourceNerve is up to date." });
    });
    updater.on("update-available", (info: UpdateInfo) => {
      this.applyAvailableInfo(info);
    });
    updater.on("download-progress", (progress: ProgressInfo) => {
      this.patch({
        state: "downloading",
        progress: normalizeProgress(progress),
        message: "Downloading the verified update package.",
      });
    });
    updater.on("update-downloaded", (info: UpdateInfo) => {
      try {
        const release = this.compatibleRelease(info);
        this.patch({
          state: "downloaded",
          release,
          progress: this.view.progress,
          message: "Update downloaded. Restart SourceNerve to install it.",
        });
      } catch (error) {
        this.patch({ state: "incompatible", message: safeMessage(error, "Downloaded update is incompatible.") });
      }
    });
    updater.on("error", (error: Error) => {
      this.patch({ state: "error", message: safeMessage(error, "Desktop update failed.") });
    });
    return this.snapshot();
  }

  snapshot(): DesktopUpdateView {
    return structuredClone(this.view);
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<DesktopUpdateView> {
    this.ensureInitialized();
    if (!this.updater || !this.view.enabled) return this.snapshot();
    this.patch({ state: "checking", progress: undefined, message: "Checking GitHub Releases for a stable update." });
    try {
      const result = await this.updater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info || compareSemver(info.version, this.currentVersion) <= 0) {
        this.patch({ state: "up-to-date", release: undefined, progress: undefined, message: "SourceNerve is up to date." });
        return this.snapshot();
      }
      this.applyAvailableInfo(info);
      return this.snapshot();
    } catch (error) {
      this.patch({ state: "error", message: safeMessage(error, "Unable to check for updates.") });
      return this.snapshot();
    }
  }

  async download(): Promise<DesktopUpdateView> {
    this.ensureInitialized();
    if (!this.updater || !this.view.enabled) return this.snapshot();
    if (this.view.state !== "available" || !this.view.release) {
      this.patch({ state: "error", message: "Check for a compatible update before downloading." });
      return this.snapshot();
    }
    this.patch({ state: "downloading", progress: undefined, message: "Downloading the verified update package." });
    try {
      await this.updater.downloadUpdate();
      const stateAfterDownload = this.snapshot().state;
      if (stateAfterDownload === "downloading") {
        this.patch({ state: "downloaded", message: "Update downloaded. Restart SourceNerve to install it." });
      }
      return this.snapshot();
    } catch (error) {
      this.patch({ state: "error", message: safeMessage(error, "Unable to download the update.") });
      return this.snapshot();
    }
  }

  restartToUpdate(): { installing: true } {
    this.ensureInitialized();
    if (!this.updater || this.view.state !== "downloaded") {
      throw new Error("A verified update must be downloaded before restart-to-update.");
    }
    this.patch({ state: "installing", message: "Restarting SourceNerve to install the update." });
    this.updater.quitAndInstall(true, true);
    return { installing: true };
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize();
  }

  private applyAvailableInfo(info: UpdateInfo): void {
    try {
      const release = this.compatibleRelease(info);
      this.patch({
        state: "available",
        release,
        progress: undefined,
        message: `SourceNerve ${release.version} is available.`,
      });
    } catch (error) {
      this.patch({
        state: "incompatible",
        release: undefined,
        progress: undefined,
        message: safeMessage(error, "Available update is incompatible."),
      });
    }
  }

  private compatibleRelease(info: UpdateInfo): DesktopUpdateRelease {
    return updateReleaseFromInfo(info as unknown, this.currentVersion);
  }

  private patch(next: Partial<DesktopUpdateView>): void {
    this.view = {
      ...this.view,
      ...next,
      apiVersion: UPDATE_API_VERSION,
      enabled: this.view.enabled,
      channel: "stable",
      updaterChannel: this.updaterChannel,
      currentVersion: this.currentVersion,
    };
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function createPlatformUpdater(platform: NodeJS.Platform, channel: string): AppUpdater | null {
  const options = { ...GITHUB_UPDATE_PROVIDER, channel };
  if (platform === "win32") return new NsisUpdater(options);
  if (platform === "darwin") return new MacUpdater(options);
  if (platform === "linux") {
    return process.env.APPIMAGE ? new AppImageUpdater(options) : new RpmUpdater(options);
  }
  return null;
}

function normalizeProgress(progress: ProgressInfo): DesktopUpdateProgress {
  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
  return {
    percent,
    transferred: Math.max(0, progress.transferred),
    total: Math.max(0, progress.total),
    bytesPerSecond: Math.max(0, progress.bytesPerSecond),
  };
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

function safeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1024) || fallback;
}

// electron-updater is CommonJS today. Retain the default import so Vite can bundle it reliably.
void electronUpdater;
