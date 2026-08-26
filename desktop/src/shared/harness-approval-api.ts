import type { DesktopResult } from "./desktop-api";

export const HARNESS_APPROVAL_IPC = {
  list: "desktop:harness-approvals-list",
  respond: "desktop:harness-approvals-respond",
} as const;

export type HarnessApprovalStatus = "pending" | "allowed" | "denied" | "consumed" | "expired";
export type HarnessApprovalDecision = "allow" | "deny";

export interface DesktopHarnessApprovalView {
  id: string;
  runId: string;
  workspace: string;
  tool: string;
  capabilityId: string;
  argumentSha256: string;
  headSha: string;
  status: HarnessApprovalStatus;
  requestedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
}

export interface DesktopHarnessApprovalListInput {
  runId: string;
  status?: HarnessApprovalStatus;
  limit?: number;
}

export interface DesktopHarnessApprovalRespondInput {
  approvalId: string;
  decision: HarnessApprovalDecision;
}

export interface DesktopHarnessApprovalRespondResult {
  approval: DesktopHarnessApprovalView;
  replayed: boolean;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    listHarnessApprovals(input: DesktopHarnessApprovalListInput): Promise<DesktopResult<DesktopHarnessApprovalView[]>>;
    respondHarnessApproval(input: DesktopHarnessApprovalRespondInput): Promise<DesktopResult<DesktopHarnessApprovalRespondResult>>;
  }
}
