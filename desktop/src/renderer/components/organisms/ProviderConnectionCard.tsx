import { GitBranch, RefreshCw, SearchCheck, TerminalSquare } from "lucide-react";

import type { GitProvider, ProviderAccountView, ProviderRepositorySummary } from "../../../shared/desktop-api";
import { providerStatusLabel, providerTone, type RepositoryCheck } from "../../connection-view-model";
import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function ProviderConnectionCard({
  provider,
  state,
  repositories,
  repositoryChecks,
  busy,
  onAction,
  onValidate,
}: {
  provider: GitProvider;
  state: ProviderAccountView;
  repositories: ProviderRepositorySummary[];
  repositoryChecks: Record<string, RepositoryCheck>;
  busy: string | null;
  onAction(action: "connect" | "repositories"): void;
  onValidate(repository: ProviderRepositorySummary): void;
}) {
  const label = provider === "github" ? "GitHub" : "GitLab";
  const cli = provider === "github" ? "gh" : "glab";
  const loginCommand = provider === "github"
    ? "gh auth login --hostname github.com"
    : "glab auth login --hostname gitlab.com";
  const providerBusy = busy?.startsWith(`${provider}:`) === true;

  return (
    <SurfaceCard
      title={label}
      description={`Uses the ${cli} CLI session already installed on this computer.`}
      actions={<StatusPill dot tone={providerTone(state.status)}>{providerStatusLabel(state.status)}</StatusPill>}
      className="xl:col-span-1"
    >
      <div className="space-y-4">
        {state.status === "connected" ? (
          <>
            <div className="flex items-center gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/35 text-muted-foreground">
                <GitBranch className="size-4" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{state.name ?? state.login ?? `${label} account`}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{state.login ?? "CLI authenticated"}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
              <ActionButton size="sm" disabled={providerBusy} onClick={() => onAction("repositories")}>
                <SearchCheck className="size-3.5" aria-hidden="true" />
                {busy === `${provider}:repositories` ? "Loading…" : "Find repositories"}
              </ActionButton>
              <ActionButton variant="secondary" size="sm" disabled={providerBusy} onClick={() => onAction("connect")}>
                <RefreshCw className={`size-3.5 ${busy === `${provider}:connect` ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === `${provider}:connect` ? "Checking…" : "Refresh status"}
              </ActionButton>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted-foreground">Sign in with the provider CLI, then let SourceNerve detect the session.</p>
            <div className="space-y-2 rounded-xl border border-border bg-[#11100e] p-3 font-mono text-[11px] leading-5 text-[#f2eadf] dark:bg-black/40">
              <div className="flex items-center gap-2 text-[#b9aa96]"><TerminalSquare className="size-3.5" aria-hidden="true" /> Terminal</div>
              <code>{loginCommand}</code>
              {provider === "github" ? <code>gh auth setup-git --hostname github.com</code> : null}
            </div>
            {state.error ? <p className="text-xs leading-5 text-danger" role="alert">{state.error}</p> : null}
            <ActionButton size="sm" disabled={providerBusy} onClick={() => onAction("connect")}>
              <RefreshCw className={`size-3.5 ${busy === `${provider}:connect` ? "animate-spin" : ""}`} aria-hidden="true" />
              {busy === `${provider}:connect` ? "Checking…" : `Detect ${cli} session`}
            </ActionButton>
          </>
        )}

        {repositories.length > 0 ? (
          <div className="border-t border-border/70 pt-4">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Repositories</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Validate access before provider workflows.</p>
              </div>
              <StatusPill tone="neutral">{repositories.length}</StatusPill>
            </div>
            <div className="max-h-80 space-y-2 overflow-auto pr-1">
              {repositories.slice(0, 100).map((repository) => {
                const checkKey = `${provider}:${repository.slug}`;
                const check = repositoryChecks[checkKey];
                const validating = busy === `${checkKey}:validate`;
                return (
                  <article key={repository.slug} className="rounded-xl border border-border bg-muted/20 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="break-all text-xs font-semibold text-foreground">{repository.slug}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{repository.defaultBranch ?? "No default branch"} · {repository.private ? "Private" : "Public"}</p>
                        {check ? <p className={`mt-2 text-[11px] leading-5 ${check.ok ? "text-muted-foreground" : "text-danger"}`} role={check.ok ? undefined : "alert"}>{check.message}</p> : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <StatusPill tone={repository.writable ? "ready" : "neutral"}>{repository.writable ? "Write" : "Read"}</StatusPill>
                        <ActionButton variant="ghost" size="sm" disabled={providerBusy} onClick={() => onValidate(repository)}>
                          <SearchCheck className="size-3.5" aria-hidden="true" />
                          {validating ? "Validating…" : "Validate"}
                        </ActionButton>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            {repositories.length > 100 ? <p className="mt-2 text-[11px] text-muted-foreground">Showing first 100 of {repositories.length} repositories.</p> : null}
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}
