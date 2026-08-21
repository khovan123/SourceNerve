import { Monitor, Moon, Sun } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";

export type ThemePreference = "system" | "light" | "dark";

export function AppTopbar({
  workspaceCount,
  theme,
  onCycleTheme,
}: {
  workspaceCount: number;
  theme: ThemePreference;
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
        <ActionButton
          size="icon"
          variant="ghost"
          onClick={onCycleTheme}
          aria-label={`Theme: ${theme}. Change theme`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="size-4" aria-hidden="true" />
        </ActionButton>
      </div>
    </header>
  );
}
