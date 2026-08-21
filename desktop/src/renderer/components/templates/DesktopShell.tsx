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
  bootstrapReady: boolean;
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
  bootstrapReady,
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
    <div className="relative grid h-screen w-screen grid-cols-[244px_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-80 [background:radial-gradient(circle_at_78%_8%,rgba(232,197,135,0.22),transparent_30%),radial-gradient(circle_at_96%_74%,rgba(231,171,109,0.15),transparent_28%)]" aria-hidden="true" />
      <AppSidebar route={route} />
      <div className="relative grid min-h-0 min-w-0 grid-rows-[64px_minmax(0,1fr)_36px]">
        <AppTopbar
          workspaceCount={workspaceCount}
          theme={theme}
          bootstrapReady={bootstrapReady}
          showContinueSetup={showContinueSetup}
          onContinueSetup={onContinueSetup}
          onCycleTheme={onCycleTheme}
        />
        <main className="min-h-0 min-w-0 overflow-auto px-6 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1440px]">{children}</div>
        </main>
        <RuntimeStatusBar runtime={runtime} daemon={daemon} publicMcp={publicMcp} setupStep={setupStep} />
      </div>
    </div>
  );
}
