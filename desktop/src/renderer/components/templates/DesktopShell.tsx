import type { PropsWithChildren } from "react";
import type { DaemonSnapshot, PublicMcpView, RuntimeInfo } from "../../../shared/desktop-api";
import type { RouteId } from "../../navigation";
import { AppSidebar } from "../organisms/AppSidebar";
import { AppTopbar, type ThemePreference } from "../organisms/AppTopbar";
import { RuntimeStatusBar } from "../organisms/RuntimeStatusBar";

interface DesktopShellProps extends PropsWithChildren {
  route: RouteId;
  workspaceCount: number;
  theme: ThemePreference;
  bootstrapReady?: boolean;
  showContinueSetup: boolean;
  runtime: RuntimeInfo | null;
  daemon: DaemonSnapshot | null;
  publicMcp: PublicMcpView;
  setupStep: string;
  onContinueSetup(): void;
  onCycleTheme(): void;
}

export function DesktopShell({
  route,
  workspaceCount,
  theme,
  showContinueSetup,
  runtime,
  daemon,
  publicMcp,
  setupStep,
  onContinueSetup,
  onCycleTheme,
  children,
}: DesktopShellProps) {
  return (
    <div className="relative grid h-screen w-screen grid-cols-[80px_minmax(0,1fr)] overflow-hidden bg-background text-foreground xl:grid-cols-[244px_minmax(0,1fr)]">
      <div
        className="pointer-events-none absolute inset-0 opacity-90 [background:radial-gradient(circle_at_72%_-8%,rgba(232,197,135,0.22),transparent_31%),radial-gradient(circle_at_100%_70%,rgba(231,171,109,0.12),transparent_27%),linear-gradient(to_bottom,transparent,rgba(255,255,255,0.018))]"
        aria-hidden="true"
      />
      <AppSidebar route={route} />
      <div className="relative grid min-h-0 min-w-0 grid-rows-[60px_minmax(0,1fr)_36px] sm:grid-rows-[64px_minmax(0,1fr)_36px]">
        <AppTopbar
          workspaceCount={workspaceCount}
          theme={theme}
          showContinueSetup={showContinueSetup}
          onContinueSetup={onContinueSetup}
          onCycleTheme={onCycleTheme}
        />
        <main className="min-h-0 min-w-0 overflow-auto px-4 py-5 sm:px-5 sm:py-6 lg:px-7 xl:px-8">
          <div className="mx-auto w-full max-w-[1520px] pb-2">{children}</div>
        </main>
        <RuntimeStatusBar runtime={runtime} daemon={daemon} publicMcp={publicMcp} setupStep={setupStep} />
      </div>
    </div>
  );
}
