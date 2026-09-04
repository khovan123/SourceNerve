import { useEffect, useMemo, useRef, useState } from "react";

import type {
  GitTransportValidation,
  ManagedWorkspaceView,
  WorkspaceSaveInput,
} from "../../shared/desktop-api";
import type { WorkspaceDraft } from "../workspace-view-model";
import { InlineNotice } from "./molecules/InlineNotice";
import { WorkspaceCollection } from "./organisms/WorkspaceCollection";
import { WorkspaceEditorPanel } from "./organisms/WorkspaceEditorPanel";
import { WorkspaceManagerHeader } from "./organisms/WorkspaceManagerHeader";

export function WorkspaceManagerScreen({
  onWorkspaceStateChanged,
}: {
  onWorkspaceStateChanged(): void;
}) {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checkingTransportId, setCheckingTransportId] = useState<string | null>(null);
  const [transportChecks, setTransportChecks] = useState<Record<string, GitTransportValidation>>({});
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const refreshGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state" && (event.component === "workspace" || event.component === "daemon" || event.component === "git")) {
        void refresh();
      }
    });
    return () => {
      mounted.current = false;
      refreshGeneration.current += 1;
      unsubscribe();
    };
  }, []);

  const validCount = useMemo(
    () => workspaces.filter((workspace) => workspace.validation.state === "ready").length,
    [workspaces],
  );

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration.current;
    try {
      const result = await window.sourcenerveDesktop.listManagedWorkspaces();
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setLoading(false);
      if (result.ok) {
        setWorkspaces(result.value);
        setError(null);
        return;
      }
      setError(result.error.message);
    } catch (refreshError) {
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setLoading(false);
      setError(desktopInvokeError(refreshError, "Workspace state could not be refreshed."));
    }
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
    } catch (actionError) {
      setError(desktopInvokeError(actionError, "Repository selection could not be opened."));
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
    } catch (actionError) {
      setError(desktopInvokeError(actionError, "Workspace could not be saved."));
      await refresh();
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
    let removed = false;
    try {
      const result = await window.sourcenerveDesktop.removeWorkspace(workspaceId);
      if (!result.ok) {
        setError(result.error.message);
      } else {
        removed = result.value.removed;
        setWorkspaces((current) => current.filter((workspace) => workspace.id !== workspaceId));
        setTransportChecks((current) => {
          const next = { ...current };
          delete next[workspaceId];
          return next;
        });
        setConfirmRemoveId(null);
        if (draft?.originalId === workspaceId) setDraft(null);
      }
    } catch (actionError) {
      setError(desktopInvokeError(actionError, "Workspace removal could not be completed."));
    } finally {
      // Always re-read the persisted registry. A local mutation may have committed
      // before a later runtime/grant synchronization step reported an error.
      await refresh();
      if (removed) onWorkspaceStateChanged();
      setBusy(false);
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
    } catch (actionError) {
      setError(desktopInvokeError(actionError, "Git transport check could not be completed."));
    } finally {
      setCheckingTransportId(null);
    }
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
        <InlineNotice tone="danger" title="Workspace action failed" role="alert">
          {error}
        </InlineNotice>
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
        checkingTransportId={checkingTransportId}
        transportChecks={transportChecks}
        confirmRemoveId={confirmRemoveId}
        onEdit={editWorkspace}
        onCheckTransport={(workspaceId) => void checkGitTransport(workspaceId)}
        onRemove={(workspaceId) => void removeWorkspace(workspaceId)}
        onCancelRemove={() => setConfirmRemoveId(null)}
      />
    </section>
  );
}

function desktopInvokeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
