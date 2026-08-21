import type { ReactNode } from "react";
import { Bell, CheckCircle2, LogIn, MonitorCog, PanelTopClose } from "lucide-react";

import type { DesktopBehaviorPreferences } from "../../../shared/desktop-api";
import { ToggleSwitch } from "../atoms/ToggleSwitch";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

const selectClass = "h-9 min-w-44 rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export type SettingsFeedback = { tone: "success" | "error"; text: string };

export function DesktopBehaviorSettingsCard({
  preferences,
  loading,
  saving,
  feedback,
  onBackgroundMode,
  onCloseBehavior,
  onLaunchAtLogin,
  onNotifications,
}: {
  preferences: DesktopBehaviorPreferences;
  loading: boolean;
  saving: boolean;
  feedback: SettingsFeedback | null;
  onBackgroundMode(enabled: boolean): void;
  onCloseBehavior(value: "tray" | "quit"): void;
  onLaunchAtLogin(enabled: boolean): void;
  onNotifications(enabled: boolean): void;
}) {
  const disabled = loading || saving;
  return (
    <SurfaceCard title="Startup & Background" description="Control tray behavior, login startup and native notifications.">
      <div className="divide-y divide-border/70" aria-busy={disabled}>
        <SettingRow
          icon={<MonitorCog className="size-4" aria-hidden="true" />}
          title="Run in background"
          description="Keep SourceNerve available from the system tray after closing the window."
          control={<ToggleSwitch label="Keep SourceNerve running in background" checked={preferences.backgroundMode} disabled={disabled} onChange={onBackgroundMode} />}
        />
        <SettingRow
          icon={<PanelTopClose className="size-4" aria-hidden="true" />}
          title="Close window"
          description="Choose whether closing the window hides SourceNerve or quits it."
          control={(
            <select
              className={selectClass}
              value={preferences.closeBehavior}
              disabled={disabled || !preferences.backgroundMode}
              onChange={(event) => onCloseBehavior(event.target.value === "tray" ? "tray" : "quit")}
            >
              <option value="tray">Keep running in tray</option>
              <option value="quit">Quit SourceNerve</option>
            </select>
          )}
        />
        <SettingRow
          icon={<LogIn className="size-4" aria-hidden="true" />}
          title="Launch at login"
          description="Start SourceNerve automatically after signing in to the computer."
          control={<ToggleSwitch label="Launch SourceNerve at login" checked={preferences.launchAtLogin} disabled={disabled} onChange={onLaunchAtLogin} />}
        />
        <SettingRow
          icon={<Bell className="size-4" aria-hidden="true" />}
          title="Notifications"
          description="Show native notifications for important runtime events."
          control={<ToggleSwitch label="Enable native notifications" checked={preferences.notificationsEnabled} disabled={disabled} onChange={onNotifications} />}
        />
      </div>

      {feedback?.tone === "error" ? (
        <div className="mt-4"><InlineNotice tone="danger" title="Settings could not be saved" role="alert">{feedback.text}</InlineNotice></div>
      ) : feedback ? (
        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground" role="status">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
          <span>{feedback.text}</span>
        </div>
      ) : null}
    </SurfaceCard>
  );
}

function SettingRow({ icon, title, description, control }: { icon: ReactNode; title: string; description: string; control: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-muted/45 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="shrink-0 sm:pl-4">{control}</div>
    </div>
  );
}
