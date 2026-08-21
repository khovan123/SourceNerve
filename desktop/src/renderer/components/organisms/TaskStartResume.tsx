import { FolderPlus, History, Play } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import type { DesktopTaskListItem } from "../../../shared/task-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

const controlClass = "w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export function TaskStartResume({
  eligibleWorkspaces,
  tasks,
  selectedTaskId,
  newWorkspace,
  contextQuery,
  contextMaxBytes,
  contextMaxItems,
  openTaskId,
  busy,
  onWorkspace,
  onContextQuery,
  onContextMaxBytes,
  onContextMaxItems,
  onOpenTaskId,
  onBegin,
  onRemember,
  onSelectTask,
}: {
  eligibleWorkspaces: ManagedWorkspaceView[];
  tasks: DesktopTaskListItem[];
  selectedTaskId?: string;
  newWorkspace: string;
  contextQuery: string;
  contextMaxBytes: number;
  contextMaxItems: number;
  openTaskId: string;
  busy: string | null;
  onWorkspace(value: string): void;
  onContextQuery(value: string): void;
  onContextMaxBytes(value: number): void;
  onContextMaxItems(value: number): void;
  onOpenTaskId(value: string): void;
  onBegin(): void;
  onRemember(): void;
  onSelectTask(taskId: string): void;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <SurfaceCard title="Start a task" eyebrow="Snapshot current HEAD + graph">
        {eligibleWorkspaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-7 text-center">
            <FolderPlus className="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 text-sm text-foreground">No workspace is eligible for a new guarded task.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Requires a ready, clean, current-index, read-write workspace on its default branch.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="Workspace">
              <select className={`${controlClass} h-10`} value={newWorkspace} onChange={(event) => onWorkspace(event.target.value)}>
                {eligibleWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.id}</option>)}
              </select>
            </Field>
            <Field label="Context question (optional)">
              <textarea className={`${controlClass} min-h-24 py-3`} value={contextQuery} maxLength={4096} rows={3} onChange={(event) => onContextQuery(event.target.value)} placeholder="What code should be changed and why?" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Context budget">
                <select className={`${controlClass} h-10`} value={contextMaxBytes} onChange={(event) => onContextMaxBytes(Number(event.target.value))}>
                  <option value={16 * 1024}>16 KiB</option><option value={32 * 1024}>32 KiB</option><option value={64 * 1024}>64 KiB</option><option value={128 * 1024}>128 KiB</option>
                </select>
              </Field>
              <Field label="Max items">
                <select className={`${controlClass} h-10`} value={contextMaxItems} onChange={(event) => onContextMaxItems(Number(event.target.value))}>
                  <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
                </select>
              </Field>
            </div>
            <ActionButton size="sm" disabled={busy === "begin" || !newWorkspace} onClick={onBegin}>
              <Play className="size-3.5" aria-hidden="true" />
              {busy === "begin" ? "Starting…" : "Start durable task"}
            </ActionButton>
          </div>
        )}
      </SurfaceCard>

      <SurfaceCard title="Resume tasks" eyebrow="Rust state is authoritative" actions={<StatusPill tone="neutral">{tasks.length} remembered</StatusPill>}>
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className={`${controlClass} h-10 flex-1`} value={openTaskId} maxLength={128} onChange={(event) => onOpenTaskId(event.target.value)} placeholder="Existing task UUID" />
            <ActionButton variant="secondary" size="sm" disabled={busy === "remember" || !openTaskId.trim()} onClick={onRemember}>
              <History className="size-3.5" aria-hidden="true" />
              {busy === "remember" ? "Opening…" : "Open existing"}
            </ActionButton>
          </div>
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
            {tasks.map((item) => {
              const active = selectedTaskId === item.taskId;
              return (
                <button
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${active ? "border-primary/35 bg-primary/7 shadow-sm" : "border-border bg-muted/20 hover:bg-muted/45"}`}
                  type="button"
                  key={item.taskId}
                  onClick={() => onSelectTask(item.taskId)}
                >
                  <strong className="block break-words text-xs text-foreground">{item.snapshot?.task.contextQuery || item.taskId}</strong>
                  <span className="mt-1 block text-[11px] text-muted-foreground">{item.workspace} · {item.snapshot ? `${item.snapshot.task.status}/${item.snapshot.lifecycle.phase}` : "unavailable"}</span>
                  {item.unavailableReason ? <span className="mt-1 block text-[11px] leading-5 text-warning">{item.unavailableReason}</span> : null}
                </button>
              );
            })}
            {tasks.length === 0 ? <p className="py-6 text-center text-xs text-muted-foreground">No durable tasks remembered by Desktop yet.</p> : null}
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">{label}</span>{children}</label>;
}
