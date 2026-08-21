import type { DaemonSnapshot, PublicMcpView, RuntimeInfo } from "../../../shared/desktop-api";
import { cn } from "../../lib/cn";

function Dot({ ready }: { ready: boolean }) {
  return <span className={cn("size-1.5 rounded-full bg-muted-foreground/40", ready && "bg-success")} aria-hidden="true" />;
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
  const runtimeReady = Boolean(runtime);

  return (
    <footer className="relative z-10 flex min-w-0 items-center gap-4 overflow-hidden border-t border-border/75 bg-card/50 px-4 text-[10px] font-medium text-muted-foreground backdrop-blur-xl sm:px-5 lg:px-7 xl:px-8" aria-label="Runtime status">
      <span className="flex items-center gap-1.5 whitespace-nowrap"><Dot ready={daemonReady} />Daemon {daemon?.state ?? "unavailable"}</span>
      <span className="hidden items-center gap-1.5 whitespace-nowrap sm:flex"><Dot ready={publicMcp.state === "ready"} />Public MCP {publicMcp.state}</span>
      <span className="hidden items-center gap-1.5 whitespace-nowrap md:flex"><Dot ready={setupStep === "ready"} />Setup {setupStep}</span>
      {!runtimeReady ? <span className="ml-auto whitespace-nowrap text-warning">Runtime unavailable</span> : null}
    </footer>
  );
}
