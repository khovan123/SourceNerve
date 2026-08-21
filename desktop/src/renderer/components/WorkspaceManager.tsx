import { useEffect, useMemo, useState } from "react";

import type {
  GitTransportValidation,
  ManagedWorkspaceView,
  WorkspaceSaveInput,
} from "../../shared/desktop-api";
import type { WorkspaceDraft } from "../workspace-view-model";
import { WorkspaceCollection } from "./organisms/WorkspaceCollection";
import { WorkspaceEditorPanel } from "./organisms/WorkspaceEditorPanel";
import { WorkspaceManagerHeader } from "./organisms/WorkspaceManagerHeader";

export function WorkspaceManagerScreen({ onWorkspaceStateChanged }: { onWorkspaceStateChanged(): void }) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [indexingId, setIndexingId] = useState<string | null>(null);
  const [checkingTransportId, setCheckingTransportId] = useState<string | null>(null);
  const [transportChecks, setTransportChecks] = useState<Record<string, GitTransportValidation>>({});
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state" && (event.component === "workspace" || event.component === "daemon" || event.component === "git")) {
        void refresh();
      }
    });
  }, []);

  const validCount = useMemo(
    () => workspaces.filter((workspace) => workspace.validation.state === "ready").length,
    [workspaces],
  );

  async function refresh(): Promise<void> {
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    setLoading(false);
    if (result.ok) {
      setWorkspaces(result.value);
      setError(null);
      return;
    }
    setError(result.error.message);
  }

  async function chooseRepository(editing?: ManagedWorkspaceView): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.pickWorkspaceRepository();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      if (!result.value) return;
      const selection = result.value;
      setDraft({
        ...(editing ? { originalId: editing.id } : {}),
        selection,
        id: editing?.id ?? selection.suggestedId,
        name: editing?.name ?? selection.suggestedName,
        access:
          editing?.access === "read-write" && selection.localWritable
            ? "read-write"
            : editing?.access ?? (selection.localWritable ? "read-write" : "read-only"),
        remote: selection.remote,
        defaultBranch: selection.defaultBranch,
        root: selection.root,
      });
      setFieldErrors({});
    } finally {
      setBusy(false);
    }
  }

  function editWorkspace(workspace: ManagedWorkspaceView): void {
    setDraft({
      originalId: workspace.id,
      id: workspace.id,
      name: workspace.name,
      access: workspace.access,
      remote: workspace.remote,
      defaultBranch: workspace.defaultBranch,
      root: workspace.root,
    });
    setError(null);
    setFieldErrors({});
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const input: WorkspaceSaveInput = {
      ...(draft.originalId ? { originalId: draft.originalId } : {}),
      ...(draft.selection ? { selectionId: draft.selection.selectionId } : {}),
      id: draft.id.trim(),
      name: draft.name.trim(),
      access: draft.access,
      remote: draft.remote,
      defaultBranch: draft.defaultBranch.trim(),
    };
    try {
      const result = await window.sourcenerveDesktop.saveWorkspace(input);
      if (!result.ok) {
        setError(result.error.message);
        setFieldErrors(result.error.fieldDetails ?? {});
        return;
      }
      setTransportChecks((current) => {
        const next = { ...current };
        delete next[result.value.id];
        return next;
      });
      setDraft(null);
      await refresh();
      onWorkspaceStateChanged();
    } finally {
      setBusy(false);
    }
  }

  async function removeWorkspace(workspaceId: string): Promise<void> {
    if (confirmRemoveId !== workspaceId) {
      setConfirmRemoveId(workspaceId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.removeWorkspace(workspaceId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTransportChecks((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setConfirmRemoveId(null);
      if (draft?.originalId === workspaceId) setDraft(null);
      await refresh();
      onWorkspaceStateChanged();
    } finally {
      setBusy(false);
    }
  }

  async function indexWorkspace(workspaceId: string): Promise<void> {
    setIndexingId(workspaceId);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.indexWorkspace(workspaceId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await refresh();
      onWorkspaceStateChanged();
    } finally {
      setIndexingId(null);
    }
  }

  async function checkGitTransport(workspaceId: string): Promise<void> {
    setCheckingTransportId(workspaceId);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.validateGitTransport(workspaceId);
      if (result.ok) {
        setTransportChecks((current) => ({ ...current, [workspaceId]: result.value }));
      } else {
        setError(result.error.message);
      }
    } finally {
      setCheckingTransportId(null);
    }
  }

  async function cancelIndex(workspaceId: string): Promise<void> {
    await window.sourcenerveDesktop.cancelOperation(`workspace-index.${workspaceId}`);
  }

  return (
    <section className="space-y-4" aria-label="Managed SourceNerve workspaces">
      <WorkspaceManagerHeader
        loading={loading}
        readyCount={validCount}
        totalCount={workspaces.length}
        busy={busy}
        onAdd={() => void chooseRepository()}
      />

      {error ? (
        <div className="rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">
          {error}
        </div>
      ) : null}

      {draft ? (
        <WorkspaceEditorPanel
          draft={draft}
          fieldErrors={fieldErrors}
          busy={busy}
          onChange={setDraft}
          onChooseRepository={() => void chooseRepository(workspaces.find((item) => item.id === draft.originalId))}
          onCancel={() => setDraft(null)}
          onSave={() => void saveDraft()}
        />
      ) : null}

      <WorkspaceCollection
        loading={loading}
        workspaces={workspaces}
        busy={busy}
        indexingId={indexingId}
        checkingTransportId={checkingTransportId}
        transportChecks={transportChecks}
        confirmRemoveId={confirmRemoveId}
        onEdit={editWorkspace}
        onIndex={(workspaceId) => void indexWorkspace(workspaceId)}
        onCheckTransport={(workspaceId) => void checkGitTransport(workspaceId)}
        onCancelIndex={(workspaceId) => void cancelIndex(workspaceId)}
        onRemove={(workspaceId) => void removeWorkspace(workspaceId)}
        onCancelRemove={() => setConfirmRemoveId(null)}
      />
    </section>
  );
}
