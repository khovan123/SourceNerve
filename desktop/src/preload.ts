import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_IPC,
  type RuntimeInfo,
  type SourceNerveDesktopApi,
} from "./shared/desktop-api";

const api: SourceNerveDesktopApi = {
  getRuntimeInfo(): Promise<RuntimeInfo> {
    return ipcRenderer.invoke(DESKTOP_IPC.runtimeInfo) as Promise<RuntimeInfo>;
  },
};

contextBridge.exposeInMainWorld("sourcenerveDesktop", api);
