import { useEffect, useState } from "react";

import type {
  RecoveryReadinessResult,
  RecoveryStateView,
  StateBackupValidationView,
  SupportBundleExportFormat,
  SupportBundlePreview,
} from "../../shared/desktop-api";
import { InlineNotice } from "./molecules/InlineNotice";
import { RecoveryActionsCard } from "./organisms/RecoveryActionsCard";
import { SupportBundleCard } from "./organisms/SupportBundleCard";

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
      setMessage(result.value.saved
        ? `Support bundle exported as ${format.toUpperCase()} (${formatBytes(result.value.bytes)}).`
        : "Export cancelled. Nothing was written.");
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

  return (
    <section className="space-y-4" aria-label="Diagnostics and recovery">
      {error ? <InlineNotice tone="danger" title="Diagnostics action failed" role="alert">{error}</InlineNotice> : null}
      {message ? <InlineNotice tone="success" title="Diagnostics action completed" role="status">{message}</InlineNotice> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <SupportBundleCard
          preview={preview}
          busy={busy}
          onGenerate={() => void generatePreview()}
          onExport={(format) => void exportBundle(format)}
        />
        <RecoveryActionsCard
          recovery={recovery}
          readiness={readiness}
          backup={backup}
          busy={busy}
          onRestartDaemon={() => void restartDaemon()}
          onRerunReadiness={() => void rerunReadiness()}
          onRebuildIndexes={() => void rebuildIndexes()}
          onCreateBackup={() => void createBackup()}
          onValidateBackup={() => void validateLatestBackup()}
          onOpenDirectory={(kind) => void openDirectory(kind)}
          onResetUi={() => void resetUiSettings()}
        />
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
