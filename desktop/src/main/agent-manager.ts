import type {
  DesktopAgentEvaluationListInput,
  DesktopAgentEvaluationView,
  DesktopAgentEvaluateInput,
  DesktopAgentMemoryPreview,
  DesktopAgentMemoryPreviewInput,
  DesktopAgentTurnListInput,
  DesktopAgentTurnView,
} from "../shared/agent-api";
import { AgentEvaluationClient } from "./agent-eval";
import { AgentMemoryClient } from "./agent-memory";
import { parseAgentTurnList } from "./agent-parser";
import type { SourceNerveClient } from "./sourcenerve-client";

export class DesktopAgentManager {
  private readonly memory: AgentMemoryClient;
  private readonly evaluations: AgentEvaluationClient;

  constructor(private readonly client: SourceNerveClient) {
    this.memory = new AgentMemoryClient(client);
    this.evaluations = new AgentEvaluationClient(client);
  }

  async listTurns(input: DesktopAgentTurnListInput): Promise<DesktopAgentTurnView[]> {
    return parseAgentTurnList(await this.client.harnessRequest(
      "/api/v1/harness/agent/turns/list",
      { run_id: input.runId, limit: input.limit ?? 25 },
    ));
  }

  async previewMemory(input: DesktopAgentMemoryPreviewInput): Promise<DesktopAgentMemoryPreview> {
    const memory = await this.memory.retrieve({
      runId: input.runId,
      query: input.query,
      maxItems: 8,
      maxBytes: 32 * 1024,
      maxEpisodes: 20,
    });
    return {
      semantic: memory.semantic.map(({ path, startLine, endLine, score }) => ({ path, startLine, endLine, score })),
      episodic: memory.episodic.map(({ createdAt: _createdAt, ...episode }) => episode),
      procedural: memory.procedural,
    };
  }

  async evaluate(input: DesktopAgentEvaluateInput): Promise<DesktopAgentEvaluationView> {
    return this.evaluations.evaluate(input.turnId);
  }

  async listEvaluations(input: DesktopAgentEvaluationListInput): Promise<DesktopAgentEvaluationView[]> {
    return this.evaluations.list(input.turnId, input.limit ?? 20);
  }
}
