export type AgentGraphState = Record<string, unknown>;

export interface AgentGraphNode<S extends AgentGraphState> {
  id: string;
  maxVisits?: number;
  run(state: Readonly<S>): Promise<Partial<S>>;
}

export type AgentGraphRouter<S extends AgentGraphState> = (state: Readonly<S>) => readonly string[];

export interface AgentGraphDefinition<S extends AgentGraphState> {
  nodes: readonly AgentGraphNode<S>[];
  start: readonly string[];
  routes?: Readonly<Record<string, AgentGraphRouter<S>>>;
  maxSteps?: number;
}

export type AgentGraphEvent =
  | { type: "graph/start"; nodes: string[] }
  | { type: "node/start"; nodeId: string; visit: number }
  | { type: "node/end"; nodeId: string; keys: string[] }
  | { type: "route"; nodeId: string; next: string[] }
  | { type: "graph/end"; steps: number };

export interface AgentGraphResult<S extends AgentGraphState> {
  state: S;
  steps: number;
  visits: Record<string, number>;
}

/**
 * Deterministic graph runtime for known orchestration shape. Routers are plain
 * code functions over state; the model never owns graph control flow.
 */
export async function runAgentGraph<S extends AgentGraphState>(input: {
  definition: AgentGraphDefinition<S>;
  initialState: S;
  onEvent?: (event: AgentGraphEvent) => void | Promise<void>;
}): Promise<AgentGraphResult<S>> {
  const nodeMap = new Map<string, AgentGraphNode<S>>();
  for (const node of input.definition.nodes) {
    validateNodeId(node.id);
    if (nodeMap.has(node.id)) throw new Error(`Agent graph has duplicate node: ${node.id}`);
    nodeMap.set(node.id, node);
  }
  if (nodeMap.size === 0) throw new Error("Agent graph requires at least one node");

  let ready = unique(input.definition.start);
  validateTargets(ready, nodeMap);
  const maxSteps = boundedPositive(input.definition.maxSteps ?? 128, 1, 4096, "Agent graph maxSteps");
  const visits: Record<string, number> = {};
  let steps = 0;
  let state = { ...input.initialState } as S;
  await input.onEvent?.({ type: "graph/start", nodes: [...ready] });

  while (ready.length > 0) {
    if (steps + ready.length > maxSteps) throw new Error("Agent graph exceeded maxSteps");
    const snapshot = Object.freeze({ ...state }) as Readonly<S>;
    const wave = await Promise.all(ready.map(async (nodeId) => {
      const node = nodeMap.get(nodeId)!;
      const visit = (visits[nodeId] ?? 0) + 1;
      const maxVisits = boundedPositive(node.maxVisits ?? 1, 1, 1024, `Agent graph maxVisits for ${nodeId}`);
      if (visit > maxVisits) throw new Error(`Agent graph node ${nodeId} exceeded maxVisits`);
      await input.onEvent?.({ type: "node/start", nodeId, visit });
      const patch = await node.run(snapshot);
      if (!isRecord(patch)) throw new Error(`Agent graph node ${nodeId} returned an invalid state patch`);
      const keys = Object.keys(patch);
      for (const key of keys) validateStateKey(key);
      await input.onEvent?.({ type: "node/end", nodeId, keys });
      return { nodeId, visit, patch, keys };
    }));

    const written = new Map<string, string>();
    for (const result of wave) {
      for (const key of result.keys) {
        const prior = written.get(key);
        if (prior) throw new Error(`Agent graph parallel state collision on ${key}: ${prior} and ${result.nodeId}`);
        written.set(key, result.nodeId);
      }
    }

    for (const result of wave) {
      visits[result.nodeId] = result.visit;
      state = { ...state, ...result.patch };
      steps += 1;
    }

    const next: string[] = [];
    for (const result of wave) {
      const router = input.definition.routes?.[result.nodeId];
      const targets = router ? [...router(Object.freeze({ ...state }) as Readonly<S>)] : [];
      validateTargets(targets, nodeMap);
      await input.onEvent?.({ type: "route", nodeId: result.nodeId, next: [...targets] });
      next.push(...targets);
    }
    ready = unique(next);
  }

  await input.onEvent?.({ type: "graph/end", steps });
  return { state, steps, visits };
}

function validateTargets<S extends AgentGraphState>(targets: readonly string[], nodes: Map<string, AgentGraphNode<S>>): void {
  for (const target of targets) {
    validateNodeId(target);
    if (!nodes.has(target)) throw new Error(`Agent graph route targets unknown node: ${target}`);
  }
}

function validateNodeId(value: string): void {
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Agent graph node id is invalid");
}
function validateStateKey(value: string): void { if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Agent graph state key is invalid"); }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function boundedPositive(value: number, min: number, max: number, label: string): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}-${max}`); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
