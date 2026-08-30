import type { DesktopResult } from "./desktop-api";

export const AGENT_IPC = {
  listTurns: "desktop:agent-turns-list",
  memoryPreview: "desktop:agent-memory-preview",
  evaluate: "desktop:agent-evaluate",
  listEvaluations: "desktop:agent-evaluations-list",
} as const;

export type DesktopAgentTurnStatus = "running" | "completed" | "failed" | "cancelled" | "iteration-limit";
export type DesktopAgentVerdict = "pass" | "fail";

export interface DesktopAgentTurnListInput { runId: string; limit?: number; }
export interface DesktopAgentMemoryPreviewInput { runId: string; query: string; }
export interface DesktopAgentEvaluateInput { turnId: string; }
export interface DesktopAgentEvaluationListInput { turnId: string; limit?: number; }

export interface DesktopAgentTurnView {
  id: string;
  runId: string;
  status: DesktopAgentTurnStatus;
  maxIterations: number;
  iterationCount: number;
  providerId?: string;
  modelId?: string;
  stopReason?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DesktopAgentMemoryPreview {
  semantic: Array<{ path: string; startLine: number; endLine: number; score: number }>;
  episodic: Array<{ seq: number; eventType: string; tool?: string; decision?: string; route?: string; resultCategory?: string; errorCategory?: string; proofType?: string }>;
  procedural: {
    entrypoints: string[];
    guidance: string[];
    activePlans: string[];
    validationOwners: string[];
    closedLoopPhase: string;
    verificationStatus: string;
    recoveryStatus: string;
    selectedProofType?: string;
    learningHints: Array<{ tool: string; errorCategory: string; suggestion: string; state: string }>;
  };
}

export interface DesktopAgentEvaluationView {
  id: string;
  turnId: string;
  evaluatorVersion: number;
  deterministicVerdict: DesktopAgentVerdict;
  finalVerdict: DesktopAgentVerdict;
  judgeVerdict?: DesktopAgentVerdict;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  metrics: {
    iterations: number;
    maxIterations: number;
    contextReads: number;
    executions: number;
    failureCount: number;
    learningCount: number;
    satisfiedProofs: number;
    inputTokens: number;
    outputTokens: number;
  };
  createdAt: number;
}

declare module "./desktop-api" {
  interface SourceNerveDesktopApi {
    listAgentTurns(input: DesktopAgentTurnListInput): Promise<DesktopResult<DesktopAgentTurnView[]>>;
    previewAgentMemory(input: DesktopAgentMemoryPreviewInput): Promise<DesktopResult<DesktopAgentMemoryPreview>>;
    evaluateAgentTurn(input: DesktopAgentEvaluateInput): Promise<DesktopResult<DesktopAgentEvaluationView>>;
    listAgentEvaluations(input: DesktopAgentEvaluationListInput): Promise<DesktopResult<DesktopAgentEvaluationView[]>>;
  }
}
