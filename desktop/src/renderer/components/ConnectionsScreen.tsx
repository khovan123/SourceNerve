import { useEffect, useState } from "react";

import type {
  Auth0SessionView,
  GitProvider,
  ProviderAccountView,
  ProviderRepositorySummary,
  PublicMcpView,
} from "../../shared/desktop-api";
import { fallbackProviderState, type RepositoryCheck } from "../connection-view-model";
import { McpExtensionsScreen } from "./McpExtensionsScreen";
import { InlineNotice } from "./molecules/InlineNotice";
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
            message: result.value.writable
              ? "Provider access is ready for repository writes."
              : "Provider access is ready; this repository is read-only.",
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
      {error ? (
        <InlineNotice tone="danger" title="Connection failed" role="alert">
          {error}
        </InlineNotice>
      ) : null}

      <div className="grid items-stretch gap-4 xl:grid-cols-2">
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

      <McpExtensionsScreen />
    </section>
  );
}
