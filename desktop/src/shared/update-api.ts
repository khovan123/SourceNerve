import type { DesktopResult } from "./desktop-api";

export const UPDATE_API_VERSION = 1 as const;

export type DesktopUpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "incompatible"
  | "error";

export interface DesktopUpdateRelease {
  version: string;
  daemonVersion: string;
  profileSchemaVersion: number;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface DesktopUpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateView {
  apiVersion: typeof UPDATE_API_VERSION;
  enabled: boolean;
  state: DesktopUpdateState;
  channel: "stable";
  updaterChannel: string;
  currentVersion: string;
  release?: DesktopUpdateRelease;
  progress?: DesktopUpdateProgress;
  message?: string;
}

export interface SourceNerveUpdateApi {
  getState(): Promise<DesktopResult<DesktopUpdateView>>;
  check(): Promise<DesktopResult<DesktopUpdateView>>;
  download(): Promise<DesktopResult<DesktopUpdateView>>;
  restartToUpdate(): Promise<DesktopResult<{ installing: true }>>;
  subscribe(listener: (view: DesktopUpdateView) => void): () => void;
}

export const UPDATE_IPC = {
  state: "desktop:update-state",
  check: "desktop:update-check",
  download: "desktop:update-download",
  restart: "desktop:update-restart",
  event: "desktop:update-event",
} as const;
