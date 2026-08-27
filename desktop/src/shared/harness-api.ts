import type { DesktopResult } from "./desktop-api";

export const HARNESS_IPC = {
  listRuns: "desktop:harness-runs-list",
  getRun: "desktop:harness-run-get",
  listEvents: "desktop:harness-run-events",
  listJobs: "desktop:harness-jobs-list",
  cancelRun: "desktop:harness-run-cancel",
  cancelJob: "desktop:harness-job-cancel",
} as const;

export interface DesktopHarnessRunListInput { limit?: number; }
export interface DesktopHarnessRunIdInput { runId: string; }
export interface DesktopHarnessEventsInput { runId: string; afterSeq?: number; limit?: number; }
export interface DesktopHarnessJobListInput { runId: string; limit?: number; }
export interface DesktopHarnessJobCancelInput { runId: string; jobId: string; }

export interface DesktopHarnessCheckpointView {
  id: string;
  eventSeq: number;
  state: string;
  reason: string;
  createdAt: number;
}

export interface DesktopHarnessRunView {
  id: string;
  workspace: string;
  profile: string;
  status: string;
  freshnessState: string;
  freshnessReason?: string;
  recoveryState: string;
  recoveryReason: string;
  pendingApprovals: number;
  activeJobs: number;
  uncertainMutations: number;
  retryableReadExecutions: number;
  retryablePreDispatchExecutions: number;
  blockedPreDispatchExecutions: number;
  checkpoint?: DesktopHarnessCheckpointView;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DesktopHarnessEventView {
  seq: number;
  eventType: string;
  summary: string;
  createdAt: number;
}

export interface DesktopHarnessJobView {
  id: string;
  runId: string;
  workspace: string;
  kind: string;
  taskId?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    listHarnessRuns(input?: DesktopHarnessRunListInput): Promise<DesktopResult<DesktopHarnessRunView[]>>;
    getHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    listHarnessEvents(input: DesktopHarnessEventsInput): Promise<DesktopResult<DesktopHarnessEventView[]>>;
    listHarnessJobs(input: DesktopHarnessJobListInput): Promise<DesktopResult<DesktopHarnessJobView[]>>;
    cancelHarnessRun(input: DesktopHarnessRunIdInput): Promise<DesktopResult<DesktopHarnessRunView>>;
    cancelHarnessJob(input: DesktopHarnessJobCancelInput): Promise<DesktopResult<DesktopHarnessJobView>>;
  }
}
