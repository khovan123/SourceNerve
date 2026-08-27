export type RouteId =
  | "overview"
  | "workspaces"
  | "intelligence"
  | "mcp"
  | "plugins"
  | "harness"
  | "tasks"
  | "pull-requests"
  | "connections"
  | "diagnostics"
  | "settings";

export interface NavigationItem {
  id: RouteId;
  label: string;
  description: string;
}

export const NAVIGATION: readonly NavigationItem[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Account, daemon, Git and workspace readiness",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description: "Repositories and SourceNerve workspace configuration",
  },
  {
    id: "intelligence",
    label: "Repository Intelligence",
    description: "Search, symbols, graph, architecture and context",
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Discover, install, update and govern MCP extensions",
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Discover, install and manage plugin packages, skills and bundled MCP components",
  },
  {
    id: "harness",
    label: "Harness",
    description: "Durable runs, timeline, jobs, recovery and approvals",
  },
  {
    id: "tasks",
    label: "Tasks & Changes",
    description: "Guarded branch, patch, review, commit and push workflows",
  },
  {
    id: "pull-requests",
    label: "Pull Requests",
    description: "Provider change requests and guarded merge state",
  },
  {
    id: "connections",
    label: "Connections",
    description: "SourceNerve account, Git providers, public MCP and ChatGPT",
  },
  {
    id: "diagnostics",
    label: "Logs & Diagnostics",
    description: "Sanitized runtime logs, health and recovery actions",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Appearance, startup, updates and advanced diagnostics",
  },
] as const;

export const DEFAULT_ROUTE: RouteId = "overview";

export function routeFromHash(hash: string): RouteId {
  const candidate = hash.replace(/^#\/?/, "").trim();
  return NAVIGATION.some((item) => item.id === candidate)
    ? (candidate as RouteId)
    : DEFAULT_ROUTE;
}

export function routeHash(route: RouteId): string {
  return `#/${route}`;
}

export function navigationItem(route: RouteId): NavigationItem {
  return NAVIGATION.find((item) => item.id === route) ?? NAVIGATION[0];
}
