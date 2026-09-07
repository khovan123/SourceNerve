import { useEffect, useState, type ReactNode } from "react";
import {
  Cable,
  GitBranch,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  ShieldOff,
  UserRound,
} from "lucide-react";

import type {
  Auth0SessionView,
  GitProvider,
  ProviderAccountView,
  ProviderRepositorySummary,
  PublicMcpView,
} from "../../shared/desktop-api";
import {
  authLabel,
  authTone,
  fallbackProviderState,
  providerTone,
  publicMcpLabel,
  publicMcpTone,
  type RepositoryCheck,
} from "../connection-view-model";
import { ActionButton } from "./atoms/ActionButton";
import { StatusPill } from "./atoms/StatusPill";
import { InlineNotice } from "./molecules/InlineNotice";

const EMPTY_PUBLIC_MCP: PublicMcpView = { state: "not-enrolled", tunnelRunning: false };

export function ConnectionsScreen() {
  const [auth, setAuth] = useState<Auth0SessionView>({ status: "signed-out" });
  const [providers, setProviders] = useState<ProviderAccountView[]>([]);
  const [publicMcp, setPublicMcp] = useState<PublicMcpView>(EMPTY_PUBLIC_MCP);
  const [repositories, setRepositories] = useState<Partial<Record<GitProvider, ProviderRepositorySummary[]>>>({});
  const [repositoryChecks, setRepositoryChecks] = useState<Record<string, RepositoryCheck>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshState();
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (
        event.type === "state" &&
        (event.component === "auth" ||
          event.component === "git" ||
          event.component === "provider" ||
          event.component === "public-mcp")
      ) {
        void refreshState();
      }
    });
  }, []);

  async function refreshState(): Promise<void> {
    const [runtimeResult, authResult, providerResult, publicMcpResult] = await Promise.all([
      window.sourcenerveDesktop.getRuntimeInfo(),
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
      window.sourcenerveDesktop.getPublicMcpState(),
    ]);
    if (authResult.ok) setAuth(authResult.value);
    if (providerResult.ok) setProviders(providerResult.value);
    if (publicMcpResult.ok) setPublicMcp(publicMcpResult.value);

    if (!runtimeResult.ok) {
      setError(runtimeResult.error.message);
      return;
    }
    if (!runtimeResult.value.bootstrap.ready && runtimeResult.value.bootstrap.error) {
      setError(`Desktop bootstrap unavailable: ${runtimeResult.value.bootstrap.error}`);
      return;
    }
    if (!authResult.ok) {
      setError(authResult.error.message);
      return;
    }
    if (!providerResult.ok) {
      setError(providerResult.error.message);
      return;
    }
    if (!publicMcpResult.ok) {
      setError(publicMcpResult.error.message);
      return;
    }
    setError(null);
  }

  async function authAction(kind: "signin" | "refresh" | "logout"): Promise<void> {
    setBusy(`auth:${kind}`);
    setError(null);
    try {
      const result =
        kind === "signin"
          ? await window.sourcenerveDesktop.signInAuth0()
          : kind === "refresh"
            ? await window.sourcenerveDesktop.refreshAuth0()
            : await window.sourcenerveDesktop.logoutAuth0();
      if (result.ok) {
        setAuth(result.value);
        await refreshState();
      } else {
        const runtimeResult = await window.sourcenerveDesktop.getRuntimeInfo();
        if (
          runtimeResult.ok &&
          !runtimeResult.value.bootstrap.ready &&
          runtimeResult.value.bootstrap.error
        ) {
          setError(`Desktop bootstrap unavailable: ${runtimeResult.value.bootstrap.error}`);
        } else {
          setError(result.error.message);
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function providerAction(provider: GitProvider, action: "connect" | "repositories"): Promise<void> {
    setBusy(`${provider}:${action}`);
    setError(null);
    try {
      if (action === "connect") {
        const result = await window.sourcenerveDesktop.connectProvider(provider);
        if (result.ok) await refreshState();
        else setError(result.error.message);
      } else {
        const result = await window.sourcenerveDesktop.listProviderRepositories(provider);
        if (result.ok) setRepositories((current) => ({ ...current, [provider]: result.value }));
        else setError(result.error.message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function validateRepository(provider: GitProvider, repository: ProviderRepositorySummary): Promise<void> {
    const key = `${provider}:${repository.slug}`;
    setBusy(`${key}:validate`);
    setError(null);
    try {
      const result = await window.sourcenerveDesktop.validateProviderRepository(provider, repository.slug);
      if (result.ok) {
        setRepositoryChecks((current) => ({
          ...current,
          [key]: {
            ok: true,
            message: result.value.writable ? "Write access ready" : "Read access ready",
          },
        }));
      } else {
        setRepositoryChecks((current) => ({ ...current, [key]: { ok: false, message: result.error.message } }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function publicMcpAction(action: "enroll" | "retry" | "rotate" | "revoke" | "re-enroll"): Promise<void> {
    if (action === "revoke" && !window.confirm("Revoke this installation's Public MCP route? Local workspaces are not deleted.")) return;
    setBusy(`public-mcp:${action}`);
    setError(null);
    try {
      const result =
        action === "enroll"
          ? await window.sourcenerveDesktop.enrollPublicMcp()
          : action === "retry"
            ? await window.sourcenerveDesktop.retryPublicMcp()
            : action === "rotate"
              ? await window.sourcenerveDesktop.rotatePublicMcpCredential()
              : action === "revoke"
                ? await window.sourcenerveDesktop.revokePublicMcp()
                : await window.sourcenerveDesktop.reEnrollPublicMcp();
      if (result.ok) setPublicMcp(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(null);
    }
  }

  const authenticated = auth.status === "authenticated" && Boolean(auth.identity);

  return (
    <section className="space-y-6" aria-label="Connections">
      <header>
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">Connections</h1>
        <p className="mt-1 text-xs text-muted-foreground">Accounts and services available to SourceNerve.</p>
      </header>

      {error ? (
        <InlineNotice tone="danger" title="Connection failed" role="alert">
          {error}
        </InlineNotice>
      ) : null}

      <ConnectionGroup title="Accounts">
        <ConnectionRow
          icon={<UserRound className="size-4" aria-hidden="true" />}
          title="SourceNerve"
          subtitle={authenticated
            ? auth.identity?.email ?? auth.identity?.name ?? "Connected"
            : "Not connected"}
          status={<StatusPill dot tone={authTone(auth.status)}>{authLabel(auth)}</StatusPill>}
          actions={authenticated ? (
            <>
              <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void authAction("refresh")}>
                <RefreshCw className={`size-3.5 ${busy === "auth:refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
                Refresh
              </ActionButton>
              <ActionButton variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void authAction("logout")}>
                <LogOut className="size-3.5" aria-hidden="true" />
                Sign out
              </ActionButton>
            </>
          ) : (
            <ActionButton size="sm" disabled={Boolean(busy) || auth.status === "signing-in"} onClick={() => void authAction("signin")}>
              <LogIn className="size-3.5" aria-hidden="true" />
              {busy === "auth:signin" || auth.status === "signing-in" ? "Connecting…" : "Connect"}
            </ActionButton>
          )}
        />

        {(["github", "gitlab"] as const).map((provider) => {
          const state = providers.find((item) => item.provider === provider) ?? fallbackProviderState(provider);
          return (
            <ProviderRow
              key={provider}
              provider={provider}
              state={state}
              repositories={repositories[provider] ?? []}
              repositoryChecks={repositoryChecks}
              busy={busy}
              onAction={(action) => void providerAction(provider, action)}
              onValidate={(repository) => void validateRepository(provider, repository)}
            />
          );
        })}
      </ConnectionGroup>

      <ConnectionGroup title="Remote access">
        <PublicMcpRow
          auth={auth}
          publicMcp={publicMcp}
          busy={busy}
          onAction={(action) => void publicMcpAction(action)}
        />
      </ConnectionGroup>
    </section>
  );
}

function ProviderRow({
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
  const connected = state.status === "connected";
  const providerBusy = busy?.startsWith(`${provider}:`) === true;
  const statusLabel = state.status === "connected"
    ? "Connected"
    : state.status === "awaiting-user"
      ? "Checking"
      : state.status === "error"
        ? "Needs attention"
        : "Not connected";

  return (
    <div>
      <ConnectionRow
        icon={<GitBranch className="size-4" aria-hidden="true" />}
        title={label}
        subtitle={connected ? state.login ?? state.name ?? "Connected" : "Not connected"}
        status={<StatusPill dot tone={providerTone(state.status)}>{statusLabel}</StatusPill>}
        actions={
          <>
            {connected ? (
              <ActionButton variant="ghost" size="sm" disabled={providerBusy} onClick={() => onAction("repositories")}>
                <SearchCheck className="size-3.5" aria-hidden="true" />
                {busy === `${provider}:repositories` ? "Loading…" : "Repositories"}
              </ActionButton>
            ) : null}
            <ActionButton variant={connected ? "ghost" : "secondary"} size="sm" disabled={providerBusy} onClick={() => onAction("connect")}>
              <RefreshCw className={`size-3.5 ${busy === `${provider}:connect` ? "animate-spin" : ""}`} aria-hidden="true" />
              {busy === `${provider}:connect` ? "Checking…" : connected ? "Refresh" : "Connect"}
            </ActionButton>
          </>
        }
      />

      {state.error ? <p className="-mt-2 px-4 pb-3 pl-[58px] text-[11px] text-danger" role="alert">{state.error}</p> : null}

      {repositories.length > 0 ? (
        <div className="mx-4 mb-4 ml-[58px] max-h-64 overflow-auto rounded-[10px] border border-border bg-background/45">
          {repositories.slice(0, 100).map((repository, index) => {
            const checkKey = `${provider}:${repository.slug}`;
            const check = repositoryChecks[checkKey];
            const validating = busy === `${checkKey}:validate`;
            return (
              <div key={repository.slug} className={`flex items-center gap-3 px-3 py-2.5 ${index > 0 ? "border-t border-border/70" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-foreground">{repository.slug}</p>
                  {check ? <p className={`mt-0.5 truncate text-[10px] ${check.ok ? "text-muted-foreground" : "text-danger"}`}>{check.message}</p> : null}
                </div>
                <StatusPill tone={repository.writable ? "ready" : "neutral"}>{repository.writable ? "Write" : "Read"}</StatusPill>
                <ActionButton variant="ghost" size="sm" disabled={providerBusy} onClick={() => onValidate(repository)}>
                  {validating ? "Checking…" : "Check"}
                </ActionButton>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function PublicMcpRow({
  auth,
  publicMcp,
  busy,
  onAction,
}: {
  auth: Auth0SessionView;
  publicMcp: PublicMcpView;
  busy: string | null;
  onAction(action: "enroll" | "retry" | "rotate" | "revoke" | "re-enroll"): void;
}) {
  const authReady = auth.status === "authenticated";
  const publicUrl = publicMcp.publicMcpUrl ?? (publicMcp.hostname ? `https://${publicMcp.hostname}/mcp` : null);
  const disabled = Boolean(busy) || !authReady;

  return (
    <ConnectionRow
      icon={<Cable className="size-4" aria-hidden="true" />}
      title="Public MCP"
      subtitle={publicUrl ?? "Not configured"}
      status={<StatusPill dot tone={publicMcpTone(publicMcp)}>{publicMcpLabel(publicMcp)}</StatusPill>}
      actions={publicMcp.state === "not-enrolled" ? (
        <ActionButton size="sm" disabled={disabled} onClick={() => onAction("enroll")}>
          <Cable className="size-3.5" aria-hidden="true" />
          {busy === "public-mcp:enroll" ? "Connecting…" : "Connect"}
        </ActionButton>
      ) : publicMcp.state === "revoked" ? (
        <ActionButton size="sm" disabled={disabled} onClick={() => onAction("re-enroll")}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {busy === "public-mcp:re-enroll" ? "Connecting…" : "Reconnect"}
        </ActionButton>
      ) : (
        <>
          <ActionButton variant="ghost" size="sm" disabled={disabled} onClick={() => onAction("retry")}>
            <RefreshCw className={`size-3.5 ${busy === "public-mcp:retry" ? "animate-spin" : ""}`} aria-hidden="true" />
            Check
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={disabled} onClick={() => onAction("rotate")}>
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Rotate
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={disabled} onClick={() => onAction("revoke")} className="text-danger hover:text-danger">
            <ShieldOff className="size-3.5" aria-hidden="true" />
            Revoke
          </ActionButton>
        </>
      )}
    />
  );
}

function ConnectionGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 px-1 text-[11px] font-semibold text-muted-foreground">{title}</h2>
      <div className="overflow-hidden rounded-[12px] border border-border bg-card shadow-[0_1px_2px_var(--sn-shadow)] divide-y divide-border/80">
        {children}
      </div>
    </section>
  );
}

function ConnectionRow({
  icon,
  title,
  subtitle,
  status,
  actions,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex min-h-[68px] items-center gap-3 px-4 py-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-muted/60 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-[13px] font-medium text-foreground">{title}</p>
          {status}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={subtitle}>{subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{actions}</div>
    </div>
  );
}
