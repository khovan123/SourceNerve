import { useEffect, useMemo, useState } from "react";

import type {
  McpExtensionView,
  McpMarketplaceInstallPlan,
  McpMarketplaceServerView,
} from "../../shared/mcp-extension-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { McpExtensionsScreen } from "./McpExtensionsScreen";
import { Panel } from "./Panel";

type McpTab = "explore" | "installed" | "updates";

interface UpdateCandidate {
  extension: McpExtensionView;
  plan: McpMarketplaceInstallPlan;
}

const inputClass =
  "h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10";

export function McpScreen() {
  const [tab, setTab] = useState<McpTab>("explore");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<McpMarketplaceServerView[]>([]);
  const [plan, setPlan] = useState<McpMarketplaceInstallPlan | null>(null);
  const [updates, setUpdates] = useState<UpdateCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void searchMarketplace("");
  }, []);

  useEffect(() => {
    if (tab === "updates") void refreshUpdates();
  }, [tab]);

  const autoInstallable = useMemo(
    () => results.filter((result) => result.canAutoInstall).length,
    [results],
  );

  async function searchMarketplace(nextQuery = query): Promise<void> {
    setBusy("search");
    setError(null);
    setNotice(null);
    try {
      const response = await window.sourcenerveMcpExtensions.searchMarketplace({
        query: nextQuery.trim(),
        limit: 18,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setResults(response.value);
      setPlan(null);
    } catch (searchError) {
      setError(message(searchError, "Official MCP Registry search failed."));
    } finally {
      setBusy(null);
    }
  }

  async function reviewInstall(server: McpMarketplaceServerView): Promise<void> {
    setBusy(`plan:${server.registryName}`);
    setError(null);
    setNotice(null);
    try {
      const response = await window.sourcenerveMcpExtensions.planMarketplaceInstall(
        server.registryName,
      );
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setPlan(response.value);
    } finally {
      setBusy(null);
    }
  }

  async function installPlanned(): Promise<void> {
    if (!plan?.input) return;
    setBusy("install-plan");
    setError(null);
    setNotice(null);
    try {
      const response = await window.sourcenerveMcpExtensions.install(plan.input);
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setNotice(
        `${response.value.name} installed from the Official MCP Registry. It remains disabled and its tools remain blocked until you review permissions.`,
      );
      setPlan(null);
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  async function refreshUpdates(): Promise<void> {
    setBusy("updates");
    setError(null);
    try {
      const installed = await window.sourcenerveMcpExtensions.list();
      if (!installed.ok) {
        setError(installed.error.message);
        return;
      }
      const registryExtensions = installed.value.filter((extension) =>
        extension.source.startsWith("registry:"),
      );
      const candidates = await Promise.all(
        registryExtensions.map(async (extension): Promise<UpdateCandidate | null> => {
          const serverName = extension.source.slice("registry:".length);
          const latest = await window.sourcenerveMcpExtensions.planMarketplaceInstall(serverName);
          if (!latest.ok || latest.value.server.version === extension.version) return null;
          return { extension, plan: latest.value };
        }),
      );
      setUpdates(candidates.filter((value): value is UpdateCandidate => value !== null));
    } catch (updateError) {
      setError(message(updateError, "MCP update check failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="MCP marketplace and extensions">
      <Panel title="MCP" eyebrow="Marketplace · Gateway · Policy">
        <div className="flex flex-wrap gap-2">
          <TabButton active={tab === "explore"} onClick={() => setTab("explore")}>
            Explore
          </TabButton>
          <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>
            Installed
          </TabButton>
          <TabButton active={tab === "updates"} onClick={() => setTab("updates")}>
            Updates
          </TabButton>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Discover MCP servers from the Official MCP Registry, install supported packages without hand-writing commands, then expose only explicitly permitted tools through the SourceNerve gateway.
        </p>
      </Panel>

      {error ? (
        <InlineNotice tone="danger" title="MCP operation failed" role="alert">
          {error}
        </InlineNotice>
      ) : null}
      {notice ? (
        <InlineNotice tone="info" title="MCP updated">
          {notice}
        </InlineNotice>
      ) : null}

      {tab === "explore" ? (
        <>
          <Panel title="Explore MCP servers" eyebrow="Official MCP Registry">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                void searchMarketplace();
              }}
            >
              <input
                className={inputClass}
                value={query}
                placeholder="Search memory, database, browser, Jira, filesystem..."
                onChange={(event) => setQuery(event.target.value)}
              />
              <ActionButton type="submit" disabled={busy === "search"}>
                {busy === "search" ? "Searching…" : "Search"}
              </ActionButton>
            </form>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{results.length} results</span>
              <span>·</span>
              <span>{autoInstallable} one-click eligible</span>
              <span>·</span>
              <span>npm / PyPI stdio and fixed public HTTPS remotes are resolved automatically</span>
            </div>
          </Panel>

          {plan ? (
            <InstallPlanPanel
              plan={plan}
              busy={busy === "install-plan"}
              onInstall={() => void installPlanned()}
              onClose={() => setPlan(null)}
            />
          ) : null}

          <div className="grid gap-3 xl:grid-cols-2">
            {results.map((server) => (
              <MarketplaceCard
                key={`${server.registryName}:${server.version}`}
                server={server}
                busy={busy === `plan:${server.registryName}`}
                onReview={() => void reviewInstall(server)}
              />
            ))}
          </div>
        </>
      ) : null}

      {tab === "installed" ? <McpExtensionsScreen /> : null}

      {tab === "updates" ? (
        <Panel
          title="Extension updates"
          eyebrow="Registry-aware"
          actions={
            <ActionButton size="sm" variant="secondary" onClick={() => void refreshUpdates()}>
              {busy === "updates" ? "Checking…" : "Check now"}
            </ActionButton>
          }
        >
          {updates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No registry-backed updates are currently detected. Only extensions installed from the SourceNerve marketplace participate in automatic version discovery.
            </p>
          ) : (
            <div className="space-y-3">
              {updates.map(({ extension, plan: updatePlan }) => (
                <div
                  key={extension.id}
                  className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <strong className="text-sm text-foreground">{extension.name}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {extension.version} → {updatePlan.server.version}
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setPlan(updatePlan);
                      setTab("explore");
                    }}
                  >
                    Review latest
                  </ActionButton>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Update discovery is live. Atomic staged activation + rollback remains fail-closed until the updater slice is implemented; SourceNerve will not replace a running extension silently.
              </p>
            </div>
          )}
        </Panel>
      ) : null}
    </section>
  );
}

function MarketplaceCard({
  server,
  busy,
  onReview,
}: {
  server: McpMarketplaceServerView;
  busy: boolean;
  onReview(): void;
}) {
  return (
    <article className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm text-foreground">{server.title}</strong>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {server.registryName} · v{server.version}
          </span>
        </div>
        <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
          {server.installKind}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{server.description}</p>
      <div className="mt-3 rounded-xl bg-muted/35 px-3 py-2 font-mono text-xs text-muted-foreground">
        {server.installHint}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {server.canAutoInstall ? "One-click plan available" : "Configuration review required"}
        </span>
        <ActionButton size="sm" variant={server.canAutoInstall ? "default" : "secondary"} onClick={onReview} disabled={busy}>
          {busy ? "Inspecting…" : "Review install"}
        </ActionButton>
      </div>
    </article>
  );
}

function InstallPlanPanel({
  plan,
  busy,
  onInstall,
  onClose,
}: {
  plan: McpMarketplaceInstallPlan;
  busy: boolean;
  onInstall(): void;
  onClose(): void;
}) {
  return (
    <Panel
      title={`Install ${plan.server.title}`}
      eyebrow="Marketplace install plan"
      actions={
        <ActionButton size="sm" variant="secondary" onClick={onClose}>
          Close
        </ActionButton>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <PlanValue label="Registry server" value={plan.server.registryName} />
        <PlanValue label="Version" value={plan.server.version} />
        <PlanValue label="Transport" value={plan.server.transport} />
        <PlanValue label="Source" value="Official MCP Registry" />
      </div>
      {plan.commandPreview ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/25 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            SourceNerve will configure
          </div>
          <code className="mt-2 block break-all text-xs text-foreground">{plan.commandPreview}</code>
        </div>
      ) : null}
      {plan.blockers.length > 0 ? (
        <InlineNotice tone="info" title="Manual configuration required">
          {plan.blockers.join(" ")} Use Installed → Install extension for advanced/manual configuration.
        </InlineNotice>
      ) : null}
      {plan.input ? (
        <div className="mt-4 flex justify-end">
          <ActionButton onClick={onInstall} disabled={busy}>
            {busy ? "Installing…" : "Install"}
          </ActionButton>
        </div>
      ) : null}
    </Panel>
  );
}

function PlanValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-1 break-all text-sm text-foreground">{value}</div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
        active
          ? "bg-foreground text-background"
          : "bg-muted/55 text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
