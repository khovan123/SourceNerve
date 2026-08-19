import { useEffect, useState } from "react";

import type { Auth0SessionView } from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge, type StatusTone } from "./StatusBadge";

export function ConnectionsScreen() {
  const [auth, setAuth] = useState<Auth0SessionView>({ status: "signed-out" });
  const [busy, setBusy] = useState<"signin" | "refresh" | "logout" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshState();
    return window.sourcenerveDesktop.subscribeRuntimeEvents((event) => {
      if (event.type === "state" && event.component === "auth") void refreshState();
    });
  }, []);

  async function refreshState(): Promise<void> {
    const result = await window.sourcenerveDesktop.getAuth0State();
    if (result.ok) {
      setAuth(result.value);
      setError(null);
    } else {
      setError(result.error.message);
    }
  }

  async function action(kind: "signin" | "refresh" | "logout"): Promise<void> {
    setBusy(kind);
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
                <div>
                  <dt>Account</dt>
                  <dd>{auth.identity.name ?? auth.identity.email ?? "SourceNerve user"}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{auth.identity.email ?? "—"}</dd>
                </div>
                <div>
                  <dt>Subject</dt>
                  <dd title={auth.identity.subject}>{auth.identity.subject}</dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>{auth.expiresAt ? formatExpiry(auth.expiresAt) : "—"}</dd>
                </div>
              </dl>

              <div className="connection-grants">
                <strong>Effective local workspace grants</strong>
                {auth.workspaceGrants && auth.workspaceGrants.length > 0 ? (
                  <ul className="feature-list">
                    {auth.workspaceGrants.map((grant) => (
                      <li key={grant.workspace}>
                        <span>{grant.workspace}</span>
                        <StatusBadge label={grant.access} tone="neutral" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No validated local workspace is granted to this account yet.</p>
                )}
              </div>

              <div className="onboarding-actions">
                <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void action("refresh")}>
                  {busy === "refresh" ? "Refreshing…" : "Refresh session"}
                </button>
                <button className="button button--quiet" type="button" disabled={Boolean(busy)} onClick={() => void action("logout")}>
                  {busy === "logout" ? "Signing out…" : "Sign out"}
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
                <button className="button" type="button" disabled={Boolean(busy) || auth.status === "signing-in"} onClick={() => void action("signin")}>
                  {busy === "signin" || auth.status === "signing-in" ? "Waiting for browser sign-in…" : "Sign in to SourceNerve"}
                </button>
              </div>
            </>
          )}
        </Panel>

        <Panel title="Git Provider" eyebrow="GitHub / GitLab">
          <div className="connection-heading">
            <StatusBadge label="Not connected" tone="neutral" />
            <span>Repository-provider identity</span>
          </div>
          <p className="muted">
            GitHub/GitLab login is separate from the SourceNerve account. Provider browser/device
            login and repository discovery are implemented by #64; no Auth0 credential is reused as
            a Git provider token.
          </p>
        </Panel>
      </div>
    </section>
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

function formatExpiry(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
