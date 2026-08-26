import type {
  DesktopHarnessApprovalRespondResult,
  DesktopHarnessApprovalView,
  HarnessApprovalStatus,
} from "../shared/harness-approval-api";

export function parseHarnessApprovalList(value: unknown): DesktopHarnessApprovalView[] {
  const record = asRecord(value, "Harness approval list response");
  if (!Array.isArray(record.approvals)) throw new Error("Harness approval list is invalid");
  return record.approvals.map(parseHarnessApproval);
}

export function parseHarnessApprovalRespond(value: unknown): DesktopHarnessApprovalRespondResult {
  const record = asRecord(value, "Harness approval response");
  if (typeof record.replayed !== "boolean") throw new Error("Harness approval replay flag is invalid");
  return {
    approval: parseHarnessApproval(record.approval),
    replayed: record.replayed,
  };
}

function parseHarnessApproval(value: unknown): DesktopHarnessApprovalView {
  const record = asRecord(value, "Harness approval");
  const status = parseStatus(record.status);
  const id = boundedString(record.id, 128, "approval id");
  const runId = boundedString(record.run_id, 128, "run id");
  const workspace = boundedString(record.workspace, 128, "workspace");
  const tool = boundedString(record.tool, 160, "tool");
  const capabilityId = boundedString(record.capability_id, 256, "capability id");
  const argumentSha256 = sha256(record.argument_sha256, "argument SHA-256");
  const headSha = commitSha(record.head_sha, "HEAD SHA");
  const requestedAt = nonNegativeInteger(record.requested_at, "requested_at");
  const expiresAt = nonNegativeInteger(record.expires_at, "expires_at");
  const resolvedAt = optionalNonNegativeInteger(record.resolved_at, "resolved_at");
  const consumedAt = optionalNonNegativeInteger(record.consumed_at, "consumed_at");
  return {
    id,
    runId,
    workspace,
    tool,
    capabilityId,
    argumentSha256,
    headSha,
    status,
    requestedAt,
    expiresAt,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(consumedAt !== undefined ? { consumedAt } : {}),
  };
}

function parseStatus(value: unknown): HarnessApprovalStatus {
  if (value === "pending" || value === "allowed" || value === "denied" || value === "consumed" || value === "expired") return value;
  throw new Error("Harness approval status is invalid");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Harness approval ${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`Harness approval ${label} is invalid`);
  return value.toLowerCase();
}

function commitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Harness approval ${label} is invalid`);
  return value.toLowerCase();
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Harness approval ${label} is invalid`);
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return nonNegativeInteger(value, label);
}
