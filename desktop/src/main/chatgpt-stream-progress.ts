const MAX_PROGRESS_BYTES = 2_400;

export interface ChatGptTransportProgress {
  taskId: string;
  runId: string;
  workspace: string;
  text: string;
  generating: boolean;
}

const PUBLIC_PROGRESS_FIELDS = ["ANSWER", "PLAN", "REVIEW", "RESULT", "REASON", "DETAIL", "NEEDS", "SUMMARY"] as const;
const CONTROL_PROGRESS_FIELDS = ["STATE", "TASK_ID", "ITERATION", "PROOF", "PROOF_TYPE", "PROOF_COMMAND", "WORKSPACE", "HARNESS_RUN_ID", "CODEX_TURN_ID", "MODE", "HARNESS_VERIFICATION"] as const;

export function userVisibleChatGptProgressText(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const normalized = raw.replace(/\r\n/g, "\n");
  const state = normalized.match(/(?:^|\n)STATE:\s*(PLAN|DONE|BLOCKED)\s*$/im)?.[1]?.toUpperCase() ?? "";
  const preferred = state === "DONE"
    ? ["ANSWER", "REVIEW", "RESULT", "SUMMARY"]
    : state === "PLAN"
      ? ["PLAN", "SUMMARY", "DETAIL"]
      : state === "BLOCKED"
        ? ["REASON", "NEEDS", "DETAIL", "SUMMARY"]
        : [...PUBLIC_PROGRESS_FIELDS];

  for (const field of preferred) {
    const visible = publicField(normalized, field);
    if (visible) return boundUtf8(visible, MAX_PROGRESS_BYTES);
  }
  return "";
}

function publicField(value: string, field: string): string {
  const marker = new RegExp(`(?:^|\\n)${field}:\\s*`, "i");
  const match = marker.exec(value);
  if (!match) return "";
  const start = (match.index ?? 0) + match[0].length;
  let body = value.slice(start);
  const boundaryFields = [...CONTROL_PROGRESS_FIELDS, ...PUBLIC_PROGRESS_FIELDS.filter((candidate) => candidate !== field)];
  const boundary = new RegExp(`\\n(?:${boundaryFields.join("|")}):\\s*|\\n\\[C2C\\]`, "i").exec(body);
  if (boundary?.index !== undefined) body = body.slice(0, boundary.index);
  return body.replace(/\[\/?C2C\]/gi, "").trim();
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (result && Buffer.byteLength(`${result}…`, "utf8") > maxBytes) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}
