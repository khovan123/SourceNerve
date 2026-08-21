import { useEffect, useState } from "react";

import type {
  Auth0SessionView,
  GitProvider,
  ProviderAccountView,
  ProviderRepositorySummary,
  PublicMcpView,
} from "../../shared/desktop-api";
import { fallbackProviderState, type RepositoryCheck } from "../connection-view-model";
import { ProviderConnectionCard } from "./organisms/ProviderConnectionCard";
import { PublicMcpConnectionCard } from "./organisms/PublicMcpConnectionCard";
import { SourceNerveAccountCard } from "./organisms/SourceNerveAccountCard";

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
    const [authResult, providerResult, publicMcpResult] = await Promise.all([
      window.sourcenerveDesktop.getAuth0State(),
      window.sourcenerveDesktop.getProviderStates(),
      window.sourcenerveDesktop.getPublicMcpState(),
    ]);
    if (authResult.ok) setAuth(authResult.value);
    else setError(authResult.error.message);
    if (providerResult.ok) setProviders(providerResult.value);
    else setError(providerResult.error.message);
    if (publicMcpResult.ok) setPublicMcp(publicMcpResult.value);
    else setError(publicMcpResult.error.message);
    if (authResult.ok && providerResult.ok && publicMcpResult.ok) setError(null);
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
      } else setError(result.error.message);
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
            message: result.value.writable
              ? "CLI-backed provider access is valid and this account can write to the repository."
              : "CLI-backed provider access is valid; repository access is read-only.",
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

  return (
    <section className="space-y-4" aria-label="Identity and repository connections">
      <div className="rounded-2xl border border-border bg-card/70 px-4 py-3 text-sm leading-6 text-muted-foreground shadow-[0_14px_36px_rgba(40,34,26,0.04)]">
        SourceNerve identity uses Auth0. GitHub and GitLab authentication stays owned by the installed <code className="text-xs text-foreground">gh</code>/<code className="text-xs text-foreground">glab</code> CLI sessions; provider tokens are never shown or persisted by the renderer.
      </div>

      {error ? <div className="rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">{error}</div> : null}

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <SourceNerveAccountCard auth={auth} busy={busy} onAction={(kind) => void authAction(kind)} />
        <PublicMcpConnectionCard auth={auth} publicMcp={publicMcp} busy={busy} onAction={(action) => void publicMcpAction(action)} />
        {(["github", "gitlab"] as const).map((provider) => (
          <ProviderConnectionCard
            key={provider}
            provider={provider}
            state={providers.find((item) => item.provider === provider) ?? fallbackProviderState(provider)}
            repositories={repositories[provider] ?? []}
            repositoryChecks={repositoryChecks}
            busy={busy}
            onAction={(action) => void providerAction(provider, action)}
            onValidate={(repository) => void validateRepository(provider, repository)}
          />
        ))}
      </div>
    </section>
  );
}
