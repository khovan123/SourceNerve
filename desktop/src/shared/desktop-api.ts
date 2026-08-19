export const DESKTOP_API_VERSION = 1 as const;

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

export type ServiceStatusPayload = Record<string, unknown>;
export type ReadinessPayload = Record<string, unknown>;

export interface WorkspaceSummary {
  id: string;
  name: string;
  writable: boolean;
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
  getDaemonHealth(): Promise<DesktopResult<DaemonHealth>>;
  getServiceStatus(): Promise<DesktopResult<ServiceStatusPayload>>;
  getReadiness(): Promise<DesktopResult<ReadinessPayload>>;
  listWorkspaces(): Promise<DesktopResult<WorkspaceSummary[]>>;
  cancelOperation(operationId: string): Promise<DesktopResult<{ cancelled: boolean }>>;
  subscribeRuntimeEvents(listener: (event: DesktopRuntimeEvent) => void): () => void;
}

export const DESKTOP_IPC = {
  runtimeInfo: "desktop:runtime-info",
  daemonHealth: "desktop:daemon-health",
  serviceStatus: "desktop:service-status",
  readiness: "desktop:readiness",
  listWorkspaces: "desktop:list-workspaces",
  cancelOperation: "desktop:cancel-operation",
  runtimeEvent: "desktop:runtime-event",
} as const;
