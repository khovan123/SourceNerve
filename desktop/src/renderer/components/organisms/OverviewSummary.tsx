import type {
  DaemonHealth,
  DaemonSnapshot,
  ProviderAccountView,
  PublicMcpView,
  RuntimeInfo,
} from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

type ReadinessView = { label: string; ready: boolean; reason: string };
type Tone = "neutral" | "ready" | "working" | "warning" | "danger";

export function OverviewSummary({
  providers,
  daemon,
  runtime,
  health,
  readiness,
  publicMcp,
  buildCommit,
  daemonServiceVersion,
  busy,
  onDaemonAction,
  onRepairPublicMcp,
}: {
  providers: ProviderAccountView[];
  daemon: DaemonSnapshot | null;
  runtime: RuntimeInfo | null;
  health: DaemonHealth | null;
  readiness: ReadinessView;
  publicMcp: PublicMcpView;
  buildCommit?: string;
  daemonServiceVersion?: string;
  busy: string | null;
  onDaemonAction(action: "start" | "stop" | "restart"): void;
  onRepairPublicMcp(): void;
}) {
  const daemonState = daemon?.state ?? "stopped";
  const daemonTransition = daemonState === "starting" || daemonState === "stopping";

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <SurfaceCard title="Git Providers" eyebrow="Repository access" description="Provider sessions detected from local CLI ownership.">
        <div className="space-y-3">
          {(["github", "gitlab"] as const).map((providerName) => {
            const provider = providers.find((candidate) => candidate.provider === providerName);
            const connected = provider?.status === "connected";
            return (
              <StatusLine
                key={providerName}
                tone={connected ? "ready" : provider?.status === "error" ? "warning" : "neutral"}
                label={providerName === "github" ? "GitHub" : "GitLab"}
                text={connected ? provider?.login ?? provider?.name ?? "Connected" : provider?.error ?? provider?.status ?? "Disconnected"}
              />
            );
          })}
        </div>
      </SurfaceCard>

      <SurfaceCard title="Daemon & Build" eyebrow="Local runtime" description="Bundled runtime state and build identity.">
        <StatusLine tone={daemonTone(daemonState)} label={daemonState} text={daemon?.message ?? (daemon?.managed ? "Managed bundled runtime" : "External runtime")} />
        <Facts items={[
          ["Desktop", runtime?.desktopVersion ?? "—"],
          ["Daemon", daemonServiceVersion ?? "—"],
          ["Build", buildCommit ?? "—"],
          ["Process", daemon?.pid ? `PID ${daemon.pid}` : "—"],
        ]} monoRows={[2]} />
        <div className="mt-4 flex flex-wrap gap-2">
          {(daemonState === "stopped" || daemonState === "crashed") ? (
            <ActionButton size="sm" disabled={Boolean(busy) || daemonTransition} onClick={() => onDaemonAction("start")}>Start</ActionButton>
          ) : null}
          {daemon?.managed && daemonState === "ready" ? (
            <>
              <ActionButton size="sm" disabled={Boolean(busy)} onClick={() => onDaemonAction("restart")}>Restart</ActionButton>
              <ActionButton size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => onDaemonAction("stop")}>Stop</ActionButton>
            </>
          ) : null}
        </div>
      </SurfaceCard>

      <SurfaceCard title="Local Readiness" eyebrow="Health" description="Daemon health and local API/MCP endpoints.">
        <StatusLine tone={readiness.ready ? "ready" : readiness.label === "Checking" ? "working" : "warning"} label={readiness.label} text={readiness.reason} />
        <Facts items={[
          ["Health", health?.status ?? "Unavailable"],
          ["API", runtime?.endpoints?.localApiUrl ?? "—"],
          ["Local MCP", runtime?.endpoints?.localMcpUrl ?? "—"],
        ]} monoRows={[1, 2]} />
      </SurfaceCard>

      <SurfaceCard title="Public MCP" eyebrow="Cloudflare tunnel" description="Installation-scoped remote MCP endpoint and tunnel state." className="md:col-span-2 xl:col-span-2">
        <StatusLine tone={publicMcpTone(publicMcp)} label={publicMcpLabel(publicMcp)} text={publicMcp.message ?? publicMcp.hostname ?? "Installation is not enrolled."} />
        <Facts items={[
          ["Hostname", publicMcp.hostname ?? "—"],
          ["MCP Server URL", publicMcp.publicMcpUrl ?? (publicMcp.hostname ? `https://${publicMcp.hostname}/mcp` : "—")],
          ["Tunnel", publicMcp.tunnelRunning ? "Running" : "Stopped"],
          ["Last check", publicMcp.lastCheckedAt ? new Date(publicMcp.lastCheckedAt).toLocaleString() : "—"],
        ]} monoRows={[0, 1]} />
        <div className="mt-4">
          <ActionButton size="sm" disabled={Boolean(busy)} onClick={onRepairPublicMcp}>
            {busy === "public-mcp:repair" ? "Repairing…" : "Retry / Repair"}
          </ActionButton>
        </div>
      </SurfaceCard>
    </div>
  );
}

function StatusLine({ tone, label, text }: { tone: Tone; label: string; text: string }) {
  return <div className="flex items-center gap-3"><StatusPill tone={tone} dot>{label}</StatusPill><p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{text}</p></div>;
}

function Facts({ items, monoRows = [] }: { items: Array<[string, string]>; monoRows?: number[] }) {
  return (
    <dl className="mt-4 grid gap-2 text-xs">
      {items.map(([label, value], index) => {
        const mono = monoRows.includes(index);
        return (
          <div key={label} className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 border-t border-border/60 pt-2 sm:grid-cols-[110px_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={mono ? "select-all break-all font-mono text-[11px] leading-5 text-foreground" : "break-words font-medium text-foreground"} title={value}>{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function daemonTone(state: DaemonSnapshot["state"] | "stopped"): Tone {
  if (state === "ready" || state === "external") return "ready";
  if (state === "starting" || state === "stopping") return "working";
  if (state === "crashed" || state === "incompatible") return "warning";
  return "neutral";
}

function publicMcpLabel(view: PublicMcpView): string {
  if (view.state === "ready") return "Ready";
  if (view.state === "checking" || view.state === "enrolling") return "Checking";
  if (view.state === "degraded") return "Degraded";
  if (view.state === "offline") return "Offline";
  if (view.state === "revoked") return "Revoked";
  return "Not enrolled";
}

function publicMcpTone(view: PublicMcpView): Tone {
  if (view.state === "ready") return "ready";
  if (view.state === "checking" || view.state === "enrolling") return "working";
  if (view.state === "degraded" || view.state === "revoked") return "warning";
  if (view.state === "offline") return "danger";
  return "neutral";
}
