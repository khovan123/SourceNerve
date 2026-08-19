import { useEffect, useState } from "react";

import type {
  GitProvider,
  ManagedWorkspaceInput,
  ManagedWorkspaceView,
  WorkspaceAccess,
  WorkspaceValidation,
} from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

const EMPTY_WORKSPACE: ManagedWorkspaceInput = {
  id: "",
  name: "",
  root: "",
  access: "read-write",
  remote: "origin",
  defaultBranch: "main",
};

export function WorkspaceManager() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [form, setForm] = useState<ManagedWorkspaceInput | null>(null);
  const [editing, setEditing] = useState(false);
  const [validation, setValidation] = useState<WorkspaceValidation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (result.ok) {
      setWorkspaces(result.value);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }

  async function chooseRoot(): Promise<void> {
    const selected = await window.sourcenerveDesktop.pickWorkspaceDirectory();
    if (!selected.ok) {
      setError(selected.error.message);
      return;
    }
    if (!selected.value) return;
    setForm((current) => (current ? { ...current, root: selected.value!.path } : current));
    setValidation(null);
  }

  async function validate(): Promise<WorkspaceValidation | null> {
    if (!form) return null;
    setBusy("validate");
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.validateManagedWorkspace(form);
      if (!result.ok) {
        setError(result.error.message);
        return null;
      }
      setValidation(result.value);
      if (result.value.valid) {
        setForm((current) =>
          current
            ? {
                ...current,
                root: result.value.canonicalRoot ?? current.root,
                provider: result.value.provider,
                repository: result.value.repository,
              }
            : current,
        );
      }
      return result.value;
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<void> {
    if (!form) return;
    setBusy("save");
    setError(null);
    try {
      const checked = await window.sourcenerveDesktop.validateManagedWorkspace(form);
      if (!checked.ok) {
        setError(checked.error.message);
        return;
      }
      setValidation(checked.value);
      if (!checked.value.valid) return;

      const input: ManagedWorkspaceInput = {
        ...form,
        root: checked.value.canonicalRoot ?? form.root,
        provider: checked.value.provider,
        repository: checked.value.repository,
      };
      const result = await window.sourcenerveDesktop.saveManagedWorkspace(input);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setForm(null);
      setValidation(null);
      setEditing(false);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function indexWorkspace(id: string): Promise<void> {
    setBusy(`index:${id}`);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.indexManagedWorkspace(id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function removeWorkspace(id: string): Promise<void> {
    if (removeConfirm !== id) {
      setRemoveConfirm(id);
      return;
    }
    setBusy(`remove:${id}`);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.removeManagedWorkspace(id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setRemoveConfirm(null);
      if (form?.id === id) {
        setForm(null);
        setValidation(null);
        setEditing(false);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  function startCreate(): void {
    setForm({ ...EMPTY_WORKSPACE });
    setValidation(null);
    setEditing(false);
    setError(null);
  }

  function startEdit(workspace: ManagedWorkspaceView): void {
    setForm({
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      access: workspace.access,
      remote: workspace.remote,
      defaultBranch: workspace.defaultBranch,
      provider: workspace.provider,
      repository: workspace.repository,
    });
    setValidation(workspace.validation);
    setEditing(true);
    setError(null);
  }

  return (
    <section className="workspace-manager" aria-labelledby="workspace-manager-title">
      <div className="workspace-manager__header">
        <div>
          <p className="eyebrow">Repository registry</p>
          <h1 id="workspace-manager-title">Workspaces</h1>
          <p>
            Register local Git repositories without editing TOML. SourceNerve validates the
            repository before applying managed runtime configuration.
          </p>
        </div>
        <button className="button" type="button" onClick={startCreate} disabled={Boolean(form)}>
          Add workspace
        </button>
      </div>

      {error ? <div className="workspace-alert" role="alert">{error}</div> : null}

      {form ? (
        <WorkspaceForm
          value={form}
          editing={editing}
          validation={validation}
          busy={busy}
          onChange={(next) => {
            setForm(next);
            setValidation(null);
          }}
          onChooseRoot={() => void chooseRoot()}
          onValidate={() => void validate()}
          onSave={() => void save()}
          onCancel={() => {
            setForm(null);
            setValidation(null);
            setEditing(false);
          }}
        />
      ) : null}

      <div className="workspace-cards">
        {workspaces.length === 0 ? (
          <Panel title="No workspaces yet" eyebrow="Repository">
            <div className="empty-state">
              <strong>Choose an existing Git repository to begin.</strong>
              <p>
                The directory picker authorizes only the repository you select. SourceNerve never
                deletes repository files when a workspace registration is removed.
              </p>
            </div>
          </Panel>
        ) : (
          workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              busy={busy}
              removeConfirm={removeConfirm === workspace.id}
              onEdit={() => startEdit(workspace)}
              onIndex={() => void indexWorkspace(workspace.id)}
              onRemove={() => void removeWorkspace(workspace.id)}
              onCancelRemove={() => setRemoveConfirm(null)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function WorkspaceForm({
  value,
  editing,
  validation,
  busy,
  onChange,
  onChooseRoot,
  onValidate,
  onSave,
  onCancel,
}: {
  value: ManagedWorkspaceInput;
  editing: boolean;
  validation: WorkspaceValidation | null;
  busy: string | null;
  onChange(value: ManagedWorkspaceInput): void;
  onChooseRoot(): void;
  onValidate(): void;
  onSave(): void;
  onCancel(): void;
}) {
  const working = busy === "validate" || busy === "save";
  return (
    <Panel title={editing ? `Edit ${value.id}` : "Add workspace"} eyebrow="Configuration">
      <div className="workspace-form">
        <Field label="Workspace ID">
          <input
            value={value.id}
            disabled={editing || working}
            onChange={(event) => onChange({ ...value, id: event.target.value })}
            placeholder="my-repository"
          />
        </Field>
        <Field label="Display name">
          <input
            value={value.name}
            disabled={working}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            placeholder="My Repository"
          />
        </Field>
        <Field label="Repository root" wide>
          <div className="workspace-root-picker">
            <input value={value.root} readOnly placeholder="Choose a local Git repository" />
            <button className="button button--quiet" type="button" onClick={onChooseRoot} disabled={working}>
              Browse…
            </button>
          </div>
        </Field>
        <Field label="Access">
          <select
            value={value.access}
            disabled={working}
            onChange={(event) => onChange({ ...value, access: event.target.value as WorkspaceAccess })}
          >
            <option value="read-only">Read only</option>
            <option value="read-write">Read / write</option>
          </select>
        </Field>
        <Field label="Remote">
          <input
            value={value.remote}
            disabled={working}
            onChange={(event) => onChange({ ...value, remote: event.target.value })}
          />
        </Field>
        <Field label="Default branch">
          <input
            value={value.defaultBranch}
            disabled={working}
            onChange={(event) => onChange({ ...value, defaultBranch: event.target.value })}
          />
        </Field>
        <Field label="Provider">
          <select
            value={value.provider ?? ""}
            disabled={working}
            onChange={(event) =>
              onChange({
                ...value,
                provider: (event.target.value || undefined) as GitProvider | undefined,
                repository: event.target.value ? value.repository : undefined,
              })
            }
          >
            <option value="">Auto / local only</option>
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
          </select>
        </Field>
        <Field label="Repository slug" wide>
          <input
            value={value.repository ?? ""}
            disabled={working || !value.provider}
            onChange={(event) => onChange({ ...value, repository: event.target.value || undefined })}
            placeholder={value.provider === "gitlab" ? "group/subgroup/repo" : "owner/repo"}
          />
        </Field>
      </div>

      {validation ? <ValidationSummary validation={validation} /> : null}

      <div className="onboarding-actions">
        <button className="button button--quiet" type="button" onClick={onValidate} disabled={working || !value.root}>
          {busy === "validate" ? "Validating…" : "Validate"}
        </button>
        <button className="button" type="button" onClick={onSave} disabled={working || !value.root}>
          {busy === "save" ? "Applying…" : "Save & apply"}
        </button>
        <button className="button button--quiet" type="button" onClick={onCancel} disabled={working}>
          Cancel
        </button>
      </div>
    </Panel>
  );
}

function WorkspaceCard({
  workspace,
  busy,
  removeConfirm,
  onEdit,
  onIndex,
  onRemove,
  onCancelRemove,
}: {
  workspace: ManagedWorkspaceView;
  busy: string | null;
  removeConfirm: boolean;
  onEdit(): void;
  onIndex(): void;
  onRemove(): void;
  onCancelRemove(): void;
}) {
  const validation = workspace.validation;
  const indexBusy = busy === `index:${workspace.id}`;
  const removeBusy = busy === `remove:${workspace.id}`;
  return (
    <Panel title={workspace.name} eyebrow={workspace.id}>
      <div className="workspace-card__badges">
        <StatusBadge
          label={validation.valid ? "Valid" : "Needs repair"}
          tone={validation.valid ? "ready" : "warning"}
        />
        <StatusBadge
          label={validation.dirty ? "Dirty" : "Clean"}
          tone={validation.dirty ? "warning" : "ready"}
        />
        <StatusBadge
          label={workspace.indexed ? "Indexed" : "Index needed"}
          tone={workspace.indexed ? "ready" : "neutral"}
        />
        <StatusBadge label={workspace.access} tone="neutral" />
      </div>
      <dl className="workspace-facts">
        <div><dt>Root</dt><dd title={workspace.root}>{workspace.root}</dd></div>
        <div><dt>HEAD</dt><dd>{shortHead(validation.head)}</dd></div>
        <div><dt>Branch</dt><dd>{validation.currentBranch ?? "—"}</dd></div>
        <div><dt>Remote</dt><dd>{workspace.remote} · {workspace.defaultBranch}</dd></div>
        <div><dt>Provider</dt><dd>{workspace.provider ? `${workspace.provider} · ${workspace.repository ?? "—"}` : "Local only"}</dd></div>
        <div><dt>Graph</dt><dd>{workspace.graphVersion !== undefined ? `v${workspace.graphVersion}` : "—"}</dd></div>
      </dl>
      {validation.errors.length > 0 ? (
        <ul className="workspace-messages workspace-messages--error">
          {validation.errors.map((message) => <li key={message}>{message}</li>)}
        </ul>
      ) : null}
      <div className="onboarding-actions">
        <button className="button button--quiet" type="button" onClick={onEdit} disabled={Boolean(busy)}>
          Edit
        </button>
        <button className="button" type="button" onClick={onIndex} disabled={Boolean(busy) || !validation.valid}>
          {indexBusy ? "Indexing…" : workspace.indexed ? "Reindex" : "Index"}
        </button>
        {removeConfirm ? (
          <>
            <button className="button button--danger" type="button" onClick={onRemove} disabled={removeBusy}>
              {removeBusy ? "Removing…" : "Confirm remove"}
            </button>
            <button className="button button--quiet" type="button" onClick={onCancelRemove} disabled={removeBusy}>
              Keep
            </button>
          </>
        ) : (
          <button className="button button--quiet" type="button" onClick={onRemove} disabled={Boolean(busy)}>
            Remove registration
          </button>
        )}
      </div>
      {removeConfirm ? (
        <p className="muted">This removes only SourceNerve registration/state. Repository files are never deleted.</p>
      ) : null}
    </Panel>
  );
}

function ValidationSummary({ validation }: { validation: WorkspaceValidation }) {
  return (
    <div className={`workspace-validation ${validation.valid ? "workspace-validation--valid" : "workspace-validation--invalid"}`}>
      <div className="workspace-card__badges">
        <StatusBadge label={validation.valid ? "Validation passed" : "Validation failed"} tone={validation.valid ? "ready" : "warning"} />
        {validation.head ? <StatusBadge label={validation.dirty ? "Dirty tree" : "Clean tree"} tone={validation.dirty ? "warning" : "ready"} /> : null}
      </div>
      {validation.canonicalRoot ? <p><strong>Canonical root:</strong> {validation.canonicalRoot}</p> : null}
      {validation.head ? <p><strong>HEAD:</strong> {shortHead(validation.head)} · {validation.currentBranch}</p> : null}
      {validation.remoteUrl ? <p><strong>Remote:</strong> {validation.remoteUrl}</p> : null}
      {validation.provider ? <p><strong>Provider:</strong> {validation.provider} · {validation.repository}</p> : null}
      {validation.errors.length > 0 ? <ul className="workspace-messages workspace-messages--error">{validation.errors.map((message) => <li key={message}>{message}</li>)}</ul> : null}
      {validation.warnings.length > 0 ? <ul className="workspace-messages">{validation.warnings.map((message) => <li key={message}>{message}</li>)}</ul> : null}
    </div>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`workspace-field ${wide ? "workspace-field--wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function shortHead(head?: string): string {
  return head ? head.slice(0, 12) : "—";
}
