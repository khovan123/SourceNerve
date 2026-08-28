import { useEffect, useMemo, useState } from "react";

import type {
  InstalledPluginRecord,
  PluginExploreItem,
  PluginPackageReview,
  PluginRegistrySnapshot,
} from "../../shared/plugin-hub-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { Panel } from "./Panel";

type PluginTab = "explore" | "installed" | "updates";

interface PendingInstall {
  root: string;
  review: PluginPackageReview;
}

const EMPTY: PluginRegistrySnapshot = { plugins: [], mcpOwnership: [] };
const inputClass =
  "h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10";

export function PluginHubScreen() {
  const [tab, setTab] = useState<PluginTab>("explore");
  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<PluginRegistrySnapshot>(EMPTY);
  const [explore, setExplore] = useState<PluginExploreItem[]>([]);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  const installedById = useMemo(
    () => new Map(registry.plugins.map((plugin) => [plugin.id, plugin])),
    [registry.plugins],
  );

  const marketplaceResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return explore;
    return explore.filter((item) => {
      const review = item.review;
      return [
        item.catalogId,
        item.category,
        review?.id,
        review?.name,
        review?.description,
        review?.publisher,
        review?.category,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(normalized));
    });
  }, [explore, query]);

  const installableMarketplaceCount = useMemo(
    () => explore.filter((item) => {
      const pluginId = item.review?.id ?? item.catalogId;
      return (item.remoteAvailable || Boolean(item.review)) && !item.blocker && !installedById.has(pluginId);
    }).length,
    [explore, installedById],
  );

  const updateCandidates = useMemo(() => {
    return registry.plugins.flatMap((plugin) => {
      const candidate = explore.find((item) => item.review?.id === plugin.id && item.review.manifestHash !== plugin.manifestHash);
      return candidate?.review ? [{ plugin, item: candidate }] : [];
    });
  }, [explore, registry]);

  async function refresh(): Promise<void> {
    setBusy("refresh");
    setError(null);
    try {
      const [installed, catalog] = await Promise.all([
        window.sourcenervePluginHub.list(),
        window.sourcenervePluginHub.explore(),
      ]);
      if (!installed.ok) throw new Error(installed.error.message);
      if (!catalog.ok) throw new Error(catalog.error.message);
      setRegistry(installed.value);
      setExplore(catalog.value);
    } catch (refreshError) {
      setError(message(refreshError, "Plugin Hub refresh failed."));
    } finally {
      setBusy(null);
    }
  }

  async function chooseLocal(): Promise<void> {
    setBusy("pick");
    setError(null);
    setNotice(null);
    try {
      const result = await window.sourcenervePluginHub.pickLocal();
      if (!result.ok) throw new Error(result.error.message);
      if (!result.value.selected || !result.value.path || !result.value.review) return;
      const installed = registry.plugins.find((plugin) => plugin.id === result.value.review?.id);
      if (installed) {
        setNotice(`${installed.name} is already installed. Remove it before installing the same plugin again.`);
        setTab("installed");
        return;
      }
      setPending({ root: result.value.path, review: result.value.review });
    } catch (pickError) {
      setError(message(pickError, "Plugin package could not be opened."));
    } finally {
      setBusy(null);
    }
  }

  async function reviewMarketplace(item: PluginExploreItem): Promise<void> {
    if (item.review) {
      setPending({ root: item.sourcePath, review: item.review });
      return;
    }
    if (!item.remoteAvailable || item.blocker) return;

    setBusy(`review:${item.catalogId}`);
    setError(null);
    setNotice(null);
    try {
      const latest = await window.sourcenervePluginHub.list();
      if (!latest.ok) throw new Error(latest.error.message);
      const installed = latest.value.plugins.find((plugin) => plugin.id === item.catalogId);
      if (installed) {
        setRegistry(latest.value);
        setNotice(`${installed.name} is already installed.`);
        setTab("installed");
        return;
      }

      const result = await window.sourcenervePluginHub.reviewMarketplace(item.catalogId);
      if (!result.ok) throw new Error(result.error.message);
      setPending({ root: result.value.path, review: result.value.review });
    } catch (reviewError) {
      setError(message(reviewError, `Plugin ${item.catalogId} could not be prepared for review.`));
    } finally {
      setBusy(null);
    }
  }

  async function install(root: string, review: PluginPackageReview): Promise<void> {
    setBusy(`install:${review.id}`);
    setError(null);
    setNotice(null);
    try {
      const latest = await window.sourcenervePluginHub.list();
      if (!latest.ok) throw new Error(latest.error.message);
      const alreadyInstalled = latest.value.plugins.find((plugin) => plugin.id === review.id);
      if (alreadyInstalled) {
        setRegistry(latest.value);
        setPending(null);
        setNotice(`${alreadyInstalled.name} is already installed. No duplicate installation was attempted.`);
        setTab("installed");
        return;
      }

      const result = await window.sourcenervePluginHub.installLocal(root);
      if (!result.ok) throw new Error(result.error.message);
      setNotice(
        `${result.value.plugin.name} installed and enabled. ${result.value.createdMcpExtensions.length} MCP component(s) created, ${result.value.reusedMcpExtensions.length} reused, and ${result.value.plugin.skills.length} skill(s) materialized.`,
      );
      setPending(null);
      setTab("installed");
      await refresh();
    } catch (installError) {
      setError(message(installError, "Plugin installation failed."));
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(plugin: InstalledPluginRecord, enabled: boolean): Promise<void> {
    setBusy(`${enabled ? "enable" : "disable"}:${plugin.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = enabled
        ? await window.sourcenervePluginHub.enable(plugin.id)
        : await window.sourcenervePluginHub.disable(plugin.id);
      if (!result.ok) throw new Error(result.error.message);
      setNotice(`${plugin.name} ${enabled ? "enabled" : "disabled"}.`);
      await refresh();
    } catch (operationError) {
      setError(message(operationError, "Plugin state change failed."));
    } finally {
      setBusy(null);
    }
  }

  async function remove(plugin: InstalledPluginRecord): Promise<void> {
    if (!window.confirm(`Remove ${plugin.name}? Shared or manually installed MCP components will be preserved.`)) return;
    setBusy(`remove:${plugin.id}`);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sourcenervePluginHub.remove(plugin.id);
      if (!result.ok) throw new Error(result.error.message);
      setNotice(`${plugin.name} removed. Shared/manual MCP ownership was preserved.`);
      if (pending?.review.id === plugin.id) setPending(null);
      await refresh();
    } catch (removeError) {
      setError(message(removeError, "Plugin removal failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="SourceNerve Plugin Hub">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <TabButton active={tab === "explore"} onClick={() => setTab("explore")}>Explore</TabButton>
          <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>Installed</TabButton>
          <TabButton active={tab === "updates"} onClick={() => setTab("updates")}>Updates</TabButton>
        </div>
        <ActionButton size="sm" variant="secondary" onClick={() => void refresh()} disabled={busy === "refresh"}>
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </ActionButton>
      </div>

      {error ? <InlineNotice tone="danger" title="Plugin operation failed" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="info" title="Plugin Hub updated">{notice}</InlineNotice> : null}

      {tab === "explore" ? (
        <>
          <Panel
            title="Plugin Marketplace"
            eyebrow="OpenAI public marketplace"
            actions={
              <ActionButton size="sm" variant="secondary" onClick={() => void chooseLocal()} disabled={busy === "pick"}>
                {busy === "pick" ? "Opening…" : "Install local package"}
              </ActionButton>
            }
          >
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => event.preventDefault()}
            >
              <input
                className={inputClass}
                value={query}
                placeholder="Search plugins, publishers, categories, skills..."
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <ActionButton type="button" variant="secondary" onClick={() => setQuery("")}>Clear</ActionButton>
              ) : null}
            </form>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{marketplaceResults.length} results</span>
              <span>·</span>
              <span>{explore.length} marketplace entries</span>
              <span>·</span>
              <span>{registry.plugins.length} installed</span>
              <span>·</span>
              <span>{installableMarketplaceCount} available to review</span>
            </div>
          </Panel>

          <div className="grid gap-3 xl:grid-cols-2">
            {marketplaceResults.map((item) => {
              const pluginId = item.review?.id ?? item.catalogId;
              const installedPlugin = installedById.get(pluginId);
              const cardBusy = busy === `review:${item.catalogId}`
                || busy === `install:${pluginId}`
                || busy === `remove:${pluginId}`;
              return (
                <CatalogCard
                  key={`${item.catalogId}:${item.sourcePath}`}
                  item={item}
                  installedPlugin={installedPlugin}
                  busy={cardBusy}
                  onReview={() => void reviewMarketplace(item)}
                  onRemove={(plugin) => void remove(plugin)}
                />
              );
            })}
          </div>

          {marketplaceResults.length === 0 ? (
            <Panel title={explore.length === 0 ? "Marketplace unavailable" : "No matching plugins"} eyebrow="Plugin Marketplace">
              <p className="text-sm text-muted-foreground">
                {explore.length === 0
                  ? "The public marketplace index could not be loaded. Refresh to retry or choose a local plugin package explicitly."
                  : "Try another search term or clear the current marketplace filter."}
              </p>
            </Panel>
          ) : null}
        </>
      ) : null}

      {tab === "installed" ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {registry.plugins.map((plugin) => (
            <InstalledCard
              key={plugin.id}
              plugin={plugin}
              ownership={registry.mcpOwnership.filter((item) => item.owners.includes(plugin.id))}
              busy={busy}
              onToggle={(enabled) => void setEnabled(plugin, enabled)}
              onRemove={() => void remove(plugin)}
            />
          ))}
          {registry.plugins.length === 0 ? (
            <Panel title="No installed plugins" eyebrow="Plugin Hub">
              <p className="text-sm text-muted-foreground">Install a marketplace or local plugin package from Explore.</p>
            </Panel>
          ) : null}
        </div>
      ) : null}

      {tab === "updates" ? (
        <Panel title="Plugin updates" eyebrow="Manifest hash comparison">
          {updateCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reviewed marketplace package has a changed manifest. Remote packages are resolved lazily when opened for review instead of being downloaded during Explore.
            </p>
          ) : (
            <div className="space-y-3">
              {updateCandidates.map(({ plugin, item }) => (
                <div key={plugin.id} className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <strong className="text-sm text-foreground">{plugin.name}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Installed {plugin.version} · marketplace {item.review?.version} · manifest changed
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void reviewMarketplace(item)}
                  >
                    Review package
                  </ActionButton>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ) : null}

      {pending ? (
        <PluginReviewModal
          pending={pending}
          busy={busy === `install:${pending.review.id}` || busy === `remove:${pending.review.id}`}
          installedPlugin={installedById.get(pending.review.id)}
          onInstall={() => void install(pending.root, pending.review)}
          onRemove={(plugin) => void remove(plugin)}
          onClose={() => setPending(null)}
        />
      ) : null}
    </section>
  );
}

function CatalogCard({ item, installedPlugin, busy, onReview, onRemove }: {
  item: PluginExploreItem;
  installedPlugin?: InstalledPluginRecord;
  busy: boolean;
  onReview(): void;
  onRemove(plugin: InstalledPluginRecord): void;
}) {
  const review = item.review;
  const available = Boolean(review || item.remoteAvailable) && !item.blocker;
  return (
    <article className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm text-foreground">{review?.name ?? marketplaceName(item.catalogId)}</strong>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {review
              ? `v${review.version}${review.publisher ? ` · ${review.publisher}` : ""}`
              : item.remoteAvailable
                ? "Public marketplace package"
                : "Unavailable"}
          </span>
        </div>
        <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
          {installedPlugin ? "Installed" : available ? "Available" : "Blocked"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {review?.description
          ?? item.blocker
          ?? "Remote marketplace entry. Open Review install to download and validate its MCP and skill package."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {review ? <><span>{review.mcpServers.length} MCP</span><span>·</span><span>{review.skills.length} Skills</span></> : null}
        {item.category ? <><span>{review ? "·" : ""}</span><span>{item.category}</span></> : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {installedPlugin ? (
          <ActionButton
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onRemove(installedPlugin)}
          >
            {busy ? "Removing…" : "Remove"}
          </ActionButton>
        ) : (
          <ActionButton size="sm" variant="secondary" disabled={!available || busy} onClick={onReview}>
            {busy ? "Preparing…" : "Review install"}
          </ActionButton>
        )}
      </div>
    </article>
  );
}

function PluginReviewModal({ pending, busy, installedPlugin, onInstall, onRemove, onClose }: {
  pending: PendingInstall;
  busy: boolean;
  installedPlugin?: InstalledPluginRecord;
  onInstall(): void;
  onRemove(plugin: InstalledPluginRecord): void;
  onClose(): void;
}) {
  const review = pending.review;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-review-title"
        aria-describedby="plugin-review-description"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
          <div className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Review installation</span>
            <h2 id="plugin-review-title" className="mt-1 truncate text-lg font-semibold text-foreground">{review.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">v{review.version}{review.publisher ? ` · ${review.publisher}` : ""}</p>
          </div>
          <ActionButton size="sm" variant="secondary" disabled={busy} onClick={onClose}>Close</ActionButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Value label="Version" value={review.version} />
            <Value label="Publisher" value={review.publisher ?? "Not declared"} />
            <Value label="MCP" value={String(review.mcpServers.length)} />
            <Value label="Skills" value={String(review.skills.length)} />
            <Value label="Harness" value={review.harness ? "Declared" : "None"} />
          </div>

          <p id="plugin-review-description" className="mt-4 text-sm leading-6 text-muted-foreground">{review.description}</p>

          {review.warnings.length > 0 ? (
            <div className="mt-4">
              <InlineNotice tone="info" title="Compatibility notes">
                <div className="space-y-1">
                  {review.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                </div>
              </InlineNotice>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
              <strong className="text-xs uppercase tracking-[0.12em] text-muted-foreground">MCP components</strong>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {review.mcpServers.length === 0 ? <span>No MCP component</span> : review.mcpServers.map((mcp) => (
                  <div key={mcp.id}>{mcp.name} · {mcp.transport.kind} · auth {mcp.auth}</div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
              <strong className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Skills</strong>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {review.skills.length === 0 ? <span>No skills</span> : review.skills.map((skill) => (
                  <div key={skill.id}>{skill.name} · {skill.bytes} bytes</div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <InlineNotice tone="info" title="Installation boundary">
              SourceNerve validates package paths and hashes, copies bounded skills into its managed store, reuses compatible MCP components by definition hash, and never executes plugin install hooks.
            </InlineNotice>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/70 bg-card px-5 py-4">
          <ActionButton variant="secondary" disabled={busy} onClick={onClose}>Cancel</ActionButton>
          {installedPlugin ? (
            <ActionButton variant="secondary" disabled={busy} onClick={() => onRemove(installedPlugin)}>
              {busy ? "Removing…" : "Remove installed plugin"}
            </ActionButton>
          ) : (
            <ActionButton disabled={busy} onClick={onInstall}>
              {busy ? "Installing…" : "Install & enable"}
            </ActionButton>
          )}
        </footer>
      </section>
    </div>
  );
}

function InstalledCard({ plugin, ownership, busy, onToggle, onRemove }: {
  plugin: InstalledPluginRecord;
  ownership: PluginRegistrySnapshot["mcpOwnership"];
  busy: string | null;
  onToggle(enabled: boolean): void;
  onRemove(): void;
}) {
  const toggleBusy = busy === `${plugin.enabled ? "disable" : "enable"}:${plugin.id}`;
  return (
    <article className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <strong className="text-sm text-foreground">{plugin.name}</strong>
          <p className="mt-1 text-xs text-muted-foreground">v{plugin.version}{plugin.publisher ? ` · ${plugin.publisher}` : ""}</p>
        </div>
        <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
          {plugin.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{plugin.description}</p>
      <div className="mt-3 grid gap-1 text-xs text-muted-foreground">
        <span>{plugin.mcpExtensionIds.length} MCP component(s) · {plugin.skills.length} skill(s)</span>
        <span>{ownership.filter((item) => item.directInstall).length} manually installed MCP component(s) preserved by ownership</span>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <ActionButton size="sm" variant="secondary" disabled={toggleBusy} onClick={() => onToggle(!plugin.enabled)}>
          {toggleBusy ? "Updating…" : plugin.enabled ? "Disable" : "Enable"}
        </ActionButton>
        <ActionButton size="sm" variant="secondary" disabled={busy === `remove:${plugin.id}`} onClick={onRemove}>
          {busy === `remove:${plugin.id}` ? "Removing…" : "Remove"}
        </ActionButton>
      </div>
    </article>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2"><div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div><div className="mt-1 break-all text-sm text-foreground">{value}</div></div>;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) {
  return <button type="button" onClick={onClick} className={`rounded-xl px-3 py-2 text-sm font-medium transition ${active ? "bg-foreground text-background" : "bg-muted/55 text-muted-foreground hover:text-foreground"}`}>{children}</button>;
}

function marketplaceName(value: string): string {
  return value
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
