import { useEffect, useState } from "react";
import { CheckCircle2, Download, RefreshCw, RotateCcw } from "lucide-react";

import type { DesktopUpdateView } from "../../shared/update-api";
import { ActionButton } from "./atoms/ActionButton";
import { StatusPill } from "./atoms/StatusPill";
import { InlineNotice } from "./molecules/InlineNotice";
import { SurfaceCard } from "./molecules/SurfaceCard";

export function UpdateSettings() {
  const [view, setView] = useState<DesktopUpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.sourcenerveUpdate.subscribe((next) => {
      if (active) setView(next);
    });
    void window.sourcenerveUpdate.getState().then((result) => {
      if (!active) return;
      if (result.ok) setView(result.value);
      else setError(result.error.message);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function run(action: "check" | "download" | "restart"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (action === "restart") {
        const result = await window.sourcenerveUpdate.restartToUpdate();
        if (!result.ok) setError(result.error.message);
        return;
      }
      const result = action === "check"
        ? await window.sourcenerveUpdate.check()
        : await window.sourcenerveUpdate.download();
      if (result.ok) setView(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(false);
    }
  }

  const state = view?.state ?? "idle";
  const percent = view?.progress ? Math.round(view.progress.percent) : 0;
  const canCheck = Boolean(view?.enabled) && !busy && !["checking", "downloading", "installing"].includes(state);
  const canDownload = state === "available" && !busy;
  const canRestart = state === "downloaded" && !busy;
  const stateTone = state === "downloaded" ? "ready" : state === "error" ? "warning" : ["checking", "downloading", "installing"].includes(state) ? "working" : "neutral";

  return (
    <SurfaceCard title="Updates" description="Desktop, bundled daemon and product defaults update together." actions={<StatusPill dot tone={stateTone}>{state}</StatusPill>}>
      <div className="space-y-4" aria-busy={busy || state === "checking" || state === "downloading"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold text-foreground">SourceNerve {view?.currentVersion ?? ""}</p>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{view?.enabled ? `Channel: ${view.updaterChannel}` : "Automatic updates are unavailable in this build."}</p>
          </div>
          <ActionButton variant="secondary" size="sm" disabled={!canCheck} onClick={() => void run("check")}>
            <RefreshCw className={`size-3.5 ${state === "checking" ? "animate-spin" : ""}`} aria-hidden="true" />
            Check for updates
          </ActionButton>
        </div>

        {view?.release ? (
          <div className="rounded-xl border border-border bg-card/60 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold text-foreground">Version {view.release.version}</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">Bundled daemon {view.release.daemonVersion}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {canDownload ? <ActionButton size="sm" onClick={() => void run("download")}><Download className="size-3.5" aria-hidden="true" />Download</ActionButton> : null}
                {canRestart ? <ActionButton size="sm" onClick={() => void run("restart")}><RotateCcw className="size-3.5" aria-hidden="true" />Restart to update</ActionButton> : null}
              </div>
            </div>
            {view.release.releaseNotes ? <details className="mt-3 rounded-lg border border-border bg-muted/25 px-3 py-2"><summary className="cursor-pointer text-[11px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25">Release notes</summary><p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground" tabIndex={0}>{view.release.releaseNotes}</p></details> : null}
          </div>
        ) : null}

        {view?.progress ? (
          <div className="space-y-2 rounded-xl border border-border bg-muted/15 p-3" role="status" aria-label={`Update download ${percent}%`}>
            <div className="flex items-center justify-between gap-3 text-[11px]"><span className="font-medium text-foreground">Downloading</span><span className="text-muted-foreground">{percent}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.min(100, Math.max(0, view.progress.percent))}%` }} /></div>
          </div>
        ) : null}

        {state === "error" && view?.message ? <InlineNotice tone="warning" title="Update needs attention" role="status">{view.message}</InlineNotice> : null}
        {state !== "error" && view?.message ? (
          <div className="flex items-start gap-2 text-[11px] leading-5 text-muted-foreground" role="status">
            {state === "downloaded" ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" /> : null}
            <span>{view.message}</span>
          </div>
        ) : null}
        {error ? <InlineNotice tone="danger" title="Update failed" role="alert">{error}</InlineNotice> : null}
      </div>
    </SurfaceCard>
  );
}
