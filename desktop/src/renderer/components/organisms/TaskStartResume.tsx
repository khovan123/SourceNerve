import type { ReactNode } from "react";
import { History, LoaderCircle, Play } from "lucide-react";

import type { ManagedWorkspaceView } from "../../../shared/desktop-api";
import type { DesktopTaskListItem } from "../../../shared/task-api";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { EmptyState } from "../molecules/EmptyState";
import { SurfaceCard } from "../molecules/SurfaceCard";
import { TaskWorkspaceReadiness } from "../molecules/TaskWorkspaceReadiness";

const controlClass = "w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export function TaskStartResume({
  workspaces,
  eligibleWorkspaces,
  tasks,
  selectedTaskId,
  newWorkspace,
  contextQuery,
  contextMaxBytes,
  contextMaxItems,
  openTaskId,
  busy,
  preparingWorkspaceId,
  onWorkspace,
  onContextQuery,
  onContextMaxBytes,
  onContextMaxItems,
  onOpenTaskId,
  onBegin,
  onRemember,
  onSelectTask,
  onPrepareWorkspace,
  onRefreshReadiness,
  onOpenWorkspaces,
}: {
  workspaces: ManagedWorkspaceView[];
  eligibleWorkspaces: ManagedWorkspaceView[];
  tasks: DesktopTaskListItem[];
  selectedTaskId?: string;
  newWorkspace: string;
  contextQuery: string;
  contextMaxBytes: number;
  contextMaxItems: number;
  openTaskId: string;
  busy: string | null;
  preparingWorkspaceId: string | null;
  onWorkspace(value: string): void;
  onContextQuery(value: string): void;
  onContextMaxBytes(value: number): void;
  onContextMaxItems(value: number): void;
  onOpenTaskId(value: string): void;
  onBegin(): void;
  onRemember(): void;
  onSelectTask(taskId: string): void;
  onPrepareWorkspace(workspaceId: string): void;
  onRefreshReadiness(): void;
  onOpenWorkspaces(): void;
}) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <SurfaceCard title="Start a task" eyebrow="Snapshot current HEAD + graph">
        {eligibleWorkspaces.length === 0 ? (
          <div className="space-y-4">
            <EmptyState
              compact
              title="No workspace is ready for a new guarded task."
              description="A new task requires a ready, clean, current-index, read-write workspace on its default branch."
            />
            <TaskWorkspaceReadiness
              workspaces={workspaces}
              busy={busy}
              preparingWorkspaceId={preparingWorkspaceId}
              onPrepare={onPrepareWorkspace}
              onRefresh={onRefreshReadiness}
              onOpenWorkspaces={onOpenWorkspaces}
            />
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
            <div className="flex justify-start">
              <ActionButton size="md" disabled={busy === "begin" || !newWorkspace} aria-busy={busy === "begin"} onClick={onBegin}>
                {busy === "begin" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                {busy === "begin" ? "Starting…" : "Start durable task"}
              </ActionButton>
            </div>
          </div>
        )}
      </SurfaceCard>

      <SurfaceCard title="Resume tasks" eyebrow="Rust state is authoritative" actions={<StatusPill tone="neutral">{tasks.length} remembered</StatusPill>}>
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field label="Task UUID">
              <input className={`${controlClass} h-10`} value={openTaskId} maxLength={128} onChange={(event) => onOpenTaskId(event.target.value)} placeholder="Existing task UUID" />
            </Field>
            <ActionButton variant="secondary" size="md" disabled={busy === "remember" || !openTaskId.trim()} aria-busy={busy === "remember"} onClick={onRemember}>
              {busy === "remember" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <History className="size-4" aria-hidden="true" />}
              {busy === "remember" ? "Opening…" : "Open existing"}
            </ActionButton>
          </div>
          <div className="max-h-80 space-y-2 overflow-auto pr-1">
            {tasks.map((item) => {
              const active = selectedTaskId === item.taskId;
              return (
                <button
                  className={`w-full rounded-xl border px-3 py-3 text-left no-underline outline-none transition focus-visible:ring-2 focus-visible:ring-primary/25 ${active ? "border-primary/35 bg-primary/7 shadow-sm" : "border-border bg-muted/20 hover:bg-muted/45"}`}
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
            {tasks.length === 0 ? <EmptyState compact title="No durable tasks remembered by Desktop yet." description="Prepare a workspace and start a task on the left, or open an existing task UUID." /> : null}
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 content-start gap-1.5"><span className="text-xs font-medium text-muted-foreground">{label}</span>{children}</label>;
}
