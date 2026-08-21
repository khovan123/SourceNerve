import { StatusPill } from "./atoms/StatusPill";

export type StatusTone = "ready" | "working" | "warning" | "offline" | "neutral";

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

export function StatusBadge({ label, tone = "neutral" }: StatusBadgeProps) {
  return <StatusPill tone={tone === "offline" ? "danger" : tone} dot>{label}</StatusPill>;
}
