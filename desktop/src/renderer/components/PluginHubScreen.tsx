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

export function PluginHubScreen() {
  const [tab, setTab] = useState<PluginTab>("explore");
  const [registry, setRegistry] = useState<PluginRegistrySnapshot>(EMPTY);
  const [explore, setExplore] = useState<PluginExploreItem[]>([]);
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

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
      setPending({ root: result.value.path, review: result.value.review });
    } catch (pickError) {
      setError(message(pickError, "Plugin package could not be opened."));
    } finally {
      setBusy(null);
    }
  }

  async function install(root: string, review: PluginPackageReview): Promise<void> {
    setBusy(`install:${review.id}`);
    setError(null);
    setNotice(null);
    try {
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
      await refresh();
    } catch (removeError) {
      setError(message(removeError, "Plugin removal failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="SourceNerve Plugin Hub">
      <Panel title="Plugins" eyebrow="Packages · MCP · Skills">
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
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Plugins are declarative packages that can bundle MCP components and bounded SKILL.md instructions. MCP runtimes still pass through the existing SourceNerve gateway; plugins do not execute install hooks or arbitrary setup scripts.
        </p>
      </Panel>

      <InlineNotice tone="info" title="Stable ChatGPT skill bridge">
        Enabled plugin skills are materialized behind SourceNerve and exposed through the fixed plugin_catalog and plugin_skill_read tools. Installing another plugin changes the live catalog, not the stable ChatGPT schema.
      </InlineNotice>

      {error ? <InlineNotice tone="danger" title="Plugin operation failed" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="info" title="Plugin Hub updated">{notice}</InlineNotice> : null}

      {pending ? (
        <PluginReviewPanel
          pending={pending}
          busy={busy === `install:${pending.review.id}`}
          installed={registry.plugins.some((plugin) => plugin.id === pending.review.id)}
          onInstall={() => void install(pending.root, pending.review)}
          onClose={() => setPending(null)}
        />
      ) : null}

      {tab === "explore" ? (
        <>
          <Panel
            title="Explore plugins"
            eyebrow="SourceNerve catalog · Local package"
            actions={
              <ActionButton size="sm" onClick={() => void chooseLocal()} disabled={busy === "pick"}>
                {busy === "pick" ? "Opening…" : "Install local plugin"}
              </ActionButton>
            }
          >
            <p className="text-sm text-muted-foreground">
              Phase 1 reads the repository plugin catalog plus packages you explicitly choose. GitHub/HTTPS registry sources remain fail-closed until their provenance and update transport are implemented.
            </p>
          </Panel>
          <div className="grid gap-3 xl:grid-cols-2">
            {explore.map((item) => (
              <CatalogCard
                key={`${item.catalogId}:${item.sourcePath}`}
                item={item}
                installed={Boolean(item.review && registry.plugins.some((plugin) => plugin.id === item.review?.id))}
                busy={Boolean(item.review && busy === `install:${item.review.id}`)}
                onReview={() => item.review && setPending({ root: item.sourcePath, review: item.review })}
              />
            ))}
          </div>
          {explore.length === 0 ? (
            <Panel title="No local catalog packages" eyebrow="Catalog unavailable">
              <p className="text-sm text-muted-foreground">
                Choose a plugin directory manually. A valid package contains .codex-plugin/plugin.json and may declare .mcp.json plus skills/&lt;skill&gt;/SKILL.md.
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
              <p className="text-sm text-muted-foreground">Install a catalog or local plugin package from Explore.</p>
            </Panel>
          ) : null}
        </div>
      ) : null}

      {tab === "updates" ? (
        <Panel title="Plugin updates" eyebrow="Manifest hash comparison">
          {updateCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No changed local/catalog package manifests are detected. Update activation remains staged behind the same ownership and rollback rules rather than replacing shared MCP runtimes in place.
            </p>
          ) : (
            <div className="space-y-3">
              {updateCandidates.map(({ plugin, item }) => (
                <div key={plugin.id} className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <strong className="text-sm text-foreground">{plugin.name}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Installed {plugin.version} · catalog {item.review?.version} · manifest changed
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="secondary"
                    onClick={() => item.review && setPending({ root: item.sourcePath, review: item.review })}
                  >
                    Review package
                  </ActionButton>
                </div>
              ))}
            </div>
          )}
        </Panel>
      ) : null}
    </section>
  );
}

function CatalogCard({ item, installed, busy, onReview }: {
  item: PluginExploreItem;
  installed: boolean;
  busy: boolean;
  onReview(): void;
}) {
  const review = item.review;
  return (
    <article className="rounded-2xl border border-border/70 bg-card/65 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <strong className="block truncate text-sm text-foreground">{review?.name ?? item.catalogId}</strong>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {review ? `v${review.version}${review.publisher ? ` · ${review.publisher}` : ""}` : "Unavailable"}
          </span>
        </div>
        <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
          {installed ? "Installed" : review ? "Declarative" : "Blocked"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        {review?.description ?? item.blocker ?? "Plugin package could not be inspected."}
      </p>
      {review ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{review.mcpServers.length} MCP</span><span>·</span><span>{review.skills.length} Skills</span>
          {review.category ? <><span>·</span><span>{review.category}</span></> : null}
        </div>
      ) : null}
      <div className="mt-4 flex justify-end">
        <ActionButton size="sm" variant="secondary" disabled={!review || busy} onClick={onReview}>
          {busy ? "Installing…" : installed ? "Review" : "Review install"}
        </ActionButton>
      </div>
    </article>
  );
}

function PluginReviewPanel({ pending, busy, installed, onInstall, onClose }: {
  pending: PendingInstall;
  busy: boolean;
  installed: boolean;
  onInstall(): void;
  onClose(): void;
}) {
  const review = pending.review;
  return (
    <Panel
      title={`Review ${review.name}`}
      eyebrow="Declarative plugin package"
      actions={<ActionButton size="sm" variant="secondary" onClick={onClose}>Close</ActionButton>}
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Value label="Version" value={review.version} />
        <Value label="Publisher" value={review.publisher ?? "Not declared"} />
        <Value label="MCP components" value={String(review.mcpServers.length)} />
        <Value label="Skills" value={String(review.skills.length)} />
      </div>
      <p className="mt-4 text-sm leading-6 text-muted-foreground">{review.description}</p>
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
      <InlineNotice tone="info" title="Installation boundary">
        SourceNerve validates package paths and hashes, copies bounded skills into its managed store, reuses compatible MCP components by definition hash, and never executes plugin install hooks.
      </InlineNotice>
      <div className="mt-4 flex justify-end">
        <ActionButton disabled={busy || installed} onClick={onInstall}>
          {installed ? "Already installed" : busy ? "Installing…" : "Install & enable"}
        </ActionButton>
      </div>
    </Panel>
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

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
