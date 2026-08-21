import type { ReactNode } from "react";
import { FolderOpen, Save, X } from "lucide-react";

import type { WorkspaceAccess } from "../../../shared/desktop-api";
import { compactWorkspacePath, type WorkspaceDraft } from "../../workspace-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export function WorkspaceEditorPanel({
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
    <SurfaceCard
      title={draft.originalId ? "Edit workspace" : "Add workspace"}
      eyebrow="Workspace setup"
      actions={(
        <ActionButton variant="ghost" size="icon" disabled={busy} onClick={onCancel} aria-label="Close workspace editor">
          <X className="size-4" aria-hidden="true" />
        </ActionButton>
      )}
    >
      <div className="space-y-5">
        <Field label="Repository" error={fieldErrors.repository}>
          <div className="grid gap-2 rounded-xl border border-border bg-muted/35 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <code className="min-w-0 break-all text-xs leading-5 text-foreground" title={draft.root}>{compactWorkspacePath(draft.root)}</code>
            <ActionButton variant="secondary" size="md" disabled={busy} onClick={onChooseRepository} className="shrink-0">
              <FolderOpen className="size-4" aria-hidden="true" />
              Choose repository
            </ActionButton>
          </div>
        </Field>

        <div className="grid items-start gap-4 md:grid-cols-2">
          <Field label="Workspace ID" error={fieldErrors.id}>
            <input className={controlClass} value={draft.id} maxLength={128} onChange={(event) => onChange({ ...draft, id: event.target.value })} />
          </Field>
          <Field label="Name" error={fieldErrors.name}>
            <input className={controlClass} value={draft.name} maxLength={128} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
          </Field>
          <Field label="Access" error={fieldErrors.access}>
            <select className={controlClass} value={draft.access} onChange={(event) => onChange({ ...draft, access: event.target.value as WorkspaceAccess })}>
              <option value="read-only">Read-only</option>
              <option value="read-write" disabled={draft.selection?.localWritable === false}>Read-write</option>
            </select>
          </Field>
          <Field label="Remote" error={fieldErrors.remote}>
            <select className={controlClass} value={draft.remote} onChange={(event) => onChange({ ...draft, remote: event.target.value })}>
              {remotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
            </select>
          </Field>
          <div className="md:col-span-2">
            <Field label="Default branch" error={fieldErrors.defaultBranch}>
              <input className={controlClass} value={draft.defaultBranch} maxLength={256} onChange={(event) => onChange({ ...draft, defaultBranch: event.target.value })} />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
          <ActionButton size="md" disabled={busy || !draft.id.trim() || !draft.name.trim()} onClick={onSave}>
            <Save className="size-4" aria-hidden="true" />
            {busy ? "Applying…" : "Save workspace"}
          </ActionButton>
          <ActionButton variant="ghost" size="md" disabled={busy} onClick={onCancel}>Cancel</ActionButton>
        </div>
      </div>
    </SurfaceCard>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="grid min-w-0 content-start gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {error ? <small className="text-xs leading-5 text-danger">{error}</small> : null}
    </label>
  );
}
