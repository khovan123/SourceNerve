export const DESKTOP_API_VERSION = 4 as const;

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
export type GitProvider = "github" | "gitlab";

export interface ManagedWorkspaceInput {
  id: string;
  name: string;
  root: string;
  access: WorkspaceAccess;
  remote: string;
  defaultBranch: string;
  provider?: GitProvider;
  repository?: string;
}

export interface WorkspaceValidation {
  valid: boolean;
  canonicalRoot?: string;
  head?: string;
  currentBranch?: string;
  dirty?: boolean;
  status?: string;
  remoteUrl?: string;
  defaultBranchExists: boolean;
  filesystemWritable: boolean;
  provider?: GitProvider;
  repository?: string;
  errors: string[];
  warnings: string[];
}

export interface ManagedWorkspaceView extends ManagedWorkspaceInput {
  validation: WorkspaceValidation;
  indexed: boolean;
  graphVersion?: number;
}

export interface WorkspaceIndexResult {
  workspace: string;
  indexed: boolean;
  graphVersion?: number;
  head?: string;
  dirty?: boolean;
}

export interface Auth0Identity {
  subject: string;
  name?: string;
  email?: string;
}

export interface Auth0WorkspaceGrantView {
  workspace: string;
  access: WorkspaceAccess;
}

export interface Auth0SessionView {
  status: "signed-out" | "signing-in" | "authenticated" | "expired" | "error";
  identity?: Auth0Identity;
  expiresAt?: number;
  scopes?: string[];
  workspaceGrants?: Auth0WorkspaceGrantView[];
  error?: string;
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
  pickWorkspaceDirectory(): Promise<DesktopResult<{ path: string } | null>>;
  listManagedWorkspaces(): Promise<DesktopResult<ManagedWorkspaceView[]>>;
  validateManagedWorkspace(input: ManagedWorkspaceInput): Promise<DesktopResult<WorkspaceValidation>>;
  saveManagedWorkspace(input: ManagedWorkspaceInput): Promise<DesktopResult<ManagedWorkspaceView>>;
  removeManagedWorkspace(id: string): Promise<DesktopResult<{ removed: boolean }>>;
  indexManagedWorkspace(id: string): Promise<DesktopResult<WorkspaceIndexResult>>;
  getAuth0State(): Promise<DesktopResult<Auth0SessionView>>;
  signInAuth0(): Promise<DesktopResult<Auth0SessionView>>;
  refreshAuth0(): Promise<DesktopResult<Auth0SessionView>>;
  logoutAuth0(): Promise<DesktopResult<Auth0SessionView>>;
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
  workspacePickDirectory: "desktop:workspace-pick-directory",
  workspaceManagedList: "desktop:workspace-managed-list",
  workspaceValidate: "desktop:workspace-validate",
  workspaceSave: "desktop:workspace-save",
  workspaceRemove: "desktop:workspace-remove",
  workspaceIndex: "desktop:workspace-index",
  auth0State: "desktop:auth0-state",
  auth0SignIn: "desktop:auth0-sign-in",
  auth0Refresh: "desktop:auth0-refresh",
  auth0Logout: "desktop:auth0-logout",
  cancelOperation: "desktop:cancel-operation",
  runtimeEvent: "desktop:runtime-event",
} as const;
