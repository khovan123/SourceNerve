import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";

export interface WorkspaceIndexProgressView {
  operationId: string;
  workspaceId: string;
  workspaceName: string;
  stage: string;
  current: number;
  total: number;
}

export function WorkspaceIndexProgressToast({
  progress,
  onCancel,
}: {
  progress: WorkspaceIndexProgressView | null;
  onCancel(operationId: string): void;
}) {
  if (!progress) return null;

  const failed = progress.stage === "index-failed";
  const cancelled = progress.stage === "index-cancelled";
  const complete = progress.stage === "index-complete";
  const running = !failed && !cancelled && !complete;
  const percent = progress.total > 0
    ? Math.round(Math.min(100, Math.max(0, (progress.current / progress.total) * 100)))
    : 0;
  const statusText = failed
    ? "Indexing failed"
    : cancelled
      ? "Indexing cancelled"
      : complete
        ? "Index complete"
        : "Indexing repository intelligence";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex justify-center px-4">
      <div
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-border/90 bg-card/95 p-4 shadow-[0_18px_55px_rgba(0,0,0,0.22)] backdrop-blur-xl"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-start gap-3">
          {running ? (
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          ) : complete ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-xs font-semibold text-foreground">{progress.workspaceName}</p>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{percent}%</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{statusText}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-label={`Index progress ${percent}%`}>
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
          {running ? (
            <ActionButton variant="ghost" size="sm" onClick={() => onCancel(progress.operationId)}>
              Cancel
            </ActionButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
