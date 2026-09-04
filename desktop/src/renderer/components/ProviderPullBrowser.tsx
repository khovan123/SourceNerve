import { useEffect, useMemo, useRef, useState } from "react";

import type { ManagedWorkspaceView } from "../../shared/desktop-api";
import type {
  ProviderPullListItem,
  ProviderPullListState,
} from "../../shared/provider-workflow-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";

const PULL_LIMIT = 100;

type WorkspacePulls = Record<string, ProviderPullListItem[]>;
type WorkspaceErrors = Record<string, string>;

export function ProviderPullBrowser() {
  const [workspaces, setWorkspaces] = useState<ManagedWorkspaceView[]>([]);
  const [state, setState] = useState<ProviderPullListState>("open");
  const [pullsByWorkspace, setPullsByWorkspace] = useState<WorkspacePulls>({});
  const [workspaceErrors, setWorkspaceErrors] = useState<WorkspaceErrors>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const refreshSequence = useRef(0);

  useEffect(() => {
    void loadWorkspaces();
  }, []);

  useEffect(() => {
    if (workspaces.length === 0) {
      setPullsByWorkspace({});
      setWorkspaceErrors({});
      return;
    }
    void refreshPulls(workspaces, state);
  }, [workspaces, state]);

  const totalPulls = useMemo(
    () => workspaces.reduce((total, workspace) => total + (pullsByWorkspace[workspace.id]?.length ?? 0), 0),
    [pullsByWorkspace, workspaces],
  );
  const failedWorkspaceCount = useMemo(
    () => workspaces.reduce((total, workspace) => total + (workspaceErrors[workspace.id] ? 1 : 0), 0),
    [workspaceErrors, workspaces],
  );

  async function loadWorkspaces(): Promise<void> {
    setError(null);
    const result = await window.sourcenerveDesktop.listManagedWorkspaces();
    if (!result.ok) {
      setWorkspaces([]);
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
  }

  async function refreshPulls(
    targetWorkspaces = workspaces,
    targetState = state,
  ): Promise<void> {
    if (targetWorkspaces.length === 0) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError(null);

    const results = await Promise.all(
      targetWorkspaces.map(async (workspace) => {
        try {
          const result = await window.sourcenerveDesktop.listProviderPulls({
            workspace: workspace.id,
            state: targetState,
            limit: PULL_LIMIT,
          });
          return result.ok
            ? { workspaceId: workspace.id, pulls: result.value, error: null }
            : { workspaceId: workspace.id, pulls: [], error: result.error.message };
        } catch (refreshError) {
          return {
            workspaceId: workspace.id,
            pulls: [],
            error: refreshError instanceof Error && refreshError.message
              ? refreshError.message
              : "Provider pull requests could not be loaded.",
          };
        }
      }),
    );

    if (sequence !== refreshSequence.current) return;

    const nextPulls: WorkspacePulls = {};
    const nextErrors: WorkspaceErrors = {};
    for (const result of results) {
      nextPulls[result.workspaceId] = result.pulls;
      if (result.error) nextErrors[result.workspaceId] = result.error;
    }
    setPullsByWorkspace(nextPulls);
    setWorkspaceErrors(nextErrors);
    setLoading(false);
  }

  async function openPull(pull: ProviderPullListItem): Promise<void> {
    if (!pull.url) return;
    const pullKey = `${pull.provider}:${pull.repository}:${pull.number}`;
    setOpening(pullKey);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.openProviderPull({ url: pull.url });
      if (!result.ok) setError(result.error.message);
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <ActionButton
          size="sm"
          variant="secondary"
          disabled={workspaces.length === 0 || loading}
          onClick={() => void refreshPulls()}
        >
          {loading ? "Refreshing…" : "Refresh all"}
        </ActionButton>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            {workspaces.length} {workspaces.length === 1 ? "repository" : "repositories"} · {totalPulls} {state === "all" ? "pull requests" : `${state} pull requests`}
          </p>
          <p className="mt-1 text-[11px]">
            Showing up to {PULL_LIMIT} pull requests per repository
            {failedWorkspaceCount > 0 ? ` · ${failedWorkspaceCount} failed to load` : ""}.
          </p>
        </div>

        <label className="w-full space-y-1.5 text-xs text-muted-foreground sm:w-[200px]">
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

      {workspaces.length > 0 ? (
        <div className="mt-4 space-y-4">
          {workspaces.map((workspace) => {
            const pulls = pullsByWorkspace[workspace.id] ?? [];
            const workspaceError = workspaceErrors[workspace.id];
            return (
              <section
                key={workspace.id}
                className="overflow-hidden rounded-2xl border border-border/70 bg-card/40"
                aria-label={`${workspace.repository ?? workspace.id} pull requests`}
              >
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {workspace.repository ?? workspace.id}
                      </h3>
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {workspace.provider === "github" ? "GitHub" : "GitLab"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Workspace {workspace.id} · default {workspace.defaultBranch}
                    </p>
                  </div>
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                    {pulls.length} {state === "all" ? "PRs" : state}
                  </span>
                </header>

                <div className="p-3">
                  {workspaceError ? (
                    <InlineNotice tone="danger" title="Repository unavailable" role="alert">
                      {workspaceError}
                    </InlineNotice>
                  ) : null}

                  {!workspaceError && pulls.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground">
                      {loading ? "Loading pull requests…" : `No ${state === "all" ? "" : `${state} `}pull requests found.`}
                    </div>
                  ) : null}

                  {pulls.length > 0 ? (
                    <div className="space-y-2">
                      {pulls.map((pull) => {
                        const pullKey = `${pull.provider}:${pull.repository}:${pull.number}`;
                        return (
                          <article
                            key={pullKey}
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
                              </div>
                              {pull.url ? (
                                <ActionButton
                                  size="sm"
                                  variant="secondary"
                                  disabled={opening === pullKey}
                                  onClick={() => void openPull(pull)}
                                >
                                  {opening === pullKey ? "Opening…" : "Open in provider"}
                                </ActionButton>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
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


function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
