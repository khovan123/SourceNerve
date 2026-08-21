import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function WorkspaceReadinessSection({ workspaces }: { workspaces: ManagedWorkspaceView[] }) {
  return (
    <SurfaceCard title="Workspace readiness" eyebrow={`${workspaces.length} registered`}>
      {workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/40 px-5 py-8 text-center">
          <strong className="text-sm text-foreground">No workspace registered</strong>
          <p className="mt-1 text-xs text-muted-foreground">Open Workspaces to add a validated local Git checkout.</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {workspaces.map((workspace) => <WorkspaceCard key={workspace.id} workspace={workspace} />)}
        </div>
      )}
    </SurfaceCard>
  );
}

function WorkspaceCard({ workspace }: { workspace: ManagedWorkspaceView }) {
  const ready = workspace.validation.state === "ready";
  const indexReady = workspace.index.state === "current";
  const facts: Array<[string, string]> = [
    ["Access", workspace.access],
    ["Repository", workspace.provider && workspace.repository ? `${workspace.provider}:${workspace.repository}` : "Local Git"],
    ["Git", ready ? "Config ready" : workspace.validation.message ?? "Invalid"],
    ["Working tree", workspace.dirty === undefined ? "Unknown" : workspace.dirty ? "Dirty" : "Clean"],
    ["HEAD", workspace.head ?? "—"],
    ["Branch", workspace.branch ?? workspace.defaultBranch],
    ["Index", workspace.index.state],
    ["Indexed HEAD", workspace.index.indexedHead ?? "—"],
  ];

  return (
    <article className="rounded-xl border border-border/80 bg-background/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm font-semibold text-foreground">{workspace.name}</strong>
          <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{workspace.id}</span>
        </div>
        <StatusPill tone={ready && indexReady ? "ready" : "warning"} dot>{ready && indexReady ? "Ready" : "Needs attention"}</StatusPill>
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-lg bg-muted/45 px-3 py-2">
            <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
            <dd className="mt-1 truncate text-xs font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
