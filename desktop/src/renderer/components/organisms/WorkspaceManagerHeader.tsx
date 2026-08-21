import { FolderGit2, Plus } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";

export function WorkspaceManagerHeader({
  loading,
  readyCount,
  totalCount,
  busy,
  onAdd,
}: {
  loading: boolean;
  readyCount: number;
  totalCount: number;
  busy: boolean;
  onAdd(): void;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-card/85 px-5 py-5 shadow-[0_18px_45px_rgba(40,34,26,0.05)] backdrop-blur-sm">
      <div className="pointer-events-none absolute inset-y-0 right-0 w-52 bg-[radial-gradient(circle_at_center,rgba(217,161,93,0.14),transparent_68%)]" aria-hidden="true" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-muted/70 text-foreground">
            <FolderGit2 className="size-4.5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.17em] text-muted-foreground">Managed repositories</p>
            <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-foreground">
              {loading ? "Loading workspaces…" : `${readyCount} ready · ${totalCount} registered`}
            </h2>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
              Registration state stays in SourceNerve. Removing a workspace never deletes the repository directory or its files.
            </p>
          </div>
        </div>
        <ActionButton disabled={busy} onClick={onAdd} className="shrink-0">
          <Plus className="size-4" aria-hidden="true" />
          Add workspace
        </ActionButton>
      </div>
    </section>
  );
}
