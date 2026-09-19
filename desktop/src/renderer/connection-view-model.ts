import type { GitProvider, ProviderAccountView, PublicMcpView } from "../shared/desktop-api";

export interface RepositoryCheck {
  ok: boolean;
  message: string;
}

export type ConnectionTone = "neutral" | "ready" | "working" | "warning" | "danger";

export function providerStatusLabel(status: ProviderAccountView["status"]): string {
  if (status === "connected") return "CLI authenticated";
  if (status === "error") return "Needs attention";
  if (status === "awaiting-user") return "Checking CLI";
  return "CLI not detected";
}

export function providerTone(status: ProviderAccountView["status"]): ConnectionTone {
  if (status === "connected") return "ready";
  if (status === "awaiting-user") return "working";
  if (status === "error") return "warning";
  return "neutral";
}

export function publicMcpLabel(view: PublicMcpView): string {
  if (view.state === "ready") return "Ready";
  if (view.state === "checking" || view.state === "enrolling") return "Checking";
  if (view.state === "degraded") return "Degraded";
  if (view.state === "offline") return "Offline";
  if (view.state === "revoked") return "Revoked";
  return "Not enrolled";
}

export function publicMcpTone(view: PublicMcpView): ConnectionTone {
  if (view.state === "ready") return "ready";
  if (view.state === "checking" || view.state === "enrolling") return "working";
  if (view.state === "degraded" || view.state === "revoked" || view.state === "offline") return "warning";
  return "neutral";
}

export function fallbackProviderState(provider: GitProvider): ProviderAccountView {
  return {
    provider,
    status: "disconnected",
    baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4",
  };
}
