import type { AgentModelMessage } from "./agent-model-adapter";

const DEFAULT_MAX_SESSION_BYTES = 128 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;

export interface AgentSessionSeed {
  userMessage: string;
  context?: readonly string[];
  maxBytes?: number;
}

/**
 * In-memory working context for one agent turn. It is deliberately not a
 * persistence layer; durable semantic/episodic/procedural memory stays in the
 * SourceNerve core and Harness event ledger.
 */
export class AgentSession {
  private readonly messages: AgentModelMessage[] = [];
  private usedBytes = 0;
  readonly maxBytes: number;

  constructor(seed: AgentSessionSeed) {
    this.maxBytes = boundedPositive(seed.maxBytes ?? DEFAULT_MAX_SESSION_BYTES, 1024, 512 * 1024, "agent session maxBytes");
    this.append("user", seed.userMessage);
    for (const context of seed.context ?? []) this.append("context", context);
  }

  snapshot(): readonly AgentModelMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  appendToolObservation(toolName: string, value: unknown): void {
    const safeName = boundedText(toolName, 128, "agent tool name");
    this.append("tool", stableObservation(value), safeName);
  }

  appendContext(content: string): void {
    this.append("context", content);
  }

  private append(role: AgentModelMessage["role"], content: string, toolName?: string): void {
    const bounded = boundedText(content, MAX_MESSAGE_BYTES, `agent ${role} message`);
    const bytes = Buffer.byteLength(bounded, "utf8") + (toolName ? Buffer.byteLength(toolName, "utf8") : 0);
    if (this.usedBytes + bytes > this.maxBytes) {
      throw new Error("Agent working context exceeded its bounded session budget");
    }
    this.messages.push({ role, content: bounded, ...(toolName ? { toolName } : {}) });
    this.usedBytes += bytes;
  }
}

function stableObservation(value: unknown): string {
  if (typeof value === "string") return boundedText(value, MAX_MESSAGE_BYTES, "agent tool observation");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Agent tool observation is not JSON serializable");
  }
  return boundedText(serialized ?? "null", MAX_MESSAGE_BYTES, "agent tool observation");
}

function boundedText(value: string, maxBytes: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000]/.test(value)) throw new Error(`${label} is invalid`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function boundedPositive(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}-${max}`);
  return value;
}
