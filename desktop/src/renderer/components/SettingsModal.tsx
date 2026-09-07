import { useEffect } from "react";
import {
  Blocks,
  PlugZap,
  Puzzle,
  Settings2,
  X,
  type LucideIcon,
} from "lucide-react";

import type { SettingsSectionId } from "../navigation";
import { cn } from "../lib/cn";
import { ConnectionsScreen } from "./ConnectionsScreen";
import { DesktopSettingsScreen } from "./DesktopSettings";
import { McpScreen } from "./McpScreen";
import { PluginHubScreen } from "./PluginHubScreen";
import { PluginVerificationPanel } from "./PluginVerificationPanel";

type ThemePreference = "system" | "light" | "dark";

const SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "connections", label: "Connections", icon: PlugZap },
  { id: "mcp", label: "MCP", icon: Blocks },
  { id: "plugins", label: "Plugins", icon: Puzzle },
];

export function SettingsModal({
  open,
  section,
  theme,
  onThemeChange,
  onSectionChange,
  onClose,
}: {
  open: boolean;
  section: SettingsSectionId;
  theme: ThemePreference;
  onThemeChange(theme: ThemePreference): void;
  onSectionChange(section: SettingsSectionId): void;
  onClose(): void;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/25 p-5 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="relative grid h-[min(800px,calc(100vh-40px))] w-[min(1080px,calc(100vw-40px))] grid-cols-[184px_minmax(0,1fr)] overflow-hidden rounded-[14px] bg-background shadow-[0_24px_80px_rgb(0_0_0/0.22)]"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-20 grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label="Close settings"
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <aside className="flex min-h-0 flex-col border-r border-border bg-[var(--sn-sidebar)] px-2.5 py-3">
          <div className="mb-2 px-2 py-1 pr-10">
            <p className="text-[13px] font-semibold text-foreground">Settings</p>
          </div>
          <nav className="space-y-0.5" aria-label="Settings sections">
            {SECTIONS.map((item) => {
              const Icon = item.icon;
              const selected = item.id === section;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSectionChange(item.id)}
                  aria-current={selected ? "page" : undefined}
                  aria-pressed={selected}
                  data-active={selected ? "true" : "false"}
                  className={cn(
                    "relative flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset",
                    selected
                      ? "bg-[var(--sn-sidebar-active)] font-semibold text-primary shadow-[inset_0_0_0_1px_var(--border)]"
                      : "text-muted-foreground hover:bg-[var(--sn-sidebar-hover)] hover:text-foreground",
                  )}
                >
                  {selected ? (
                    <span
                      className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary"
                      aria-hidden="true"
                    />
                  ) : null}
                  <Icon
                    className={cn("size-3.5 shrink-0", selected ? "text-primary" : "")}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <span className={cn("truncate", selected ? "text-primary" : "")}>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="settings-content min-h-0 min-w-0 overflow-auto px-7 py-6 lg:px-9 lg:py-8">
          <div className="mx-auto w-full max-w-[820px]">
            {section === "general" ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between gap-6 border-b border-border pb-5">
                  <div>
                    <p className="text-sm font-medium text-foreground">Appearance</p>
                  </div>
                  <select
                    value={theme}
                    onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
                    className="h-8 min-w-28 rounded-[9px] border border-border bg-background px-2.5 text-xs text-foreground"
                    aria-label="Appearance theme"
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <DesktopSettingsScreen />
              </div>
            ) : null}
            {section === "connections" ? <ConnectionsScreen /> : null}
            {section === "mcp" ? <McpScreen /> : null}
            {section === "plugins" ? (
              <div className="space-y-6">
                <PluginHubScreen />
                <PluginVerificationPanel />
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
