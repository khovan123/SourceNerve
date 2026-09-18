import { randomUUID } from "node:crypto";

export type AgentWorkerStatus = "sleeping" | "claimed" | "running" | "reported" | "retired";

export interface AgentWorkerFamily {
  familyId: string;
  primeRunId: string;
  incarnation: number;
  workers: AgentWorker[];
}

export interface AgentWorker {
  workerRunId: string;
  ordinal: number;
  workspace: string;
  status: AgentWorkerStatus;
  leaseId?: string;
  lastReport?: string;
  lastChildRunId?: string;
}

export class AgentWorkerFamilyRegistry {
  private families = new Map<string, AgentWorkerFamily>();

  create(input: { primeRunId: string; workspace: string; workerCount: number }): AgentWorkerFamily {
    const familyId = `family_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const workspace = boundId(input.workspace, "workspace");
    const count = boundWorkerCount(input.workerCount);
    const family: AgentWorkerFamily = {
      familyId,
      primeRunId: boundId(input.primeRunId, "prime run id"),
      incarnation: 1,
      workers: Array.from({ length: count }, (_, index) => ({
        workerRunId: `worker_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        ordinal: index + 1,
        workspace,
        status: "sleeping" as const,
      })),
    };
    this.families.set(familyId, family);
    return cloneFamily(family);
  }

  claim(input: { familyId: string; workerRunId: string; leaseId: string; childRunId: string }): AgentWorker {
    const worker = this.requireWorker(input.familyId, input.workerRunId);
    if (worker.status !== "sleeping" && worker.status !== "reported") throw new Error("Agent worker is not claimable");
    worker.status = "claimed";
    worker.leaseId = boundId(input.leaseId, "worker lease id");
    worker.lastChildRunId = boundId(input.childRunId, "worker child run id");
    return { ...worker };
  }

  markRunning(input: { familyId: string; workerRunId: string; leaseId: string }): AgentWorker {
    const worker = this.requireWorker(input.familyId, input.workerRunId);
    if (worker.leaseId !== input.leaseId) throw new Error("Agent worker lease does not match this family/incarnation");
    if (worker.status !== "claimed") throw new Error("Agent worker must be claimed before running");
    worker.status = "running";
    return { ...worker };
  }

  report(input: { familyId: string; workerRunId: string; leaseId: string; report: string }): AgentWorker {
    const worker = this.requireWorker(input.familyId, input.workerRunId);
    if (worker.leaseId !== input.leaseId) throw new Error("Agent worker lease does not match this family/incarnation");
    if (worker.status !== "claimed" && worker.status !== "running") throw new Error("Agent worker is not running under this lease");
    worker.status = "reported";
    worker.lastReport = boundText(input.report, 32 * 1024);
    return { ...worker };
  }

  retire(input: { familyId: string; workerRunId: string }): AgentWorker {
    const worker = this.requireWorker(input.familyId, input.workerRunId);
    worker.status = "retired";
    return { ...worker };
  }

  get(familyId: string): AgentWorkerFamily {
    return cloneFamily(this.requireFamily(familyId));
  }

  private requireFamily(familyId: string): AgentWorkerFamily {
    const family = this.families.get(boundId(familyId, "family id"));
    if (!family) throw new Error("Agent worker family is not found");
    return family;
  }

  private requireWorker(familyId: string, workerRunId: string): AgentWorker {
    const family = this.requireFamily(familyId);
    const worker = family.workers.find((item) => item.workerRunId === workerRunId);
    if (!worker) throw new Error("Agent worker does not belong to this family/incarnation");
    return worker;
  }
}

function cloneFamily(family: AgentWorkerFamily): AgentWorkerFamily {
  return { ...family, workers: family.workers.map((worker) => ({ ...worker })) };
}

function boundWorkerCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error("Agent worker count must be 1-8");
  return value;
}

function boundId(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}
