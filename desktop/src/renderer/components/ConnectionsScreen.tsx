import { useEffect, useState } from "react";

import type {
  Auth0SessionView,
  GitProvider,
  ProviderAccountView,
  ProviderRepositorySummary,
} from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge, type StatusTone } from "./StatusBadge";

export function ConnectionsScreen() {
  const [auth, setAuth] = useState<Auth0SessionView>({ status: "signed-out" });
  const [providers, setProviders] = useState<ProviderAccountView[]>([]);
  const [repositories, setRepositories] = useState<Partial<Record<GitProvider, ProviderRepositorySummary[]>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshState();
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state" && (event.component === "auth" || event.component === "git" || event.component === "provider")) {
        void refreshState();
      }
    });
  }, []);

  async function refreshState(): Promise<void> {
    const [authResult, providerResult] = await Promise.all([
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
    ]);
    if (authResult.ok) setAuth(authResult.value);
    else setError(authResult.error.message);
    if (providerResult.ok) setProviders(providerResult.value);
    else setError(providerResult.error.message);
    if (authResult.ok && providerResult.ok) setError(null);
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
      if (result.ok) setAuth(result.value);
      else setError(result.error.message);
    } finally {
      setBusy(null);
    }
  }

  async function providerAction(provider: GitProvider, action: "connect" | "disconnect" | "repositories"): Promise<void> {
    setBusy(`${provider}:${action}`);
    setError(null);
    try {
      if (action === "connect") {
        const result = await window.sourcenerveDesktop.connectProvider(provider);
        if (result.ok) await refreshState();
        else setError(result.error.message);
      } else if (action === "disconnect") {
        const result = await window.sourcenerveDesktop.disconnectProvider(provider);
        if (result.ok) {
          setRepositories((current) => ({ ...current, [provider]: undefined }));
          await refreshState();
        } else setError(result.error.message);
      } else {
        const result = await window.sourcenerveDesktop.listProviderRepositories(provider);
        if (result.ok) setRepositories((current) => ({ ...current, [provider]: result.value }));
        else setError(result.error.message);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="connections-screen" aria-labelledby="connections-title">
      <div className="connections-screen__header">
        <div>
          <p className="eyebrow">Identity & repository access</p>
          <h1 id="connections-title">Connections</h1>
          <p>
            SourceNerve account identity and Git provider identity are independent. Tokens stay in
            OS-backed secure storage and are never shown in the renderer.
          </p>
        </div>
      </div>

      {error ? <div className="workspace-alert" role="alert">{error}</div> : null}

      <div className="connections-grid">
        <Panel title="SourceNerve Account" eyebrow="Auth0">
          <div className="connection-heading">
            <StatusBadge label={authLabel(auth)} tone={authTone(auth.status)} />
            <span>Authorization Code + PKCE · system browser</span>
          </div>

          {auth.status === "authenticated" && auth.identity ? (
            <>
              <dl className="workspace-facts connection-facts">
                <div><dt>Account</dt><dd>{auth.identity.name ?? auth.identity.email ?? "SourceNerve user"}</dd></div>
                <div><dt>Email</dt><dd>{auth.identity.email ?? "—"}</dd></div>
                <div><dt>Subject</dt><dd title={auth.identity.subject}>{auth.identity.subject}</dd></div>
                <div><dt>Session</dt><dd>{auth.expiresAt ? formatExpiry(auth.expiresAt) : "—"}</dd></div>
              </dl>
              <div className="connection-grants">
                <strong>Effective local workspace grants</strong>
                {auth.workspaceGrants && auth.workspaceGrants.length > 0 ? (
                  <ul className="feature-list">
                    {auth.workspaceGrants.map((grant) => (
                      <li key={grant.workspace}><span>{grant.workspace}</span><StatusBadge label={grant.access} tone="neutral" /></li>
                    ))}
                  </ul>
                ) : <p className="muted">No validated local workspace is granted to this account yet.</p>}
              </div>
              <div className="onboarding-actions">
                <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void authAction("refresh")}>
                  {busy === "auth:refresh" ? "Refreshing…" : "Refresh session"}
                </button>
                <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void authAction("logout")}>
                  {busy === "auth:logout" ? "Signing out…" : "Sign out"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                Sign in with the SourceNerve account issued by the operator. No access token,
                refresh token, tenant secret, or Management API credential is entered here.
              </p>
              {auth.error ? <p className="muted" role="alert">{auth.error}</p> : null}
              <div className="onboarding-actions">
                <button className="button" type="button" disabled={Boolean(busy) || auth.status === "signing-in"} onClick={() => void authAction("signin")}>
                  {busy === "auth:signin" || auth.status === "signing-in" ? "Waiting for browser sign-in…" : "Sign in to SourceNerve"}
                </button>
              </div>
            </>
          )}
        </Panel>

        {(["github", "gitlab"] as const).map((provider) => (
          <ProviderCard
            key={provider}
            provider={provider}
            state={providers.find((item) => item.provider === provider) ?? fallbackProviderState(provider)}
            repositories={repositories[provider] ?? []}
            busy={busy}
            onAction={(action) => void providerAction(provider, action)}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  state,
  repositories,
  busy,
  onAction,
}: {
  provider: GitProvider;
  state: ProviderAccountView;
  repositories: ProviderRepositorySummary[];
  busy: string | null;
  onAction(action: "connect" | "disconnect" | "repositories"): void;
}) {
  const label = provider === "github" ? "GitHub" : "GitLab";
  const providerBusy = busy?.startsWith(`${provider}:`) === true;
  return (
    <Panel title={label} eyebrow="Git provider">
      <div className="connection-heading">
        <StatusBadge label={providerStatusLabel(state.status)} tone={providerTone(state.status)} />
        <span>Device Authorization · system browser</span>
      </div>

      {state.status === "awaiting-user" && state.deviceLogin ? (
        <div className="device-login">
          <strong>Complete sign-in in your browser</strong>
          <span className="device-login__code">{state.deviceLogin.userCode}</span>
          <span>{state.deviceLogin.verificationUri}</span>
          <small>Code expires {formatExpiry(state.deviceLogin.expiresAt)}.</small>
        </div>
      ) : null}

      {state.status === "connected" ? (
        <>
          <dl className="workspace-facts connection-facts">
            <div><dt>Account</dt><dd>{state.name ?? state.login ?? "—"}</dd></div>
            <div><dt>Login</dt><dd>{state.login ?? "—"}</dd></div>
            <div><dt>API</dt><dd>{state.baseUrl}</dd></div>
            <div><dt>Connected</dt><dd>{state.connectedAt ? new Date(state.connectedAt).toLocaleString() : "—"}</dd></div>
          </dl>
          <div className="onboarding-actions">
            <button className="button" type="button" disabled={providerBusy} onClick={() => onAction("repositories")}>
              {busy === `${provider}:repositories` ? "Loading…" : "Discover repositories"}
            </button>
            <button className="button button--quiet" type="button" disabled={providerBusy} onClick={() => onAction("disconnect")}>
              {busy === `${provider}:disconnect` ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        </>
      ) : state.status !== "awaiting-user" ? (
        <>
          <p className="muted">
            Connect {label} without copying a personal access token. Provider identity remains independent from Auth0.
          </p>
          {state.error ? <p className="muted" role="alert">{state.error}</p> : null}
          <div className="onboarding-actions">
            <button className="button" type="button" disabled={providerBusy} onClick={() => onAction("connect")}>
              {busy === `${provider}:connect` ? "Starting…" : `Connect ${label}`}
            </button>
          </div>
        </>
      ) : null}

      {repositories.length > 0 ? (
        <div className="connection-repositories">
          <strong>Repositories</strong>
          <ul className="provider-repository-list">
            {repositories.slice(0, 100).map((repository) => (
              <li key={repository.slug}>
                <span>
                  <strong>{repository.slug}</strong>
                  <small>{repository.defaultBranch ?? "No default branch"} · {repository.private ? "Private" : "Public"}</small>
                </span>
                <StatusBadge label={repository.writable ? "Write" : "Read"} tone={repository.writable ? "ready" : "neutral"} />
              </li>
            ))}
          </ul>
          {repositories.length > 100 ? <p className="muted">Showing first 100 of {repositories.length} repositories.</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}

function authLabel(auth: Auth0SessionView): string {
  if (auth.status === "authenticated") return "Signed in";
  if (auth.status === "signing-in") return "Signing in";
  if (auth.status === "expired") return "Session expired";
  if (auth.status === "error") return "Needs attention";
  return "Signed out";
}

function authTone(status: Auth0SessionView["status"]): StatusTone {
  if (status === "authenticated") return "ready";
  if (status === "signing-in") return "working";
  if (status === "expired" || status === "error") return "warning";
  return "neutral";
}

function providerStatusLabel(status: ProviderAccountView["status"]): string {
  if (status === "connected") return "Connected";
  if (status === "awaiting-user") return "Waiting for sign-in";
  if (status === "error") return "Needs attention";
  return "Not connected";
}

function providerTone(status: ProviderAccountView["status"]): StatusTone {
  if (status === "connected") return "ready";
  if (status === "awaiting-user") return "working";
  if (status === "error") return "warning";
  return "neutral";
}

function fallbackProviderState(provider: GitProvider): ProviderAccountView {
  return {
    provider,
    status: "disconnected",
    baseUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4",
  };
}

function formatExpiry(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
