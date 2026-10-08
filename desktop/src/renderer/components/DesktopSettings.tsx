import { useEffect, useState } from "react";

import type {
  DesktopBehaviorPreferences,
  DesktopControlCapability,
  DesktopControlState,
} from "../../shared/desktop-api";
import { DesktopBehaviorSettingsCard, type SettingsFeedback } from "./organisms/DesktopBehaviorSettingsCard";
import { ComputerUseSettingsCard } from "./organisms/ComputerUseSettingsCard";
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
  const [computerUseState, setComputerUseState] = useState<DesktopControlState | null>(null);
  const [computerUseLoading, setComputerUseLoading] = useState(true);
  const [computerUseSaving, setComputerUseSaving] = useState(false);
  const [computerUseError, setComputerUseError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.sourcenerveDesktop.getDesktopBehavior().then((result) => {
      if (!active) return;
      if (result.ok) setPreferences(result.value);
      else setFeedback({ tone: "error", text: result.error.message });
      setLoading(false);
    });
    void window.sourcenerveDesktop.getDesktopControlState().then((result) => {
      if (!active) return;
      if (result.ok) setComputerUseState(result.value);
      else setComputerUseError(result.error.message);
      setComputerUseLoading(false);
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

  async function saveComputerUse(next: DesktopControlState["permissions"]): Promise<void> {
    setComputerUseSaving(true);
    setComputerUseError(null);
    try {
      const result = await window.sourcenerveDesktop.updateDesktopControlPermissions(next);
      if (result.ok) setComputerUseState(result.value);
      else setComputerUseError(result.error.message);
    } finally {
      setComputerUseSaving(false);
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

  function toggleComputerUse(enabled: boolean): void {
    const current = computerUseState?.permissions ?? { screen: false, mouse: false, keyboard: false, clipboard: false };
    void saveComputerUse({
      ...current,
      screen: enabled,
      mouse: enabled,
      keyboard: enabled,
    });
  }

  function toggleComputerUseCapability(capability: DesktopControlCapability, enabled: boolean): void {
    const current = computerUseState?.permissions ?? { screen: false, mouse: false, keyboard: false, clipboard: false };
    void saveComputerUse({ ...current, [capability]: enabled });
  }

  return (
    <section className="mx-auto max-w-3xl space-y-4" aria-label="Desktop settings">
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
      <ComputerUseSettingsCard
        state={computerUseState}
        loading={computerUseLoading}
        saving={computerUseSaving}
        error={computerUseError}
        onComputerUse={toggleComputerUse}
        onCapability={toggleComputerUseCapability}
      />
      <UpdateSettings />
      <LegacyImportSettings />
    </section>
  );
}
