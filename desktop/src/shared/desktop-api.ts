export const DESKTOP_API_VERSION = 3 as const;

export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  desktopVersion: string;
  electronVersion: string;
  apiVersion: typeof DESKTOP_API_VERSION;
  bootstrap: {
    ready: boolean;
    profileSchemaVersion?: number;
    secureStorageBackend?: string;
    error?: string;
  };
}

export interface DaemonHealth {
  status: "ok";
}

export type DaemonRuntimeState =
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "crashed"
  | "external"
  | "incompatible";

export interface DaemonSnapshot {
  state: DaemonRuntimeState;
  managed: boolean;
  pid?: number;
  version?: string;
  exitCode?: number | null;
  signal?: string;
  message?: string;
}

export type ServiceStatusPayload = Record<string, unknown>;
export type ReadinessPayload = Record<string, unknown>;

export interface WorkspaceSummary {
  id: string;
  name: string;
  writable: boolean;
}

export type WorkspaceAccess = "read-only" | "read-write";
export type WorkspaceProvider = "github" | "gitlab";
export type GitProvider = WorkspaceProvider;
export type WorkspaceIndexState = "current" | "stale" | "not-indexed" | "unavailable";

export interface WorkspaceRepositorySelection {
  selectionId: string;
  root: string;
  suggestedId: string;
  suggestedName: string;
  remote: string;
  remotes: string[];
  defaultBranch: string;
  provider?: WorkspaceProvider;
  repository?: string;
  head: string;
  branch?: string;
  dirty: boolean;
  localWritable: boolean;
}

export interface ManagedWorkspaceView {
  id: string;
  name: string;
  root: string;
  access: WorkspaceAccess;
  remote: string;
  defaultBranch: string;
  provider?: WorkspaceProvider;
  repository?: string;
  validation: {
    state: "ready" | "invalid";
    message?: string;
  };
  head?: string;
  branch?: string;
  dirty?: boolean;
  localWritable?: boolean;
  index: {
    state: WorkspaceIndexState;
    indexedHead?: string;
    graphVersion?: number;
    parsedFiles?: number;
    failedFiles?: number;
  };
}

export interface WorkspaceSaveInput {
  originalId?: string;
  selectionId?: string;
  id: string;
  name: string;
  access: WorkspaceAccess;
  remote: string;
  defaultBranch: string;
}

export interface WorkspaceIndexResult {
  workspace: string;
  head: string;
  discoveredFiles: number;
  indexedTextFiles: number;
  graph: {
    parsedFiles: number;
    partialFiles: number;
    failedFiles: number;
    symbols: number;
    edges: number;
    unresolvedReferences: number;
  };
}

export interface Auth0Identity {
  subject: string;
  name?: string;
  email?: string;
}

export interface Auth0WorkspaceGrant {
  workspace: string;
  access: WorkspaceAccess;
}

export interface Auth0SessionView {
  status: "signed-out" | "signing-in" | "authenticated" | "expired" | "error";
  identity?: Auth0Identity;
  expiresAt?: number;
  scopes?: string[];
  workspaceGrants?: Auth0WorkspaceGrant[];
  error?: string;
}

export interface ProviderDeviceLoginView {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface ProviderAccountView {
  provider: GitProvider;
  status: "disconnected" | "awaiting-user" | "connected" | "error";
  baseUrl: string;
  login?: string;
  name?: string;
  providerUserId?: string;
  connectedAt?: number;
  deviceLogin?: ProviderDeviceLoginView;
  error?: string;
}

export interface ProviderRepositorySummary {
  provider: GitProvider;
  slug: string;
  name: string;
  defaultBranch?: string;
  private: boolean;
  writable: boolean;
  webUrl: string;
  httpsCloneUrl?: string;
  sshCloneUrl?: string;
}

export interface GitTransportValidation {
  workspace: string;
  ready: boolean;
  transport: "ssh" | "https" | "other";
  message: string;
}

export interface DesktopError {
  code:
    | "invalid_request"
    | "not_ready"
    | "timeout"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "service_error"
    | "transport_error"
    | "cancelled"
    | "internal_error";
  message: string;
  retryable: boolean;
  fieldDetails?: Record<string, string>;
}

export type DesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopError };

export type RuntimeComponent =
  | "desktop"
  | "daemon"
  | "public-mcp"
  | "auth"
  | "git"
  | "provider"
  | "workspace";

export type DesktopRuntimeEvent =
  | {
      type: "state";
      component: RuntimeComponent;
      state: string;
      message?: string;
    }
  | {
      type: "log";
      component: RuntimeComponent;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      timestamp: string;
    }
  | {
      type: "progress";
      operationId: string;
      stage: string;
      current?: number;
      total?: number;
    };

export interface SourceNerveDesktopApi {
  getRuntimeInfo(): Promise<DesktopResult<RuntimeInfo>>;
  getDaemonState(): Promise<DesktopResult<DaemonSnapshot>>;
  startDaemon(): Promise<DesktopResult<DaemonSnapshot>>;
  stopDaemon(): Promise<DesktopResult<DaemonSnapshot>>;
  restartDaemon(): Promise<DesktopResult<DaemonSnapshot>>;
  attachExternalDaemon(): Promise<DesktopResult<DaemonSnapshot>>;
  getDaemonHealth(): Promise<DesktopResult<DaemonHealth>>;
  getServiceStatus(): Promise<DesktopResult<ServiceStatusPayload>>;
  getReadiness(): Promise<DesktopResult<ReadinessPayload>>;
  listWorkspaces(): Promise<DesktopResult<WorkspaceSummary[]>>;
  pickWorkspaceRepository(): Promise<DesktopResult<WorkspaceRepositorySelection | null>>;
  listManagedWorkspaces(): Promise<DesktopResult<ManagedWorkspaceView[]>>;
  saveWorkspace(input: WorkspaceSaveInput): Promise<DesktopResult<ManagedWorkspaceView>>;
  removeWorkspace(workspaceId: string): Promise<DesktopResult<{ removed: boolean }>>;
  indexWorkspace(workspaceId: string): Promise<DesktopResult<WorkspaceIndexResult>>;
  getAuth0State(): Promise<DesktopResult<Auth0SessionView>>;
  signInAuth0(): Promise<DesktopResult<Auth0SessionView>>;
  refreshAuth0(): Promise<DesktopResult<Auth0SessionView>>;
  logoutAuth0(): Promise<DesktopResult<Auth0SessionView>>;
  getProviderStates(): Promise<DesktopResult<ProviderAccountView[]>>;
  connectProvider(provider: GitProvider): Promise<DesktopResult<ProviderAccountView>>;
  disconnectProvider(provider: GitProvider): Promise<DesktopResult<ProviderAccountView>>;
  listProviderRepositories(provider: GitProvider): Promise<DesktopResult<ProviderRepositorySummary[]>>;
  validateProviderRepository(provider: GitProvider, repository: string): Promise<DesktopResult<ProviderRepositorySummary>>;
  validateGitTransport(workspaceId: string): Promise<DesktopResult<GitTransportValidation>>;
  cancelOperation(operationId: string): Promise<DesktopResult<{ cancelled: boolean }>>;
  subscribeRuntimeEvents(listener: (event: DesktopRuntimeEvent) => void): () => void;
}

export const DESKTOP_IPC = {
  runtimeInfo: "desktop:runtime-info",
  daemonState: "desktop:daemon-state",
  daemonStart: "desktop:daemon-start",
  daemonStop: "desktop:daemon-stop",
  daemonRestart: "desktop:daemon-restart",
  daemonAttachExternal: "desktop:daemon-attach-external",
  daemonHealth: "desktop:daemon-health",
  serviceStatus: "desktop:service-status",
  readiness: "desktop:readiness",
  listWorkspaces: "desktop:list-workspaces",
  workspacePickRepository: "desktop:workspace-pick-repository",
  workspaceListManaged: "desktop:workspace-list-managed",
  workspaceSave: "desktop:workspace-save",
  workspaceRemove: "desktop:workspace-remove",
  workspaceIndex: "desktop:workspace-index",
  auth0State: "desktop:auth0-state",
  auth0SignIn: "desktop:auth0-sign-in",
  auth0Refresh: "desktop:auth0-refresh",
  auth0Logout: "desktop:auth0-logout",
  providerStates: "desktop:provider-states",
  providerConnect: "desktop:provider-connect",
  providerDisconnect: "desktop:provider-disconnect",
  providerRepositories: "desktop:provider-repositories",
  providerValidateRepository: "desktop:provider-validate-repository",
  providerValidateTransport: "desktop:provider-validate-transport",
  cancelOperation: "desktop:cancel-operation",
  runtimeEvent: "desktop:runtime-event",
} as const;
