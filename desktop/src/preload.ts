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
  type DesktopBehaviorPreferences,
  type DesktopResult,
  type DesktopRuntimeEvent,
  type DiagnosticsCopyResult,
  type GitProvider,
  type GitTransportValidation,
  type ManagedWorkspaceView,
  type ProviderAccountView,
  type ProviderRepositorySummary,
  type PublicMcpView,
  type ReadinessPayload,
  type RuntimeInfo,
  type RuntimeLogEntry,
  type RuntimeLogSnapshot,
  type ServiceStatusPayload,
  type SourceNerveDesktopApi,
  type WorkspaceIndexResult,
  type WorkspaceRepositorySelection,
  type WorkspaceSaveInput,
  type WorkspaceSummary,
} from "./shared/desktop-api";

const api: SourceNerveDesktopApi = {
  getRuntimeInfo: () => ipcRenderer.invoke(DESKTOP_IPC.runtimeInfo) as Promise<DesktopResult<RuntimeInfo>>,
  getDaemonState: () => ipcRenderer.invoke(DESKTOP_IPC.daemonState) as Promise<DesktopResult<DaemonSnapshot>>,
  startDaemon: () => ipcRenderer.invoke(DESKTOP_IPC.daemonStart) as Promise<DesktopResult<DaemonSnapshot>>,
  stopDaemon: () => ipcRenderer.invoke(DESKTOP_IPC.daemonStop) as Promise<DesktopResult<DaemonSnapshot>>,
  restartDaemon: () => ipcRenderer.invoke(DESKTOP_IPC.daemonRestart) as Promise<DesktopResult<DaemonSnapshot>>,
  attachExternalDaemon: () => ipcRenderer.invoke(DESKTOP_IPC.daemonAttachExternal) as Promise<DesktopResult<DaemonSnapshot>>,
  getDaemonHealth: () => ipcRenderer.invoke(DESKTOP_IPC.daemonHealth) as Promise<DesktopResult<DaemonHealth>>,
  getServiceStatus: () => ipcRenderer.invoke(DESKTOP_IPC.serviceStatus) as Promise<DesktopResult<ServiceStatusPayload>>,
  getReadiness: () => ipcRenderer.invoke(DESKTOP_IPC.readiness) as Promise<DesktopResult<ReadinessPayload>>,
  listWorkspaces: () => ipcRenderer.invoke(DESKTOP_IPC.listWorkspaces) as Promise<DesktopResult<WorkspaceSummary[]>>,
  pickWorkspaceRepository: () => ipcRenderer.invoke(DESKTOP_IPC.workspacePickRepository) as Promise<DesktopResult<WorkspaceRepositorySelection | null>>,
  listManagedWorkspaces: () => ipcRenderer.invoke(DESKTOP_IPC.workspaceListManaged) as Promise<DesktopResult<ManagedWorkspaceView[]>>,
  saveWorkspace: (input: WorkspaceSaveInput) => ipcRenderer.invoke(DESKTOP_IPC.workspaceSave, input) as Promise<DesktopResult<ManagedWorkspaceView>>,
  removeWorkspace: (workspaceId: string) => ipcRenderer.invoke(DESKTOP_IPC.workspaceRemove, workspaceId) as Promise<DesktopResult<{ removed: boolean }>>,
  indexWorkspace: (workspaceId: string) => ipcRenderer.invoke(DESKTOP_IPC.workspaceIndex, workspaceId) as Promise<DesktopResult<WorkspaceIndexResult>>,
  getAuth0State: () => ipcRenderer.invoke(DESKTOP_IPC.auth0State) as Promise<DesktopResult<Auth0SessionView>>,
  signInAuth0: () => ipcRenderer.invoke(DESKTOP_IPC.auth0SignIn) as Promise<DesktopResult<Auth0SessionView>>,
  refreshAuth0: () => ipcRenderer.invoke(DESKTOP_IPC.auth0Refresh) as Promise<DesktopResult<Auth0SessionView>>,
  logoutAuth0: () => ipcRenderer.invoke(DESKTOP_IPC.auth0Logout) as Promise<DesktopResult<Auth0SessionView>>,
  getProviderStates: () => ipcRenderer.invoke(DESKTOP_IPC.providerStates) as Promise<DesktopResult<ProviderAccountView[]>>,
  connectProvider: (provider: GitProvider) => ipcRenderer.invoke(DESKTOP_IPC.providerConnect, provider) as Promise<DesktopResult<ProviderAccountView>>,
  disconnectProvider: (provider: GitProvider) => ipcRenderer.invoke(DESKTOP_IPC.providerDisconnect, provider) as Promise<DesktopResult<ProviderAccountView>>,
  listProviderRepositories: (provider: GitProvider) => ipcRenderer.invoke(DESKTOP_IPC.providerRepositories, provider) as Promise<DesktopResult<ProviderRepositorySummary[]>>,
  validateProviderRepository: (provider: GitProvider, repository: string) => ipcRenderer.invoke(DESKTOP_IPC.providerValidateRepository, provider, repository) as Promise<DesktopResult<ProviderRepositorySummary>>,
  validateGitTransport: (workspaceId: string) => ipcRenderer.invoke(DESKTOP_IPC.providerValidateTransport, workspaceId) as Promise<DesktopResult<GitTransportValidation>>,
  getPublicMcpState: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpState) as Promise<DesktopResult<PublicMcpView>>,
  enrollPublicMcp: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpEnroll) as Promise<DesktopResult<PublicMcpView>>,
  retryPublicMcp: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpRetry) as Promise<DesktopResult<PublicMcpView>>,
  rotatePublicMcpCredential: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpRotate) as Promise<DesktopResult<PublicMcpView>>,
  revokePublicMcp: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpRevoke) as Promise<DesktopResult<PublicMcpView>>,
  reEnrollPublicMcp: () => ipcRenderer.invoke(DESKTOP_IPC.publicMcpReEnroll) as Promise<DesktopResult<PublicMcpView>>,
  getRuntimeLogs: () => ipcRenderer.invoke(DESKTOP_IPC.runtimeLogs) as Promise<DesktopResult<RuntimeLogSnapshot>>,
  copyDiagnostics: () => ipcRenderer.invoke(DESKTOP_IPC.diagnosticsCopy) as Promise<DesktopResult<DiagnosticsCopyResult>>,
  getDesktopBehavior: () => ipcRenderer.invoke(DESKTOP_IPC.desktopBehavior) as Promise<DesktopResult<DesktopBehaviorPreferences>>,
  updateDesktopBehavior: (preferences: DesktopBehaviorPreferences) => ipcRenderer.invoke(DESKTOP_IPC.desktopBehaviorUpdate, preferences) as Promise<DesktopResult<DesktopBehaviorPreferences>>,
  cancelOperation: (operationId: string) => ipcRenderer.invoke(DESKTOP_IPC.cancelOperation, operationId) as Promise<DesktopResult<{ cancelled: boolean }>>,
  subscribeRuntimeEvents(listener: (event: DesktopRuntimeEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: DesktopRuntimeEvent) => listener(payload);
    ipcRenderer.on(DESKTOP_IPC.runtimeEvent, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.runtimeEvent, handler);
  },
  subscribeRuntimeLogs(listener: (entry: RuntimeLogEntry) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: RuntimeLogEntry) => listener(payload);
    ipcRenderer.on(DESKTOP_IPC.runtimeLogEvent, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.runtimeLogEvent, handler);
  },
};

contextBridge.exposeInMainWorld("sourcenerveDesktop", api);
