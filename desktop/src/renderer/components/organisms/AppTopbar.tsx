import { Monitor, Moon, Sun } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";

export type ThemePreference = "system" | "light" | "dark";

export function AppTopbar({
  workspaceCount,
  theme,
  bootstrapReady,
  showContinueSetup,
  onContinueSetup,
  onCycleTheme,
}: {
  workspaceCount: number;
  theme: ThemePreference;
  bootstrapReady: boolean;
  showContinueSetup: boolean;
  onContinueSetup(): void;
  onCycleTheme(): void;
}) {
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <header className="relative z-10 flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-card/60 px-4 backdrop-blur-2xl sm:px-5 lg:px-7 xl:px-8">
      <div className="min-w-0">
        <p className="hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:block">Workspace</p>
        <div className="flex min-w-0 items-center gap-2">
          <strong className="block truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
            {workspaceCount > 0 ? `${workspaceCount} registered` : "No workspace selected"}
          </strong>
          {workspaceCount > 0 ? <span className="hidden size-1 rounded-full bg-muted-foreground/40 lg:block" aria-hidden="true" /> : null}
          {workspaceCount > 0 ? <span className="hidden text-[11px] text-muted-foreground lg:block">Local repository context</span> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {showContinueSetup ? (
          <ActionButton size="sm" variant="secondary" onClick={onContinueSetup}>Continue setup</ActionButton>
        ) : null}
        <ActionButton
          size="sm"
          variant="ghost"
          onClick={onCycleTheme}
          aria-label={`Theme: ${theme}. Change theme`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-3.5" aria-hidden="true" />
          <span className="hidden capitalize lg:inline">{theme}</span>
        </ActionButton>
        <StatusPill tone={bootstrapReady ? "ready" : "warning"} dot>
          <span className="hidden sm:inline">{bootstrapReady ? "Bootstrap ready" : "Bootstrap attention"}</span>
          <span className="sm:hidden">{bootstrapReady ? "Ready" : "Attention"}</span>
        </StatusPill>
      </div>
    </header>
  );
}
