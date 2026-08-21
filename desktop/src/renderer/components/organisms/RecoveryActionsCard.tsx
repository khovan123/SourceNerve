import type { ReactNode } from "react";
import { DatabaseBackup, FolderOpen, HeartPulse, RefreshCw, RotateCcw, Settings2 } from "lucide-react";

import type { RecoveryReadinessResult, RecoveryStateView, StateBackupValidationView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { InlineNotice } from "../molecules/InlineNotice";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function RecoveryActionsCard({
  recovery,
  readiness,
  backup,
  busy,
  onRestartDaemon,
  onRerunReadiness,
  onRebuildIndexes,
  onCreateBackup,
  onValidateBackup,
  onOpenDirectory,
  onResetUi,
}: {
  recovery: RecoveryStateView | null;
  readiness: RecoveryReadinessResult | null;
  backup: StateBackupValidationView | null;
  busy: string | null;
  onRestartDaemon(): void;
  onRerunReadiness(): void;
  onRebuildIndexes(): void;
  onCreateBackup(): void;
  onValidateBackup(): void;
  onOpenDirectory(kind: "state" | "logs"): void;
  onResetUi(): void;
}) {
  const previousExit = recovery?.crash.previousMainExit;
  const daemonExit = recovery?.crash.lastDaemonExit;

  return (
    <SurfaceCard title="Recovery & local maintenance" eyebrow="Explicit safe actions" description="Routine health operations, state backup tools and UI recovery stay separated so destructive-looking actions are never mixed into normal status controls.">
      <div className="space-y-4">
        <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          <Fact label="Previous Desktop exit" value={previousExit ? (previousExit.clean ? "Clean" : "Unexpected") : "No prior marker"} detail={previousExit ? `Started ${new Date(previousExit.startedAt).toLocaleString()}` : undefined} />
          <Fact label="Last daemon exit" value={daemonExit?.state ?? "No recorded exit"} detail={daemonExit ? daemonExit.message ?? daemonExit.signal ?? `exit ${daemonExit.exitCode ?? "unknown"}` : undefined} />
          <Fact label="State location" value={recovery?.stateDirectoryHash ?? "—"} mono />
          <Fact label="Latest backup" value={recovery?.latestBackup ?? "None created by Desktop"} mono />
        </dl>

        <ActionGroup title="Routine checks" description="Safe operational actions that do not replace local state.">
          <RecoveryButton icon={<RotateCcw className="size-3.5" />} label="Restart daemon" disabled={busy !== null} onClick={onRestartDaemon} />
          <RecoveryButton icon={<HeartPulse className="size-3.5" />} label="Re-run readiness" disabled={busy !== null} onClick={onRerunReadiness} />
          <RecoveryButton icon={<RefreshCw className="size-3.5" />} label="Rebuild indexes" disabled={busy !== null} onClick={onRebuildIndexes} />
        </ActionGroup>

        <ActionGroup title="State protection" description="Create or validate integrity-checked Desktop state backups before deeper recovery work.">
          <RecoveryButton icon={<DatabaseBackup className="size-3.5" />} label="Create + validate backup" disabled={busy !== null} onClick={onCreateBackup} />
          <RecoveryButton icon={<DatabaseBackup className="size-3.5" />} label="Validate latest backup" disabled={busy !== null || !recovery?.latestBackup} onClick={onValidateBackup} />
          <RecoveryButton icon={<FolderOpen className="size-3.5" />} label="Open state directory" disabled={busy !== null} onClick={() => onOpenDirectory("state")} />
          <RecoveryButton icon={<FolderOpen className="size-3.5" />} label="Open logs directory" disabled={busy !== null} onClick={() => onOpenDirectory("logs")} />
        </ActionGroup>

        <div className="rounded-xl border border-warning/20 bg-warning/[0.045] p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold text-foreground">Reset Desktop UI settings</p>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground">Clears Desktop-owned UI preferences/onboarding progress only. Repository files and SourceNerve workspace state are not deleted.</p>
            </div>
            <ActionButton variant="secondary" size="sm" disabled={busy !== null} onClick={onResetUi}><Settings2 className="size-3.5" aria-hidden="true" />Reset UI settings</ActionButton>
          </div>
        </div>

        {readiness ? (
          <InlineNotice tone={readiness.health === "ok" ? "success" : "warning"} title={`Health: ${readiness.health}`}>
            Checked {new Date(readiness.checkedAt).toLocaleString()}{readiness.error ? ` · ${readiness.error}` : ""}
          </InlineNotice>
        ) : null}

        {backup ? (
          <InlineNotice tone={backup.valid ? "success" : "warning"} title={backup.valid ? "Backup valid" : "Backup invalid"}>
            {formatBytes(backup.bytes)} · integrity {backup.integrity} · migrations {backup.migrationCount}
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function ActionGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-muted/15 p-3">
      <div className="mb-3"><h3 className="text-xs font-semibold text-foreground">{title}</h3><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</p></div>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function RecoveryButton({ icon, label, disabled, onClick }: { icon: ReactNode; label: string; disabled: boolean; onClick(): void }) {
  return <ActionButton variant="secondary" size="sm" disabled={disabled} onClick={onClick} className="justify-start">{icon}{label}</ActionButton>;
}

function Fact({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "select-all font-mono" : ""}`} title={value}>{value}</dd>
      {detail ? <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
