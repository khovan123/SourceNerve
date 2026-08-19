import type { DesktopResult } from "./desktop-api";
import type { IntelligenceContextPack } from "./intelligence-api";

export const TASK_IPC = {
  list: "desktop:tasks-list",
  begin: "desktop:tasks-begin",
  remember: "desktop:tasks-remember",
  get: "desktop:tasks-get",
  cancel: "desktop:tasks-cancel",
  branch: "desktop:tasks-branch",
  propose: "desktop:tasks-propose",
  apply: "desktop:tasks-apply",
  review: "desktop:tasks-review",
  commit: "desktop:tasks-commit",
  push: "desktop:tasks-push",
} as const;

export type DesktopTaskStatus = "active" | "stale" | "applied" | "cancelled";
export type DesktopTaskPhase = "snapshot" | "branched" | "patched" | "reviewed" | "committed" | "pushed" | "pr_open" | "merged" | "completed";
export type DesktopTaskProposalStatus = "proposed" | "applied" | "rejected";

export interface DesktopTaskReference {
  taskId: string;
  workspace: string;
  createdAt: string;
}
