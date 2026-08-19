import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

import {
  DESKTOP_IPC,
  type DaemonHealth,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type ReadinessPayload,
  type RuntimeInfo,
  type ServiceStatusPayload,
  type SourceNerveDesktopApi,
  type WorkspaceSummary,
} from "./shared/desktop-api";

const api: SourceNerveDesktopApi = {
  getRuntimeInfo(): Promise<DesktopResult<RuntimeInfo>> {
    return ipcRenderer.invoke(DESKTOP_IPC.runtimeInfo) as Promise<DesktopResult<RuntimeInfo>>;
  },
  getDaemonHealth(): Promise<DesktopResult<DaemonHealth>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonHealth) as Promise<DesktopResult<DaemonHealth>>;
  },
  getServiceStatus(): Promise<DesktopResult<ServiceStatusPayload>> {
    return ipcRenderer.invoke(DESKTOP_IPC.serviceStatus) as Promise<
      DesktopResult<ServiceStatusPayload>
    >;
  },
  getReadiness(): Promise<DesktopResult<ReadinessPayload>> {
    return ipcRenderer.invoke(DESKTOP_IPC.readiness) as Promise<DesktopResult<ReadinessPayload>>;
  },
  listWorkspaces(): Promise<DesktopResult<WorkspaceSummary[]>> {
    return ipcRenderer.invoke(DESKTOP_IPC.listWorkspaces) as Promise<
      DesktopResult<WorkspaceSummary[]>
    >;
  },
  cancelOperation(operationId: string): Promise<DesktopResult<{ cancelled: boolean }>> {
    return ipcRenderer.invoke(DESKTOP_IPC.cancelOperation, operationId) as Promise<
      DesktopResult<{ cancelled: boolean }>
    >;
  },
  subscribeRuntimeEvents(listener: (event: DesktopRuntimeEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: DesktopRuntimeEvent) => {
      listener(payload);
    };
    ipcRenderer.on(DESKTOP_IPC.runtimeEvent, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.runtimeEvent, handler);
  },
};

contextBridge.exposeInMainWorld("sourcenerveDesktop", api);
