import type { SourceNerveClient } from "./sourcenerve-client";

export interface AgentSemanticMemoryItem {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

export interface AgentMemoryEpisode {
  seq: number;
  eventType: string;
  createdAt: number;
  tool?: string;
  state?: string;
  decision?: string;
  route?: string;
  resultCategory?: string;
  errorCategory?: string;
  proofType?: string;
}

export interface AgentProceduralMemory {
  entrypoints: string[];
  guidance: string[];
  activePlans: string[];
  validationOwners: string[];
  closedLoopPhase: string;
  verificationStatus: string;
  recoveryStatus: string;
  selectedProofType?: string;
  learningHints: Array<{ tool: string; errorCategory: string; suggestion: string; state: string }>;
}

export interface AgentMemoryBundle {
  runId: string;
  semantic: AgentSemanticMemoryItem[];
  episodic: AgentMemoryEpisode[];
  procedural: AgentProceduralMemory;
}

export class AgentMemoryClient {
  constructor(private readonly client: SourceNerveClient) {}

  async retrieve(input: { runId: string; query: string; maxItems?: number; maxBytes?: number; maxEpisodes?: number }): Promise<AgentMemoryBundle> {
    const raw = await this.client.harnessRequest("/api/v1/harness/agent/memory", {
      run_id: input.runId,
      query: input.query,
      max_items: input.maxItems ?? 12,
      max_bytes: input.maxBytes ?? 48 * 1024,
      max_episodes: input.maxEpisodes ?? 20,
    });
    return parseAgentMemory(raw);
  }
}

export function memoryContextMessages(memory: AgentMemoryBundle): string[] {
  const semantic = memory.semantic.map((item) =>
    `[repository:${item.path}:${item.startLine}-${item.endLine} score=${item.score}]\n${item.content}`,
  );
  const episodes = memory.episodic.length === 0
    ? []
    : [`[episodic]\n${memory.episodic.map((episode) => {
        const facts = [episode.eventType, episode.tool, episode.decision, episode.route, episode.resultCategory, episode.errorCategory, episode.proofType]
          .filter(Boolean)
          .join(" | ");
        return `#${episode.seq} ${facts}`;
      }).join("\n")}`];
  const procedure = [
    `[procedural] phase=${memory.procedural.closedLoopPhase} verification=${memory.procedural.verificationStatus} recovery=${memory.procedural.recoveryStatus}`,
    memory.procedural.entrypoints.length ? `entrypoints: ${memory.procedural.entrypoints.join(", ")}` : "",
    memory.procedural.guidance.length ? `guidance: ${memory.procedural.guidance.join(", ")}` : "",
    memory.procedural.activePlans.length ? `active plans: ${memory.procedural.activePlans.join(", ")}` : "",
    memory.procedural.learningHints.length ? `learning: ${memory.procedural.learningHints.map((hint) => `${hint.tool}/${hint.errorCategory}: ${hint.suggestion}`).join("; ")}` : "",
  ].filter(Boolean).join("\n");
  return [...semantic, ...episodes, procedure].filter((value) => value.length > 0);
}

function parseAgentMemory(value: unknown): AgentMemoryBundle {
  const root = record(value, "agent memory");
  const semanticRoot = record(root.semantic, "agent semantic memory");
  const proceduralRoot = record(root.procedural, "agent procedural memory");
  const repository = record(proceduralRoot.repository_context, "agent repository context");
  return {
    runId: text(root.run_id, 128, "agent memory run id"),
    semantic: array(semanticRoot.items, "agent semantic items").map((item) => {
      const row = record(item, "agent semantic item");
      return {
        path: text(row.path, 4096, "agent semantic path"),
        startLine: integer(row.start_line, 1, Number.MAX_SAFE_INTEGER, "agent semantic start line"),
        endLine: integer(row.end_line, 1, Number.MAX_SAFE_INTEGER, "agent semantic end line"),
        content: text(row.content, 128 * 1024, "agent semantic content", true),
        score: integer(row.score, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "agent semantic score"),
      };
    }),
    episodic: array(root.episodic, "agent episodic memory").map((item) => {
      const row = record(item, "agent episodic item");
      return {
        seq: integer(row.seq, 0, Number.MAX_SAFE_INTEGER, "agent episode seq"),
        eventType: text(row.event_type, 128, "agent episode type"),
        createdAt: integer(row.created_at, 0, Number.MAX_SAFE_INTEGER, "agent episode timestamp"),
        ...optionalFields(row),
      };
    }),
    procedural: {
      entrypoints: stringArray(repository.entrypoints, "agent entrypoints"),
      guidance: stringArray(repository.guidance, "agent guidance"),
      activePlans: stringArray(repository.active_plans, "agent active plans"),
      validationOwners: stringArray(repository.validation_owners, "agent validation owners"),
      closedLoopPhase: text(proceduralRoot.closed_loop_phase, 64, "agent closed loop phase"),
      verificationStatus: text(proceduralRoot.verification_status, 64, "agent verification status"),
      recoveryStatus: text(proceduralRoot.recovery_status, 64, "agent recovery status"),
      ...(proceduralRoot.selected_proof_type == null ? {} : { selectedProofType: text(proceduralRoot.selected_proof_type, 64, "agent proof type") }),
      learningHints: array(proceduralRoot.learning_hints, "agent learning hints").map((item) => {
        const row = record(item, "agent learning hint");
        return {
          tool: text(row.tool, 128, "agent learning tool"),
          errorCategory: text(row.error_category, 128, "agent learning error category"),
          suggestion: text(row.suggestion, 1024, "agent learning suggestion", true),
          state: text(row.state, 64, "agent learning state"),
        };
      }),
    },
  };
}

function optionalFields(row: Record<string, unknown>): Partial<AgentMemoryEpisode> {
  const mapping: Array<[keyof AgentMemoryEpisode, string, number]> = [
    ["tool", "tool", 128], ["state", "state", 64], ["decision", "decision", 32], ["route", "route", 64],
    ["resultCategory", "result_category", 64], ["errorCategory", "error_category", 64], ["proofType", "proof_type", 64],
  ];
  const result: Partial<AgentMemoryEpisode> = {};
  for (const [target, source, max] of mapping) {
    if (row[source] != null) (result as Record<string, unknown>)[target] = text(row[source], max, `agent episode ${source}`);
  }
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item) => text(item, 4096, label));
}
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`SourceNerve ${label} is invalid`); return value; }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`SourceNerve ${label} is invalid`); return value as Record<string, unknown>; }
function text(value: unknown, maxBytes: number, label: string, allowEmpty = false): string { if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, "utf8") > maxBytes || /\u0000/.test(value)) throw new Error(`SourceNerve ${label} is invalid`); return value; }
function integer(value: unknown, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`SourceNerve ${label} is invalid`); return Number(value); }
