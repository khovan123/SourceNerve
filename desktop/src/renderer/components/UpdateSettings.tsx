import { useEffect, useState } from "react";

import type { DesktopUpdateView } from "../../shared/update-api";
import { Panel } from "./Panel";

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

  return (
    <Panel title="Updates" eyebrow="Stable channel">
      <div className="settings-list" aria-busy={busy || state === "checking" || state === "downloading"}>
        <div className="settings-row">
          <span>
            <strong>SourceNerve {view?.currentVersion ?? ""}</strong>
            <small>
              {view?.enabled
                ? `GitHub Releases · ${view.updaterChannel}`
                : view?.message ?? "Update status is loading."}
            </small>
          </span>
          <button type="button" disabled={!canCheck} onClick={() => void run("check")}>Check for updates</button>
        </div>

        {view?.release ? (
          <div className="settings-row">
            <span>
              <strong>Version {view.release.version}</strong>
              <small>
                Bundled daemon {view.release.daemonVersion} · product profile schema v{view.release.profileSchemaVersion}
              </small>
            </span>
            {canDownload ? (
              <button type="button" onClick={() => void run("download")}>Download update</button>
            ) : null}
            {canRestart ? (
              <button type="button" onClick={() => void run("restart")}>Restart to update</button>
            ) : null}
          </div>
        ) : null}

        {view?.progress ? (
          <div>
            <progress max={100} value={view.progress.percent} aria-label="Update download progress" />
            <p className="muted">{percent}% downloaded</p>
          </div>
        ) : null}
      </div>

      {view?.release?.releaseNotes ? (
        <details>
          <summary>Release notes</summary>
          <p className="muted">{view.release.releaseNotes}</p>
        </details>
      ) : null}
      {view?.message ? <p className="muted" role="status">{view.message}</p> : null}
      {error ? <p className="muted" role="alert">{error}</p> : null}
      <p className="muted">
        SourceNerve updates the Desktop app, bundled daemon and product defaults as one unit. Workspace data and OS-secure-store credentials stay outside the application install directory.
      </p>
    </Panel>
  );
}
