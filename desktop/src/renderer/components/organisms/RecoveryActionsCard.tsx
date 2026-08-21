import type { ReactNode } from "react";
import { DatabaseBackup, FolderOpen, HeartPulse, RefreshCw, RotateCcw, Settings2 } from "lucide-react";

import type { RecoveryReadinessResult, RecoveryStateView, StateBackupValidationView } from "../../../shared/desktop-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
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
  const disabled = busy !== null;

  return (
    <SurfaceCard
      title="Recovery & maintenance"
      description="Use these controls when the local runtime needs a check, index rebuild, backup, or UI reset. Repository files are not modified."
    >
      <div className="space-y-5">
        <ActionGroup title="Runtime" description="Safe checks for the local daemon and managed indexes.">
          <RecoveryButton icon={<RotateCcw className="size-3.5" aria-hidden="true" />} label="Restart daemon" disabled={disabled} onClick={onRestartDaemon} />
          <RecoveryButton icon={<HeartPulse className="size-3.5" aria-hidden="true" />} label="Check readiness" ariaLabel="Re-run readiness" disabled={disabled} onClick={onRerunReadiness} />
          <RecoveryButton icon={<RefreshCw className="size-3.5" aria-hidden="true" />} label="Rebuild indexes" disabled={disabled} onClick={onRebuildIndexes} />
        </ActionGroup>

        <ActionGroup title="Backup & files" description="Create or validate Desktop state backups and open local support folders.">
          <RecoveryButton icon={<DatabaseBackup className="size-3.5" aria-hidden="true" />} label="Create backup" ariaLabel="Create + validate backup" disabled={disabled} onClick={onCreateBackup} />
          <RecoveryButton icon={<DatabaseBackup className="size-3.5" aria-hidden="true" />} label="Validate backup" ariaLabel="Validate latest backup" disabled={disabled || !recovery?.latestBackup} onClick={onValidateBackup} />
          <RecoveryButton icon={<FolderOpen className="size-3.5" aria-hidden="true" />} label="Open state folder" disabled={disabled} onClick={() => onOpenDirectory("state")} />
          <RecoveryButton icon={<FolderOpen className="size-3.5" aria-hidden="true" />} label="Open logs folder" disabled={disabled} onClick={() => onOpenDirectory("logs")} />
        </ActionGroup>

        {(readiness || backup) ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4" aria-label="Latest recovery results">
            {readiness ? (
              <StatusPill tone={readiness.health === "ok" ? "ready" : "warning"} dot>
                Health: {readiness.health}
              </StatusPill>
            ) : null}
            {backup ? (
              <StatusPill tone={backup.valid ? "ready" : "warning"} dot>
                {backup.valid ? "Backup valid" : "Backup invalid"}
              </StatusPill>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-foreground">Reset interface preferences</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Clears Desktop UI preferences and onboarding progress only.</p>
          </div>
          <ActionButton variant="ghost" size="sm" disabled={disabled} onClick={onResetUi}>
            <Settings2 className="size-3.5" aria-hidden="true" />
            Reset UI settings
          </ActionButton>
        </div>
      </div>
    </SurfaceCard>
  );
}

function ActionGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function RecoveryButton({ icon, label, ariaLabel, disabled, onClick }: { icon: ReactNode; label: string; ariaLabel?: string; disabled: boolean; onClick(): void }) {
  return (
    <ActionButton aria-label={ariaLabel} variant="secondary" size="sm" disabled={disabled} onClick={onClick} className="justify-start">
      {icon}
      {label}
    </ActionButton>
  );
}
