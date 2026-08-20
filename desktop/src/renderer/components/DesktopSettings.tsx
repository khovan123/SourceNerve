import { useEffect, useState } from "react";

import type { DesktopBehaviorPreferences } from "../../shared/desktop-api";
import { LegacyImportSettings } from "./LegacyImportSettings";
import { Panel } from "./Panel";
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
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.sourcenerveDesktop.getDesktopBehavior().then((result) => {
      if (!active) return;
      if (result.ok) setPreferences(result.value);
      else setMessage(result.error.message);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  async function save(next: DesktopBehaviorPreferences): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const result = await window.sourcenerveDesktop.updateDesktopBehavior(next);
      if (result.ok) {
        setPreferences(result.value);
        setMessage("Startup and background preferences saved.");
      } else {
        setMessage(result.error.message);
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
    <div className="settings-grid">
      <Panel title="Startup & Background" eyebrow="Desktop behavior">
        <div className="settings-list" aria-busy={loading || saving}>
          <label className="settings-row">
            <span>
              <strong>Keep SourceNerve running in background</strong>
              <small>Closing the window can keep the daemon and permitted Public MCP connector alive in the system tray.</small>
            </span>
            <input
              type="checkbox"
              checked={preferences.backgroundMode}
              disabled={loading || saving}
              onChange={(event) => toggleBackground(event.target.checked)}
            />
          </label>

          <label className="settings-row">
            <span>
              <strong>Close window behavior</strong>
              <small>Choose whether the window closes the app or hides it while background mode is enabled.</small>
            </span>
            <select
              value={preferences.closeBehavior}
              disabled={loading || saving || !preferences.backgroundMode}
              onChange={(event) => void save({
                ...preferences,
                closeBehavior: event.target.value === "tray" ? "tray" : "quit",
              })}
            >
              <option value="tray">Keep running in tray</option>
              <option value="quit">Quit SourceNerve</option>
            </select>
          </label>

          <label className="settings-row">
            <span>
              <strong>Launch at login</strong>
              <small>Restore the last valid local account/runtime state automatically without requesting infrastructure secrets.</small>
            </span>
            <input
              type="checkbox"
              checked={preferences.launchAtLogin}
              disabled={loading || saving}
              onChange={(event) => void save({ ...preferences, launchAtLogin: event.target.checked })}
            />
          </label>

          <label className="settings-row">
            <span>
              <strong>Native notifications</strong>
              <small>Notify for daemon crashes, auth expiry, Public MCP health problems, and useful long-running operation completion.</small>
            </span>
            <input
              type="checkbox"
              checked={preferences.notificationsEnabled}
              disabled={loading || saving}
              onChange={(event) => void save({ ...preferences, notificationsEnabled: event.target.checked })}
            />
          </label>
        </div>
        {message ? <p className="muted" role="status">{message}</p> : null}
      </Panel>

      <UpdateSettings />

      <Panel title="System tray" eyebrow="Native controls">
        <ul className="feature-list">
          <li>Show SourceNerve</li>
          <li>Start / Stop / Restart the managed daemon</li>
          <li>Open sanitized runtime logs</li>
          <li>Quit with graceful tunnel → daemon → app shutdown</li>
        </ul>
        <p className="muted">
          Tray controls are fixed semantic operations. They cannot run arbitrary commands, URLs, or processes.
        </p>
      </Panel>

      <LegacyImportSettings />
    </div>
  );
}
