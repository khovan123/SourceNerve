import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { DesktopResult } from "./shared/desktop-api";
import {
  UPDATE_IPC,
  type DesktopUpdateView,
  type SourceNerveUpdateApi,
} from "./shared/update-api";

const updateApi: SourceNerveUpdateApi = {
  getState: () => ipcRenderer.invoke(UPDATE_IPC.state) as Promise<DesktopResult<DesktopUpdateView>>,
  check: () => ipcRenderer.invoke(UPDATE_IPC.check) as Promise<DesktopResult<DesktopUpdateView>>,
  download: () => ipcRenderer.invoke(UPDATE_IPC.download) as Promise<DesktopResult<DesktopUpdateView>>,
  restartToUpdate: () => ipcRenderer.invoke(UPDATE_IPC.restart) as Promise<DesktopResult<{ installing: true }>>,
  subscribe(listener: (view: DesktopUpdateView) => void): () => void {
    const handler = (_event: IpcRendererEvent, view: DesktopUpdateView) => listener(view);
    ipcRenderer.on(UPDATE_IPC.event, handler);
    return () => ipcRenderer.removeListener(UPDATE_IPC.event, handler);
  },
};

contextBridge.exposeInMainWorld("sourcenerveUpdate", Object.freeze(updateApi));
