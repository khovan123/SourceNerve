import { useEffect, useMemo, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  ProviderPullListItem,
  ProviderPullListState,
} from "../../shared/provider-workflow-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { Panel } from "./Panel";

const PULL_LIMIT = 100;

export function ProviderPullBrowser() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [state, setState] = useState<ProviderPullListState>("open");
  const [pulls, setPulls] = useState<ProviderPullListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  useEffect(() => {
    void loadWorkspaces();
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setPulls([]);
      return;
    }
    void refreshPulls(workspaceId, state);
  }, [workspaceId, state]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaces, workspaceId],
  );

  async function loadWorkspaces(): Promise<void> {
    setError(null);
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const providerWorkspaces = result.value.filter(
      (workspace) =>
        workspace.validation.state === "ready" &&
        Boolean(workspace.provider) &&
        Boolean(workspace.repository),
    );
    setWorkspaces(providerWorkspaces);
    setWorkspaceId((current) =>
      current && providerWorkspaces.some((workspace) => workspace.id === current)
        ? current
        : providerWorkspaces[0]?.id ?? "",
    );
  }

  async function refreshPulls(
    targetWorkspace = workspaceId,
    targetState = state,
  ): Promise<void> {
    if (!targetWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.listProviderPulls({
        workspace: targetWorkspace,
        state: targetState,
        limit: PULL_LIMIT,
      });
      if (!result.ok) {
        setPulls([]);
        setError(result.error.message);
        return;
      }
      setPulls(result.value);
    } catch (refreshError) {
      setPulls([]);
      setError(
        refreshError instanceof Error && refreshError.message
          ? refreshError.message
          : "Provider pull requests could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function openPull(pull: ProviderPullListItem): Promise<void> {
    if (!pull.url) return;
    setOpening(pull.number);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.openProviderPull({ url: pull.url });
      if (!result.ok) setError(result.error.message);
    } finally {
      setOpening(null);
    }
  }

  return (
    <Panel
      title="Repository pull requests"
      eyebrow="Provider browser"
      actions={
        <ActionButton
          size="sm"
          variant="secondary"
          disabled={!workspaceId || loading}
          onClick={() => void refreshPulls()}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </ActionButton>
      }
    >
      <p className="text-xs text-muted-foreground">
        Browse all GitHub pull requests or GitLab merge requests for a configured workspace,
        including changes created outside SourceNerve. Task-linked changes are marked below;
        task merge safeguards remain separate and unchanged.
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
        <label className="space-y-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Repository</span>
          <select
            aria-label="Pull request repository"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.length === 0 ? <option value="">No provider workspaces</option> : null}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.repository} · {workspace.provider === "github" ? "GitHub" : "GitLab"}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">State</span>
          <select
            aria-label="Pull request state filter"
            className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
            value={state}
            onChange={(event) => setState(event.target.value as ProviderPullListState)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed + merged</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      {selectedWorkspace ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {selectedWorkspace.id} · {selectedWorkspace.defaultBranch} · showing up to {PULL_LIMIT}
          {state === "all" ? " pull requests" : ` ${state} pull requests`}
        </p>
      ) : null}

      {error ? (
        <div className="mt-3">
          <InlineNotice tone="danger" title="Pull requests unavailable" role="alert">
            {error}
          </InlineNotice>
        </div>
      ) : null}

      {!error && workspaces.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
          Configure a GitHub or GitLab repository on a ready workspace to browse pull requests.
        </div>
      ) : null}

      {!error && workspaces.length > 0 && pulls.length === 0 ? (
        <div className="mt-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-5 text-sm text-muted-foreground">
          {loading ? "Loading provider pull requests…" : `No ${state === "all" ? "" : `${state} `}pull requests found.`}
        </div>
      ) : null}

      {pulls.length > 0 ? (
        <div className="mt-4 space-y-2">
          {pulls.map((pull) => (
            <article
              key={`${pull.provider}:${pull.repository}:${pull.number}`}
              className="rounded-xl border border-border/70 bg-muted/20 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <PullStateBadge pull={pull} />
                    {pull.draft ? (
                      <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
                        draft
                      </span>
                    ) : null}
                    <span className="text-xs font-semibold text-muted-foreground">#{pull.number}</span>
                    <span className="min-w-0 break-words text-sm font-semibold text-foreground">
                      {pull.title}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {pull.author ? `${pull.author} · ` : ""}
                    {pull.baseBranch} ← {pull.headBranch}
                    {pull.headSha ? ` · ${shortSha(pull.headSha)}` : ""}
                    {pull.updatedAt ? ` · updated ${formatTime(pull.updatedAt)}` : ""}
                  </p>
                  {pull.mergeState ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Provider merge state: {pull.mergeState}
                      {pull.mergeable === false ? " · not mergeable" : ""}
                    </p>
                  ) : null}
                  {pull.linkedTaskIds.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {pull.linkedTaskIds.map((taskId) => (
                        <span
                          key={taskId}
                          title={taskId}
                          className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] text-primary"
                        >
                          task {shortId(taskId)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">Not linked to a SourceNerve task.</p>
                  )}
                </div>
                {pull.url ? (
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    disabled={opening === pull.number}
                    onClick={() => void openPull(pull)}
                  >
                    {opening === pull.number ? "Opening…" : "Open in provider"}
                  </ActionButton>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function PullStateBadge({ pull }: { pull: ProviderPullListItem }) {
  const className = pull.state === "open"
    ? "text-success"
    : pull.state === "merged"
      ? "text-primary"
      : "text-muted-foreground";
  return (
    <span className={`rounded-full border border-border bg-card px-2 py-0.5 text-[10px] ${className}`}>
      {pull.state}
    </span>
  );
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
