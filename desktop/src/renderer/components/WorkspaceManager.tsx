import { useEffect, useMemo, useState } from "react";

import type {
  GitTransportValidation,
  ManagedWorkspaceView,
  WorkspaceAccess,
  WorkspaceRepositorySelection,
  WorkspaceSaveInput,
} from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge, type StatusTone } from "./StatusBadge";

interface WorkspaceDraft {
  originalId?: string;
  selection?: WorkspaceRepositorySelection;
  id: string;
  name: string;
  access: WorkspaceAccess;
  remote: string;
  defaultBranch: string;
  root: string;
}

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
    <div className="workspace-manager">
      <div className="workspace-manager__summary">
        <div>
          <p className="eyebrow">Managed repositories</p>
          <strong>{loading ? "Loading…" : `${validCount} ready · ${workspaces.length} registered`}</strong>
          <p className="muted">
            SourceNerve stores registration metadata only. Removing a workspace never deletes the repository directory or its files.
          </p>
        </div>
        <button className="button" type="button" disabled={busy} onClick={() => void chooseRepository()}>
          Add workspace
        </button>
      </div>

      {error ? <div className="workspace-error" role="alert">{error}</div> : null}

      {draft ? (
        <WorkspaceEditor
          draft={draft}
          fieldErrors={fieldErrors}
          busy={busy}
          onChange={setDraft}
          onChooseRepository={() => void chooseRepository(workspaces.find((item) => item.id === draft.originalId))}
          onCancel={() => setDraft(null)}
          onSave={() => void saveDraft()}
        />
      ) : null}

      <div className="workspace-list">
        {!loading && workspaces.length === 0 ? (
          <Panel title="No managed workspaces" eyebrow="Repository">
            <div className="empty-state">
              <strong>Choose a local Git repository to start.</strong>
              <p>
                Desktop validates the repository, derives provider metadata, materializes the managed runtime, and starts SourceNerve without editing TOML.
              </p>
            </div>
          </Panel>
        ) : null}

        {workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            busy={busy}
            indexing={indexingId === workspace.id}
            checkingTransport={checkingTransportId === workspace.id}
            transportCheck={transportChecks[workspace.id]}
            confirmingRemove={confirmRemoveId === workspace.id}
            onEdit={() => editWorkspace(workspace)}
            onIndex={() => void indexWorkspace(workspace.id)}
            onCheckTransport={() => void checkGitTransport(workspace.id)}
            onCancelIndex={() => void cancelIndex(workspace.id)}
            onRemove={() => void removeWorkspace(workspace.id)}
            onCancelRemove={() => setConfirmRemoveId(null)}
          />
        ))}
      </div>
    </div>
  );
}

function WorkspaceEditor({
  draft,
  fieldErrors,
  busy,
  onChange,
  onChooseRepository,
  onCancel,
  onSave,
}: {
  draft: WorkspaceDraft;
  fieldErrors: Record<string, string>;
  busy: boolean;
  onChange(draft: WorkspaceDraft): void;
  onChooseRepository(): void;
  onCancel(): void;
  onSave(): void;
}) {
  const remotes = draft.selection?.remotes ?? [draft.remote];
  return (
    <Panel title={draft.originalId ? "Edit workspace" : "Add workspace"} eyebrow="Workspace setup">
      <div className="workspace-form">
        <label>
          <span>Repository</span>
          <div className="workspace-form__path-row">
            <code title={draft.root}>{compactPath(draft.root)}</code>
            <button className="button button--quiet" type="button" disabled={busy} onClick={onChooseRepository}>
              Choose different repository
            </button>
          </div>
          {fieldErrors.repository ? <small className="field-error">{fieldErrors.repository}</small> : null}
        </label>
        <div className="workspace-form__grid">
          <label>
            <span>Workspace ID</span>
            <input value={draft.id} maxLength={128} onChange={(event) => onChange({ ...draft, id: event.target.value })} />
            {fieldErrors.id ? <small className="field-error">{fieldErrors.id}</small> : null}
          </label>
          <label>
            <span>Name</span>
            <input value={draft.name} maxLength={128} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
            {fieldErrors.name ? <small className="field-error">{fieldErrors.name}</small> : null}
          </label>
          <label>
            <span>Access</span>
            <select value={draft.access} onChange={(event) => onChange({ ...draft, access: event.target.value as WorkspaceAccess })}>
              <option value="read-only">Read-only</option>
              <option value="read-write" disabled={draft.selection?.localWritable === false}>Read-write</option>
            </select>
            {fieldErrors.access ? <small className="field-error">{fieldErrors.access}</small> : null}
          </label>
          <label>
            <span>Remote</span>
            <select value={draft.remote} onChange={(event) => onChange({ ...draft, remote: event.target.value })}>
              {remotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
            </select>
            {fieldErrors.remote ? <small className="field-error">{fieldErrors.remote}</small> : null}
          </label>
          <label className="workspace-form__wide">
            <span>Default branch</span>
            <input value={draft.defaultBranch} maxLength={256} onChange={(event) => onChange({ ...draft, defaultBranch: event.target.value })} />
            {fieldErrors.defaultBranch ? <small className="field-error">{fieldErrors.defaultBranch}</small> : null}
          </label>
        </div>
        <div className="workspace-actions">
          <button className="button" type="button" disabled={busy || !draft.id.trim() || !draft.name.trim()} onClick={onSave}>
            {busy ? "Applying…" : "Save workspace"}
          </button>
          <button className="button button--quiet" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}

function WorkspaceCard({
  workspace,
  busy,
  indexing,
  checkingTransport,
  transportCheck,
  confirmingRemove,
  onEdit,
  onIndex,
  onCheckTransport,
  onCancelIndex,
  onRemove,
  onCancelRemove,
}: {
  workspace: ManagedWorkspaceView;
  busy: boolean;
  indexing: boolean;
  checkingTransport: boolean;
  transportCheck?: GitTransportValidation;
  confirmingRemove: boolean;
  onEdit(): void;
  onIndex(): void;
  onCheckTransport(): void;
  onCancelIndex(): void;
  onRemove(): void;
  onCancelRemove(): void;
}) {
  const valid = workspace.validation.state === "ready";
  return (
    <Panel title={workspace.name} eyebrow={workspace.id}>
      <div className="workspace-card__status">
        <StatusBadge label={valid ? "Repository ready" : "Repository invalid"} tone={valid ? "ready" : "warning"} />
        <StatusBadge label={workspace.access === "read-write" ? "Read-write" : "Read-only"} tone={workspace.access === "read-write" ? "working" : "neutral"} />
        <StatusBadge label={`Index: ${workspace.index.state}`} tone={indexTone(workspace.index.state)} />
        {workspace.dirty !== undefined ? <StatusBadge label={workspace.dirty ? "Dirty" : "Clean"} tone={workspace.dirty ? "warning" : "ready"} /> : null}
        {transportCheck ? <StatusBadge label={`Git ${transportCheck.transport}: ${transportCheck.ready ? "ready" : "needs auth"}`} tone={transportCheck.ready ? "ready" : "warning"} /> : null}
      </div>
      {workspace.validation.message ? <p className="workspace-validation-error">{workspace.validation.message}</p> : null}
      {transportCheck ? <p className={transportCheck.ready ? "muted" : "workspace-validation-error"} role={transportCheck.ready ? undefined : "alert"}>{transportCheck.message}</p> : null}
      <dl className="workspace-facts">
        <div><dt>Repository</dt><dd>{workspace.repository ?? "Local / unrecognized provider"}</dd></div>
        <div><dt>Provider</dt><dd>{workspace.provider ?? "Local"}</dd></div>
        <div><dt>Branch</dt><dd>{workspace.branch ?? "Detached"} · default {workspace.defaultBranch}</dd></div>
        <div><dt>HEAD</dt><dd><code>{workspace.head ? workspace.head.slice(0, 12) : "Unavailable"}</code></dd></div>
        <div className="workspace-facts__wide"><dt>Local root</dt><dd><code title={workspace.root}>{compactPath(workspace.root)}</code></dd></div>
        <div><dt>Graph</dt><dd>{workspace.index.graphVersion ?? "—"}</dd></div>
        <div><dt>Parsed files</dt><dd>{workspace.index.parsedFiles ?? "—"}</dd></div>
      </dl>
      <div className="workspace-actions">
        <button className="button button--quiet" type="button" disabled={busy || indexing || checkingTransport} onClick={onEdit}>Edit</button>
        <button className="button button--quiet" type="button" disabled={busy || indexing || checkingTransport || !valid} onClick={onCheckTransport}>
          {checkingTransport ? "Checking Git…" : "Check Git push auth"}
        </button>
        {indexing ? (
          <>
            <button className="button" type="button" disabled>Indexing…</button>
            <button className="button button--quiet" type="button" onClick={onCancelIndex}>Cancel indexing</button>
          </>
        ) : (
          <button className="button" type="button" disabled={busy || checkingTransport || !valid} onClick={onIndex}>
            {workspace.index.state === "current" ? "Reindex" : "Index workspace"}
          </button>
        )}
        {confirmingRemove ? (
          <div className="workspace-remove-confirm">
            <span>Remove SourceNerve registration/state only. Repository files stay untouched.</span>
            <button className="button" type="button" disabled={busy} onClick={onRemove}>Confirm remove</button>
            <button className="button button--quiet" type="button" disabled={busy} onClick={onCancelRemove}>Cancel</button>
          </div>
        ) : (
          <button className="button button--quiet" type="button" disabled={busy || indexing || checkingTransport} onClick={onRemove}>Remove</button>
        )}
      </div>
    </Panel>
  );
}

function indexTone(state: ManagedWorkspaceView["index"]["state"]): StatusTone {
  if (state === "current") return "ready";
  if (state === "stale") return "warning";
  if (state === "not-indexed") return "working";
  return "neutral";
}

function compactPath(value: string): string {
  if (value.length <= 72) return value;
  return `${value.slice(0, 28)}…${value.slice(-40)}`;
}
