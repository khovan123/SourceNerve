import type {
  DesktopTaskFileExpectation,
  DesktopTaskProposalView,
  DesktopTaskSnapshot,
} from "../shared/task-api";

export interface TaskExpectationDraft {
  key: number;
  path: string;
  newFile: boolean;
  sha256?: string;
  message?: string;
}

export interface TaskSessionProposalReview {
  proposal: DesktopTaskProposalView;
  patch: string;
  expectedFiles: DesktopTaskFileExpectation[];
}

export const TASK_PHASES = ["snapshot", "branched", "patched", "reviewed", "committed", "pushed"] as const;

export function suggestTaskBranch(snapshot: DesktopTaskSnapshot): string {
  return `sourcenerve/task-${snapshot.task.id.slice(0, 8)}`;
}

export function shortTaskSha(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function formatTaskTimestamp(value: number): string {
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
