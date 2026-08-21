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
  const logoutCommand = provider === "github"
    ? "gh auth logout --hostname github.com"
    : "glab auth logout --hostname gitlab.com";
  const providerBusy = busy?.startsWith(`${provider}:`) === true;

  return (
    <SurfaceCard
      title={label}
      eyebrow="Git provider"
      actions={<StatusPill dot tone={providerTone(state.status)}>{providerStatusLabel(state.status)}</StatusPill>}
      className="xl:col-span-1"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/35 p-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
            <GitBranch className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{cli} CLI · externally managed session</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">SourceNerve detects the installed CLI session and never owns a provider OAuth client or persists the provider login token.</p>
          </div>
        </div>

        {state.status === "connected" ? (
          <>
            <dl className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
              <Fact label="Account" value={state.name ?? state.login ?? "—"} />
              <Fact label="Login" value={state.login ?? "—"} />
              <Fact label="API" value={state.baseUrl} mono />
              <Fact label="Detected" value={state.connectedAt ? new Date(state.connectedAt).toLocaleString() : "—"} />
            </dl>
            <p className="rounded-xl border border-border bg-muted/25 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">{logoutCommand}</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton size="sm" disabled={providerBusy} onClick={() => onAction("repositories")}>
                <SearchCheck className="size-3.5" aria-hidden="true" />
                {busy === `${provider}:repositories` ? "Loading…" : "Discover repositories"}
              </ActionButton>
              <ActionButton variant="secondary" size="sm" disabled={providerBusy} onClick={() => onAction("connect")}>
                <RefreshCw className={`size-3.5 ${busy === `${provider}:connect` ? "animate-spin" : ""}`} aria-hidden="true" />
                {busy === `${provider}:connect` ? "Checking…" : "Refresh CLI status"}
              </ActionButton>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted-foreground">Authenticate outside SourceNerve in a terminal, then detect that CLI session here.</p>
            <div className="space-y-2 rounded-xl border border-border bg-[#11100e] p-3 font-mono text-[11px] leading-5 text-[#f2eadf] dark:bg-black/40">
              <div className="flex items-center gap-2 text-[#b9aa96]"><TerminalSquare className="size-3.5" aria-hidden="true" /> Terminal</div>
              <code>{loginCommand}</code>
              {provider === "github" ? <code>gh auth setup-git --hostname github.com</code> : null}
            </div>
            {state.error ? <p className="rounded-xl border border-danger/20 bg-danger/5 px-3 py-2 text-xs leading-5 text-danger" role="alert">{state.error}</p> : null}
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
                <p className="mt-1 text-[11px] text-muted-foreground">Validate provider API access before Issue/PR workflows. Git push auth remains a Workspace check.</p>
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
                        {check ? <StatusPill tone={check.ok ? "ready" : "warning"}>{check.ok ? "API valid" : "Check failed"}</StatusPill> : null}
                        <ActionButton variant="ghost" size="sm" disabled={providerBusy} onClick={() => onValidate(repository)}>
                          {validating ? "Validating…" : "Validate access"}
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

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-all text-xs text-foreground ${mono ? "font-mono" : ""}`} title={value}>{value}</dd>
    </div>
  );
}
