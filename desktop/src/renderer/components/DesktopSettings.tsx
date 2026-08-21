import { useEffect, useState } from "react";

import type { DesktopBehaviorPreferences } from "../../shared/desktop-api";
import { DesktopBehaviorSettingsCard, type SettingsFeedback } from "./organisms/DesktopBehaviorSettingsCard";
import { SystemTrayCard } from "./organisms/SystemTrayCard";
import { LegacyImportSettings } from "./LegacyImportSettings";
import { UpdateSettings } from "./UpdateSettings";

const FALLBACK: DesktopBehaviorPreferences = {
  backgroundMode: false,
  closeBehavior: "quit",
  launchAtLogin: false,
  notificationsEnabled: true,
};

export function DesktopSettingsScreen() {
  const [preferences, setPreferences] = useState<DesktopBehaviorPreferences>(FALLBACK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null);

  useEffect(() => {
    let active = true;
    void window.sourcenerveDesktop.getDesktopBehavior().then((result) => {
      if (!active) return;
      if (result.ok) setPreferences(result.value);
      else setFeedback({ tone: "error", text: result.error.message });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function save(next: DesktopBehaviorPreferences): Promise<void> {
    setSaving(true);
    setFeedback(null);
    try {
      const result = await window.sourcenerveDesktop.updateDesktopBehavior(next);
      if (result.ok) {
        setPreferences(result.value);
        setFeedback({ tone: "success", text: "Preferences saved." });
      } else {
        setFeedback({ tone: "error", text: result.error.message });
      }
    } finally {
      setSaving(false);
    }
  }

  function toggleBackground(enabled: boolean): void {
    const next: DesktopBehaviorPreferences = {
      ...preferences,
      backgroundMode: enabled,
      closeBehavior: enabled ? preferences.closeBehavior : "quit",
    };
    if (enabled && next.closeBehavior === "quit") next.closeBehavior = "tray";
    void save(next);
  }

  return (
    <section className="space-y-4" aria-label="Desktop settings">
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <DesktopBehaviorSettingsCard
          preferences={preferences}
          loading={loading}
          saving={saving}
          feedback={feedback}
          onBackgroundMode={toggleBackground}
          onCloseBehavior={(closeBehavior) => void save({ ...preferences, closeBehavior })}
          onLaunchAtLogin={(launchAtLogin) => void save({ ...preferences, launchAtLogin })}
          onNotifications={(notificationsEnabled) => void save({ ...preferences, notificationsEnabled })}
        />
        <UpdateSettings />
        <SystemTrayCard />
        <LegacyImportSettings />
      </div>
    </section>
  );
}
