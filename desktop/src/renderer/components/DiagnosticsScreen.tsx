import { useEffect, useState } from "react";

import type {
  RecoveryReadinessResult,
  RecoveryStateView,
  StateBackupValidationView,
  SupportBundleExportFormat,
  SupportBundlePreview,
} from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

const ONBOARDING_STORAGE_KEY = "sourcenerve.desktop.onboarding.v1";

export function DiagnosticsScreen() {
  const [preview, setPreview] = useState<SupportBundlePreview | null>(null);
  const [recovery, setRecovery] = useState<RecoveryStateView | null>(null);
  const [readiness, setReadiness] = useState<RecoveryReadinessResult | null>(null);
  const [backup, setBackup] = useState<StateBackupValidationView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshRecoveryState();
  }, []);

  async function refreshRecoveryState(): Promise<void> {
    const result = await window.sourcenerveDesktop.getRecoveryState();
    if (result.ok) setRecovery(result.value);
    else setError(result.error.message);
  }

  async function generatePreview(): Promise<void> {
    await run("preview", async () => {
      const result = await window.sourcenerveDesktop.previewSupportBundle();
      if (!result.ok) throw new Error(result.error.message);
      setPreview(result.value);
      setMessage("Preview generated locally. Review this exact text before exporting.");
    });
  }

  async function exportBundle(format: SupportBundleExportFormat): Promise<void> {
    if (!preview) return;
    await run(`export-${format}`, async () => {
      const result = await window.sourcenerveDesktop.exportSupportBundle(preview.selectionId, format);
      if (!result.ok) throw new Error(result.error.message);
      setMessage(
        result.value.saved
          ? `Support bundle exported as ${format.toUpperCase()} (${formatBytes(result.value.bytes)}).`
          : "Export cancelled. Nothing was written.",
      );
    });
  }

  async function restartDaemon(): Promise<void> {
    await run("restart", async () => {
      const result = await window.sourcenerveDesktop.restartDaemon();
      if (!result.ok) throw new Error(result.error.message);
      setMessage(`Daemon state: ${result.value.state}.`);
      await refreshRecoveryState();
    });
  }

  async function rerunReadiness(): Promise<void> {
    await run("readiness", async () => {
      const result = await window.sourcenerveDesktop.rerunRecoveryReadiness();
      if (!result.ok) throw new Error(result.error.message);
      setReadiness(result.value);
      setMessage(result.value.health === "ok" ? "Health and readiness checks completed." : "Local daemon is unavailable.");
    });
  }

  async function rebuildIndexes(): Promise<void> {
    await run("rebuild", async () => {
      const result = await window.sourcenerveDesktop.rebuildManagedIndexes();
      if (!result.ok) throw new Error(result.error.message);
      setMessage(result.value.message);
    });
  }

  async function createBackup(): Promise<void> {
    await run("backup", async () => {
      const result = await window.sourcenerveDesktop.createAndValidateStateBackup();
      if (!result.ok) throw new Error(result.error.message);
      setBackup(result.value);
      setMessage(result.value.valid ? "State backup created and integrity-validated." : "Backup was created but failed validation.");
      await refreshRecoveryState();
    });
  }

  async function validateLatestBackup(): Promise<void> {
    await run("validate-backup", async () => {
      const result = await window.sourcenerveDesktop.validateLatestStateBackup();
      if (!result.ok) throw new Error(result.error.message);
      setBackup(result.value);
      setMessage(result.value.valid ? "Latest Desktop state backup is valid." : "Latest Desktop state backup failed validation.");
    });
  }

  async function openDirectory(kind: "state" | "logs"): Promise<void> {
    await run(`open-${kind}`, async () => {
      const result = kind === "state"
        ? await window.sourcenerveDesktop.openStateDirectory()
        : await window.sourcenerveDesktop.openLogsDirectory();
      if (!result.ok) throw new Error(result.error.message);
      setMessage(`${kind === "state" ? "State" : "Logs"} directory opened.`);
    });
  }

  async function resetUiSettings(): Promise<void> {
    await run("reset-ui", async () => {
      const result = await window.sourcenerveDesktop.resetDesktopUiSettings();
      if (!result.ok) throw new Error(result.error.message);
      try {
        window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
      } catch {
        // Renderer progress is optional; Main-owned preference reset is authoritative.
      }
      setMessage(`${result.value.message} Onboarding UI progress was cleared.`);
    });
  }

  async function run(name: string, action: () => Promise<void>): Promise<void> {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Diagnostics operation failed");
    } finally {
      setBusy(null);
    }
  }

  const previousExit = recovery?.crash.previousMainExit;
  const daemonExit = recovery?.crash.lastDaemonExit;

  return (
    <div className="diagnostics-grid">
      <Panel title="Support bundle" eyebrow="Preview before export">
        <div className="diagnostics-section">
          <p className="muted">
            The bundle is generated locally and works offline. It contains status/config shape, hashed state locations and bounded sanitized logs — never tokens, Authorization headers, source bodies, patch bodies or repository diffs.
          </p>
          <div className="workspace-actions">
            <button className="button" type="button" disabled={busy !== null} onClick={() => void generatePreview()}>
              {busy === "preview" ? "Generating…" : preview ? "Refresh preview" : "Generate preview"}
            </button>
            <button className="button button--quiet" type="button" disabled={!preview || busy !== null} onClick={() => void exportBundle("text")}>
              Export TXT
            </button>
            <button className="button button--quiet" type="button" disabled={!preview || busy !== null} onClick={() => void exportBundle("zip")}>
              Export ZIP
            </button>
          </div>
          {preview ? (
            <>
              <div className="diagnostics-meta">
                <span>{formatBytes(preview.bytes)}</span>
                <span>SHA-256 <code>{preview.sha256.slice(0, 16)}…</code></span>
                <span>{new Date(preview.generatedAt).toLocaleString()}</span>
              </div>
              <pre className="support-preview" aria-label="Exact support bundle preview">{preview.text}</pre>
            </>
          ) : (
            <div className="empty-state">
              <strong>No support bundle prepared.</strong>
              <p>Generate a preview first; export always uses that exact one-shot snapshot.</p>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Recovery" eyebrow="Explicit safe actions">
        <div className="diagnostics-section">
          <div className="recovery-status-grid">
            <div>
              <span>Previous Desktop exit</span>
              <strong>{previousExit ? (previousExit.clean ? "Clean" : "Unexpected") : "No prior marker"}</strong>
              {previousExit ? <small>Started {new Date(previousExit.startedAt).toLocaleString()}</small> : null}
            </div>
            <div>
              <span>Last daemon exit</span>
              <strong>{daemonExit?.state ?? "No recorded exit"}</strong>
              {daemonExit ? <small>{daemonExit.message ?? daemonExit.signal ?? `exit ${daemonExit.exitCode ?? "unknown"}`}</small> : null}
            </div>
            <div>
              <span>State location</span>
              <strong><code>{recovery?.stateDirectoryHash ?? "—"}</code></strong>
            </div>
            <div>
              <span>Latest backup</span>
              <strong>{recovery?.latestBackup ?? "None created by Desktop"}</strong>
            </div>
          </div>

          <div className="recovery-actions">
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void restartDaemon()}>Restart daemon</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void rerunReadiness()}>Re-run readiness</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void rebuildIndexes()}>Rebuild indexes</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void createBackup()}>Create + validate backup</button>
            <button className="button button--quiet" type="button" disabled={busy !== null || !recovery?.latestBackup} onClick={() => void validateLatestBackup()}>Validate latest backup</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void openDirectory("state")}>Open state directory</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void openDirectory("logs")}>Open logs directory</button>
            <button className="button button--quiet" type="button" disabled={busy !== null} onClick={() => void resetUiSettings()}>Reset Desktop UI settings</button>
          </div>

          {readiness ? (
            <div className="recovery-result">
              <StatusBadge label={`Health: ${readiness.health}`} tone={readiness.health === "ok" ? "ready" : "warning"} />
              <span>Checked {new Date(readiness.checkedAt).toLocaleString()}</span>
              {readiness.error ? <span>{readiness.error}</span> : null}
            </div>
          ) : null}
          {backup ? (
            <div className="recovery-result">
              <StatusBadge label={backup.valid ? "Backup valid" : "Backup invalid"} tone={backup.valid ? "ready" : "warning"} />
              <span>{formatBytes(backup.bytes)} · integrity {backup.integrity} · migrations {backup.migrationCount}</span>
            </div>
          ) : null}
        </div>
      </Panel>

      {error ? <div className="workspace-error diagnostics-banner" role="alert">{error}</div> : null}
      {message ? <div className="diagnostics-banner diagnostics-banner--success" role="status">{message}</div> : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
