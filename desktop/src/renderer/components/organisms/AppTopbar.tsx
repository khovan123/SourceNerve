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
    <header className="relative z-10 flex items-center justify-between gap-5 border-b border-border/80 bg-card/55 px-6 backdrop-blur-xl lg:px-8">
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Workspace</p>
        <strong className="mt-0.5 block truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
          {workspaceCount > 0 ? `${workspaceCount} registered` : "No workspace selected"}
        </strong>
      </div>
      <div className="flex items-center gap-2">
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
          <span className="capitalize">{theme}</span>
        </ActionButton>
        <StatusPill tone={bootstrapReady ? "ready" : "warning"} dot>
          {bootstrapReady ? "Bootstrap ready" : "Bootstrap attention"}
        </StatusPill>
      </div>
    </header>
  );
}
