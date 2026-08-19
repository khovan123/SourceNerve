export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  desktopVersion: string;
  electronVersion: string;
  bootstrap: {
    ready: boolean;
    profileSchemaVersion?: number;
    secureStorageBackend?: string;
    error?: string;
  };
}

export interface SourceNerveDesktopApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
}

export const DESKTOP_IPC = {
  runtimeInfo: "desktop:runtime-info",
} as const;
