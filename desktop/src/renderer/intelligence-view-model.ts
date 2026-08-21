export type IntelligenceTab = "search" | "graph" | "architecture" | "context" | "semantic";

export const INTELLIGENCE_TABS: Array<{ id: IntelligenceTab; label: string }> = [
  { id: "search", label: "Search" },
  { id: "graph", label: "Symbols & Graph" },
  { id: "architecture", label: "Architecture" },
  { id: "context", label: "Context Pack" },
  { id: "semantic", label: "Semantic" },
];

export function formatIntelligenceScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

export function shortIntelligenceHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function clipIntelligenceText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… preview clipped in UI …`;
}
