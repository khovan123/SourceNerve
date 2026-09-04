export type RouteId =
  | "overview"
  | "workspaces"
  | "mcp"
  | "plugins"
  | "harness"
  | "pull-requests"
  | "connections"
  | "diagnostics"
  | "settings";

export interface NavigationItem {
  id: RouteId;
  label: string;
}

export const NAVIGATION: readonly NavigationItem[] = [
  { id: "overview", label: "Overview" },
  { id: "workspaces", label: "Workspaces" },
  { id: "mcp", label: "MCP" },
  { id: "plugins", label: "Plugins" },
  { id: "harness", label: "Harness" },
  { id: "pull-requests", label: "Pull Requests" },
  { id: "connections", label: "Connections" },
  { id: "diagnostics", label: "Logs & Diagnostics" },
  { id: "settings", label: "Settings" },
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
