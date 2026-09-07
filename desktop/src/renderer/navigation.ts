export type RouteId =
  | "mcp"
  | "plugins"
  | "harness"
  | "pull-requests"
  | "connections"
  | "settings";

export interface NavigationItem {
  id: RouteId;
  label: string;
}

export const NAVIGATION: readonly NavigationItem[] = [
  { id: "mcp", label: "MCP" },
  { id: "plugins", label: "Plugins" },
  { id: "harness", label: "Harness" },
  { id: "pull-requests", label: "Pull Requests" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
] as const;

export const MAIN_NAVIGATION: readonly NavigationItem[] = [
  { id: "harness", label: "Harness" },
  { id: "pull-requests", label: "Pull Requests" },
] as const;

export type SettingsSectionId = "general" | "connections" | "mcp" | "plugins";

const SETTINGS_ROUTE_MAP: Partial<Record<RouteId, SettingsSectionId>> = {
  settings: "general",
  connections: "connections",
  mcp: "mcp",
  plugins: "plugins",
};

export const DEFAULT_ROUTE: RouteId = "harness";

export function routeFromHash(hash: string): RouteId {
  const candidate = hash.replace(/^#\/?/, "").trim();
  if (candidate === "workspaces") return "harness";
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

export function settingsSectionForRoute(route: RouteId): SettingsSectionId | null {
  return SETTINGS_ROUTE_MAP[route] ?? null;
}

export function isMainRoute(route: RouteId): boolean {
  return MAIN_NAVIGATION.some((item) => item.id === route);
}
