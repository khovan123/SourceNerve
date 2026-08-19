import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
} from "electron";

import {
  DESKTOP_IPC,
  type Auth0SessionView,
  type DaemonHealth,
  type DaemonSnapshot,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type ManagedWorkspaceInput,
  type ManagedWorkspaceView,
  type ReadinessPayload,
  type RuntimeInfo,
  type ServiceStatusPayload,
  type SourceNerveDesktopApi,
  type WorkspaceIndexResult,
  type WorkspaceSummary,
  type WorkspaceValidation,
} from "./shared/desktop-api";

const api: SourceNerveDesktopApi = {
  getRuntimeInfo(): Promise<DesktopResult<RuntimeInfo>> {
    return ipcRenderer.invoke(DESKTOP_IPC.runtimeInfo) as Promise<DesktopResult<RuntimeInfo>>;
  },
  getDaemonState(): Promise<DesktopResult<DaemonSnapshot>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonState) as Promise<DesktopResult<DaemonSnapshot>>;
  },
  startDaemon(): Promise<DesktopResult<DaemonSnapshot>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonStart) as Promise<DesktopResult<DaemonSnapshot>>;
  },
  stopDaemon(): Promise<DesktopResult<DaemonSnapshot>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonStop) as Promise<DesktopResult<DaemonSnapshot>>;
  },
  restartDaemon(): Promise<DesktopResult<DaemonSnapshot>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonRestart) as Promise<DesktopResult<DaemonSnapshot>>;
  },
  attachExternalDaemon(): Promise<DesktopResult<DaemonSnapshot>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonAttachExternal) as Promise<DesktopResult<DaemonSnapshot>>;
  },
  getDaemonHealth(): Promise<DesktopResult<DaemonHealth>> {
    return ipcRenderer.invoke(DESKTOP_IPC.daemonHealth) as Promise<DesktopResult<DaemonHealth>>;
  },
  getServiceStatus(): Promise<DesktopResult<ServiceStatusPayload>> {
    return ipcRenderer.invoke(DESKTOP_IPC.serviceStatus) as Promise<DesktopResult<ServiceStatusPayload>>;
  },
  getReadiness(): Promise<DesktopResult<ReadinessPayload>> {
    return ipcRenderer.invoke(DESKTOP_IPC.readiness) as Promise<DesktopResult<ReadinessPayload>>;
  },
  listWorkspaces(): Promise<DesktopResult<WorkspaceSummary[]>> {
    return ipcRenderer.invoke(DESKTOP_IPC.listWorkspaces) as Promise<DesktopResult<WorkspaceSummary[]>>;
  },
  pickWorkspaceDirectory(): Promise<DesktopResult<{ path: string } | null>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspacePickDirectory) as Promise<DesktopResult<{ path: string } | null>>;
  },
  listManagedWorkspaces(): Promise<DesktopResult<ManagedWorkspaceView[]>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspaceManagedList) as Promise<DesktopResult<ManagedWorkspaceView[]>>;
  },
  validateManagedWorkspace(input: ManagedWorkspaceInput): Promise<DesktopResult<WorkspaceValidation>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspaceValidate, input) as Promise<DesktopResult<WorkspaceValidation>>;
  },
  saveManagedWorkspace(input: ManagedWorkspaceInput): Promise<DesktopResult<ManagedWorkspaceView>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspaceSave, input) as Promise<DesktopResult<ManagedWorkspaceView>>;
  },
  removeManagedWorkspace(id: string): Promise<DesktopResult<{ removed: boolean }>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspaceRemove, id) as Promise<DesktopResult<{ removed: boolean }>>;
  },
  indexManagedWorkspace(id: string): Promise<DesktopResult<WorkspaceIndexResult>> {
    return ipcRenderer.invoke(DESKTOP_IPC.workspaceIndex, id) as Promise<DesktopResult<WorkspaceIndexResult>>;
  },
  getAuth0State(): Promise<DesktopResult<Auth0SessionView>> {
    return ipcRenderer.invoke(DESKTOP_IPC.auth0State) as Promise<DesktopResult<Auth0SessionView>>;
  },
  signInAuth0(): Promise<DesktopResult<Auth0SessionView>> {
    return ipcRenderer.invoke(DESKTOP_IPC.auth0SignIn) as Promise<DesktopResult<Auth0SessionView>>;
  },
  refreshAuth0(): Promise<DesktopResult<Auth0SessionView>> {
    return ipcRenderer.invoke(DESKTOP_IPC.auth0Refresh) as Promise<DesktopResult<Auth0SessionView>>;
  },
  logoutAuth0(): Promise<DesktopResult<Auth0SessionView>> {
    return ipcRenderer.invoke(DESKTOP_IPC.auth0Logout) as Promise<DesktopResult<Auth0SessionView>>;
  },
  cancelOperation(operationId: string): Promise<DesktopResult<{ cancelled: boolean }>> {
    return ipcRenderer.invoke(DESKTOP_IPC.cancelOperation, operationId) as Promise<DesktopResult<{ cancelled: boolean }>>;
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
