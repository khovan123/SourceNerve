export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  desktopVersion: string;
  electronVersion: string;
}

export interface SourceNerveDesktopApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
}

export const DESKTOP_IPC = {
  runtimeInfo: "desktop:runtime-info",
} as const;
