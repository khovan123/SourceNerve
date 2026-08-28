import { useEffect, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import { IntelligenceWorkspaceHeader } from "./organisms/IntelligenceWorkspaceHeader";

export function IntelligenceExplorer() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadWorkspaces();
  }, []);

  async function loadWorkspaces(): Promise<void> {
    setLoading(true);
    setError(null);
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (result.ok) {
      setWorkspaces(result.value);
    } else {
      setWorkspaces([]);
      setError(result.error.message);
    }
    setLoading(false);
  }

  async function reindexWorkspace(workspaceId: string): Promise<void> {
    setBusyWorkspaceId(workspaceId);
    setError(null);
    const result = await window.sourcenerveDesktop.indexWorkspace(workspaceId);
    if (!result.ok) {
      setError(result.error.message);
      setBusyWorkspaceId(null);
      return;
    }
    await loadWorkspaces();
    setBusyWorkspaceId(null);
  }

  return (
    <section className="space-y-4" aria-label="Repository intelligence">
      <IntelligenceWorkspaceHeader
        workspaces={workspaces}
        loading={loading}
        busyWorkspaceId={busyWorkspaceId}
        error={error}
        onReload={() => void loadWorkspaces()}
        onReindex={(workspaceId) => void reindexWorkspace(workspaceId)}
      />
    </section>
  );
}
