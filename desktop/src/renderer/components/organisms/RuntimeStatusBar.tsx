import type { DaemonSnapshot, PublicMcpView, RuntimeInfo } from "../../../shared/desktop-api";
import { cn } from "../../lib/cn";

function Dot({ ready }: { ready: boolean }) {
  return <span className={cn("size-1.5 rounded-full bg-muted-foreground/45", ready && "bg-success")} aria-hidden="true" />;
}

export function RuntimeStatusBar({
  runtime,
  daemon,
  publicMcp,
  setupStep,
}: {
  runtime: RuntimeInfo | null;
  daemon: DaemonSnapshot | null;
  publicMcp: PublicMcpView;
  setupStep: string;
}) {
  const daemonReady = daemon?.state === "ready" || daemon?.state === "external";

  return (
    <footer className="relative z-10 flex min-w-0 items-center gap-5 overflow-hidden border-t border-border/80 bg-card/55 px-6 text-[10px] font-medium text-muted-foreground backdrop-blur-xl lg:px-8" aria-label="Runtime status">
      <span className="flex items-center gap-1.5 whitespace-nowrap"><Dot ready={Boolean(runtime)} />Desktop API {runtime ? `v${runtime.apiVersion}` : "unavailable"}</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap"><Dot ready={daemonReady} />Daemon {daemon?.state ?? "unavailable"}</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap"><Dot ready={publicMcp.state === "ready"} />Public MCP {publicMcp.state}</span>
      <span className="flex items-center gap-1.5 whitespace-nowrap"><Dot ready={setupStep === "ready"} />Setup {setupStep}</span>
      <span className="ml-auto whitespace-nowrap">{runtime ? `${runtime.platform}/${runtime.arch}` : "runtime unavailable"}</span>
    </footer>
  );
}
