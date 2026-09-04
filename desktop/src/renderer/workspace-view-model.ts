import type { ManagedWorkspaceView, WorkspaceAccess, WorkspaceRepositorySelection } from "../shared/desktop-api";

export interface WorkspaceDraft {
  originalId?: string;
  selection?: WorkspaceRepositorySelection;
  id: string;
  name: string;
  access: WorkspaceAccess;
  remote: string;
  defaultBranch: string;
  root: string;
}

export type WorkspaceStatusTone = "neutral" | "ready" | "working" | "warning" | "danger";

export function compactWorkspacePath(value: string): string {
  if (value.length <= 72) return value;
  return `${value.slice(0, 28)}…${value.slice(-40)}`;
}
