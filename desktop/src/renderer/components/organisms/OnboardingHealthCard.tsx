import type { OnboardingLayer } from "../../onboarding";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const LAYER_COPY: Record<OnboardingLayer, string> = {
  "product-profile": "Product Profile",
  "local-bearer": "Local Bearer",
  auth0: "Auth0",
  enrollment: "Enrollment",
  cloudflare: "Cloudflare",
  git: "Git",
  repository: "Repository",
  workspace: "Workspace",
  daemon: "Daemon",
  index: "Index",
};

type LayerState = "complete" | "current" | "blocked";

export function OnboardingHealthCard({ layers }: { layers: Array<{ id: OnboardingLayer; state: LayerState }> }) {
  const readyCount = layers.filter((layer) => layer.state === "complete").length;
  return (
    <SurfaceCard title="Setup health" eyebrow="Runtime layers" description={`${readyCount} of ${layers.length} required layers are currently ready.`} compact>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {layers.map((layer) => <OnboardingStatusLine key={layer.id} label={LAYER_COPY[layer.id]} state={layer.state} />)}
      </div>
    </SurfaceCard>
  );
}

export function OnboardingStatusLine({ label, state }: { label: string; state: LayerState }) {
  const badge = state === "complete"
    ? { label: "Ready", tone: "ready" as const }
    : state === "current"
      ? { label: "Needs attention", tone: "warning" as const }
      : { label: "Blocked", tone: "neutral" as const };
  return (
    <div className={`flex min-h-11 items-center justify-between gap-3 rounded-xl border px-3 py-2 ${state === "current" ? "border-warning/20 bg-warning/[0.055]" : state === "complete" ? "border-success/15 bg-success/[0.035]" : "border-border bg-muted/20"}`}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      <StatusPill tone={badge.tone} dot>{badge.label}</StatusPill>
    </div>
  );
}
