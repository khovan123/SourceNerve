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
  const [environmentDrafts, setEnvironmentDrafts] = useState<Record<string, string>>({});
  const [updates, setUpdates] = useState<UpdateCandidate[]>([]);
  const [rollbackReady, setRollbackReady] = useState<McpExtensionView | null>(null);
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
      setEnvironmentDrafts({});
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
      setEnvironmentDrafts(
        Object.fromEntries(
          response.value.server.configurationFields.map((field) => [
            field.name,
            field.defaultValue ?? "",
          ]),
        ),
      );
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
      const environment = plan.server.configurationFields
        .map((field) => ({
          name: field.name,
          value: environmentDrafts[field.name] ?? "",
          secret: field.secret,
        }))
        .filter((item) => item.value.length > 0);
      const response = await window.sourcenerveMcpExtensions.installMarketplace({
        serverName: plan.server.registryName,
        ...(environment.length > 0 ? { environment } : {}),
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setNotice(
        response.value.authType === "oauth"
          ? `${response.value.name} installed, OAuth authorization completed, enabled, and all discovered tools were set to Automatic by default.`
          : `${response.value.name} installed and enabled from the configured MCP marketplace. Declared environment values were placed behind SourceNerve secure storage and all discovered tools were set to Automatic by default.`,
      );
      setPlan(null);
      setEnvironmentDrafts({});
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

  async function applyUpdate(candidate: UpdateCandidate): Promise<void> {
    setBusy(`update:${candidate.extension.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await window.sourcenerveMcpExtensions.updateMarketplace(
        candidate.extension.id,
      );
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setNotice(response.value.message);
      const current = await window.sourcenerveMcpExtensions.list();
      if (current.ok) {
        setRollbackReady(
          current.value.find((item) => item.id === candidate.extension.id) ?? candidate.extension,
        );
      }
      await refreshUpdates();
    } finally {
      setBusy(null);
    }
  }

  async function rollback(extension: McpExtensionView): Promise<void> {
    if (!window.confirm(`Roll back ${extension.name} to the previous staged SourceNerve snapshot?`)) {
      return;
    }
    setBusy(`rollback:${extension.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await window.sourcenerveMcpExtensions.rollbackMarketplace(extension.id);
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setNotice(response.value.message);
      setRollbackReady(null);
      await refreshUpdates();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="MCP marketplace and extensions">
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
          <Panel title="Explore MCP servers" eyebrow="Configured catalogs">
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
              <span>OAuth, environment recipes, governance and artifact evidence are inspected before activation</span>
            </div>
          </Panel>

          {plan ? (
            <InstallPlanPanel
              plan={plan}
              environmentDrafts={environmentDrafts}
              busy={busy === "install-plan"}
              onEnvironmentChange={(name, value) =>
                setEnvironmentDrafts((current) => ({ ...current, [name]: value }))
              }
              onInstall={() => void installPlanned()}
              onClose={() => {
                setPlan(null);
                setEnvironmentDrafts({});
              }}
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
        <>
          {rollbackReady ? (
            <Panel
              title={`Rollback available · ${rollbackReady.name}`}
              eyebrow="Previous SourceNerve snapshot retained"
              actions={
                <ActionButton
                  size="sm"
                  variant="secondary"
                  disabled={busy === `rollback:${rollbackReady.id}`}
                  onClick={() => void rollback(rollbackReady)}
                >
                  {busy === `rollback:${rollbackReady.id}` ? "Rolling back…" : "Rollback"}
                </ActionButton>
              }
            >
              <p className="text-sm text-muted-foreground">
                SourceNerve retained the previous transport, OAuth metadata, per-tool permission snapshot and cryptographic provenance evidence. Environment and credentials remain in secure storage instead of the rollback document.
              </p>
              {rollbackReady.artifactVerification ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Current artifact evidence: {verificationSummary(rollbackReady.artifactVerification)}
                </p>
              ) : null}
            </Panel>
          ) : null}
          <Panel
            title="Extension updates"
            eyebrow="Verify · Stage · Activate · Roll back"
            actions={
              <ActionButton size="sm" variant="secondary" onClick={() => void refreshUpdates()}>
                {busy === "updates" ? "Checking…" : "Check now"}
              </ActionButton>
            }
          >
            {updates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No registry-backed updates are currently detected. Registry extensions are checked against the latest published version.
              </p>
            ) : (
              <div className="space-y-3">
                {updates.map((candidate) => (
                  <div
                    key={candidate.extension.id}
                    className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <strong className="text-sm text-foreground">{candidate.extension.name}</strong>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {candidate.extension.version} → {candidate.plan.server.version} · Trust {candidate.plan.server.trust.score}/100 · Artifact {candidate.plan.server.verification?.status ?? "unsupported"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Existing tool policies are restored by original tool name; newly added tools stay blocked by default. Verified provenance evidence is retained with the rollback snapshot.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setPlan(candidate.plan);
                          setEnvironmentDrafts({});
                          setTab("explore");
                        }}
                      >
                        Review
                      </ActionButton>
                      <ActionButton
                        size="sm"
                        disabled={busy === `update:${candidate.extension.id}` || candidate.plan.blockers.length > 0}
                        onClick={() => void applyUpdate(candidate)}
                      >
                        {busy === `update:${candidate.extension.id}` ? "Updating…" : "Update safely"}
                      </ActionButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
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
        <div className="flex shrink-0 items-center gap-2">
          <TrustBadge server={server} />
          <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
            {server.installKind}
          </span>
        </div>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{server.description}</p>
      <div className="mt-3 rounded-xl bg-muted/35 px-3 py-2 font-mono text-xs text-muted-foreground">
        {server.installHint}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{server.trust.namespaceVerified ? "✓ namespace verified" : "namespace unverified"}</span>
        <span>{server.trust.packageOwnershipVerified ? "✓ package ownership" : "remote metadata"}</span>
        <span>artifact {server.verification?.status ?? "unsupported"}</span>
        <span>signature {server.verification?.signature.status ?? "unsupported"}</span>
        <span>{server.trust.registryStatus}</span>
        {server.configurationFields.length > 0 ? <span>{server.configurationFields.length} config field(s)</span> : null}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {server.canAutoInstall ? "Install plan eligible for review" : "Configuration or policy review required"}
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
  environmentDrafts,
  busy,
  onEnvironmentChange,
  onInstall,
  onClose,
}: {
  plan: McpMarketplaceInstallPlan;
  environmentDrafts: Record<string, string>;
  busy: boolean;
  onEnvironmentChange(name: string, value: string): void;
  onInstall(): void;
  onClose(): void;
}) {
  const missingRequired = plan.server.configurationFields.some(
    (field) => field.required && !(environmentDrafts[field.name] ?? "").trim(),
  );
  const verification = plan.server.verification;
  return (
    <Panel
      title={`Install ${plan.server.title}`}
      eyebrow="Reviewed install plan"
      actions={
        <ActionButton size="sm" variant="secondary" onClick={onClose}>
          Close
        </ActionButton>
      }
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <PlanValue label="Registry server" value={plan.server.registryName} />
        <PlanValue label="Version" value={plan.server.version} />
        <PlanValue label="Transport" value={plan.server.transport} />
        <PlanValue label="Trust" value={`${plan.server.trust.score}/100 · ${plan.server.trust.level}`} />
        <PlanValue label="Artifact" value={verification?.status ?? "unsupported"} />
      </div>

      <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Behavioral trust & policy provenance
        </div>
        <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
          <span>Registry status: {plan.server.trust.registryStatus}</span>
          <span>Publisher namespace: {plan.server.trust.namespaceVerified ? "verified by marketplace registry" : "not verified"}</span>
          <span>Package ownership: {plan.server.trust.packageOwnershipVerified ? "verified by marketplace registry" : "not applicable / not verified"}</span>
          <span>Marketplace provenance: {plan.server.trust.signingStatus}</span>
          {plan.server.trust.reasons.map((reason) => <span key={reason}>• {reason}</span>)}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Cryptographic artifact evidence
        </div>
        {verification ? (
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <span>Status: {verification.status}{verification.required ? " · required before activation" : ""}</span>
            <span>
              Digest: {verification.digest.status}
              {verification.digest.algorithm ? ` · ${verification.digest.algorithm}` : ""}
              {verification.digest.source ? ` · ${verification.digest.source}` : ""}
            </span>
            <span>
              Publisher signature: {verification.signature.status}
              {verification.signature.publisher ? ` · ${verification.signature.publisher}` : ""}
              {verification.signature.keyId ? ` · key ${verification.signature.keyId}` : ""}
            </span>
            {verification.notes.map((note) => <span key={note}>• {note}</span>)}
            <span>• A valid signature proves only the configured provenance claim; it is never treated as equivalent to behavioral safety or policy approval.</span>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            This marketplace source does not currently provide a SourceNerve-supported package artifact verification path. Unsupported evidence is reported explicitly rather than inferred as safe.
          </p>
        )}
      </div>

      {plan.auth ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Authentication
          </div>
          <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
            <span>Status: {plan.auth.status}</span>
            <span>Discovery: {plan.auth.source}</span>
            <span>Client registration: {plan.auth.registration}</span>
            {plan.auth.scopes.length > 0 ? <span>Scopes: {plan.auth.scopes.join(" ")}</span> : null}
            {plan.auth.notes.map((note) => <span key={note}>• {note}</span>)}
          </div>
        </div>
      ) : null}

      {plan.commandPreview ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/25 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            SourceNerve will configure
          </div>
          <code className="mt-2 block break-all text-xs text-foreground">{plan.commandPreview}</code>
        </div>
      ) : null}

      {plan.server.configurationFields.length > 0 ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Safe setup recipe
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            These values are declared by the registry package metadata. SourceNerve stores them with OS-backed secure storage and injects only these values into the isolated stdio process; no hidden shell/auth script is executed.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {plan.server.configurationFields.map((field) => (
              <label key={field.name} className="grid gap-1.5 text-xs text-muted-foreground">
                <span>
                  {field.name}{field.required ? " *" : ""}
                  {field.description ? ` · ${field.description}` : ""}
                </span>
                <input
                  className={inputClass}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={environmentDrafts[field.name] ?? ""}
                  placeholder={field.secret ? "Stored securely" : field.defaultValue ?? "Value"}
                  onChange={(event) => onEnvironmentChange(field.name, event.target.value)}
                />
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {plan.blockers.length > 0 ? (
        <InlineNotice tone="info" title="Automatic install blocked">
          {plan.blockers.join(" ")} SourceNerve will not activate an artifact whose required cryptographic evidence cannot be verified.
        </InlineNotice>
      ) : null}

      {plan.input && plan.blockers.length === 0 ? (
        <div className="mt-4 space-y-3">
          <p className="text-right text-xs text-muted-foreground">
            After install, SourceNerve enables the extension and sets every discovered tool to Automatic by default. You can change individual policies later from Installed.
          </p>
          <div className="flex justify-end">
            <ActionButton onClick={onInstall} disabled={busy || missingRequired}>
              {busy
                ? "Installing…"
                : plan.auth?.status === "oauth"
                  ? "Install & authorize"
                  : plan.server.configurationFields.length > 0
                    ? "Install securely"
                    : verification?.status === "verified"
                      ? "Install verified artifact"
                      : "Install"}
            </ActionButton>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function TrustBadge({ server }: { server: McpMarketplaceServerView }) {
  return (
    <span
      className="rounded-full border border-border/70 px-2 py-1 text-[11px] font-medium text-foreground"
      title={server.trust.reasons.join(" ")}
    >
      Trust {server.trust.score}
    </span>
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

function verificationSummary(
  verification: NonNullable<McpExtensionView["artifactVerification"]>,
): string {
  return `${verification.status}; digest ${verification.digest.status}; signature ${verification.signature.status}`;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
