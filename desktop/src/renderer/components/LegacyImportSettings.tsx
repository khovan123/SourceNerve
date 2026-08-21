import { useMemo, useState } from "react";
import { ArchiveRestore, FileCog, ShieldCheck, Undo2, X } from "lucide-react";

import type {
  LegacyImportPreview,
  LegacyImportResult,
  LegacyImportStateStrategy,
} from "../../shared/desktop-api";
import { ActionButton } from "./atoms/ActionButton";
import { StatusPill } from "./atoms/StatusPill";
import { InlineNotice } from "./molecules/InlineNotice";
import { SurfaceCard } from "./molecules/SurfaceCard";

const selectClass = "h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

export function LegacyImportSettings() {
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [strategy, setStrategy] = useState<LegacyImportStateStrategy>("reindex");
  const [result, setResult] = useState<LegacyImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidWorkspaces = useMemo(
    () => preview?.workspaces.filter((workspace) => workspace.validation.state !== "ready") ?? [],
    [preview],
  );

  async function chooseConfig(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await window.sourcenerveDesktop.pickLegacyImport();
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      if (!response.value) return;
      setPreview(response.value);
      setStrategy(response.value.state.recommendedStrategy);
    } finally {
      setBusy(false);
    }
  }

  async function applyImport(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await window.sourcenerveDesktop.applyLegacyImport({
        selectionId: preview.selectionId,
        stateStrategy: strategy,
      });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setResult(response.value);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SurfaceCard
      title="Existing setup migration"
      eyebrow="Current SourceNerve users"
      description="Inspect and import workspace metadata from an existing setup without copying infrastructure secrets or weakening Desktop ownership boundaries."
      actions={preview ? (
        <ActionButton variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
          <X className="size-3.5" aria-hidden="true" />
          Cancel preview
        </ActionButton>
      ) : null}
    >
      <div className="space-y-5">
        <InlineNotice tone="info" title="Import workspace metadata, not infrastructure secrets">
          Import repository/workspace metadata from an existing <code className="font-mono text-foreground">sourcenerve.toml</code>. Desktop keeps its packaged server, OAuth, Public MCP and Cloudflare policy; legacy secrets are never copied from TOML, shell history, or process environment.
        </InlineNotice>

        {!preview ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/15 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><ArchiveRestore className="size-4" aria-hidden="true" /></div>
              <div><p className="text-xs font-semibold text-foreground">Start with a read-only inspection</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">Nothing is changed until the preview is valid and you explicitly choose Backup and import.</p></div>
            </div>
            <ActionButton variant="secondary" size="sm" disabled={busy} onClick={() => void chooseConfig()}><FileCog className="size-3.5" aria-hidden="true" />{busy ? "Inspecting…" : "Choose sourcenerve.toml"}</ActionButton>
          </div>
        ) : null}

        {error ? <InlineNotice tone="danger" title="Migration action failed" role="alert">{error}</InlineNotice> : null}

        {preview ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{preview.workspaces.length} workspace(s) detected</p>
                <p className="mt-1 select-all break-all font-mono text-[10px] leading-4 text-muted-foreground" title={preview.configPath}>{preview.configPath}</p>
              </div>
              <StatusPill tone={invalidWorkspaces.length === 0 ? "ready" : "warning"} dot>{invalidWorkspaces.length === 0 ? "Repositories valid" : `${invalidWorkspaces.length} need repair`}</StatusPill>
            </div>

            <div className="grid max-h-[26rem] gap-2 overflow-auto overscroll-contain pr-1" tabIndex={0}>
              {preview.workspaces.map((workspace) => {
                const ready = workspace.validation.state === "ready";
                return (
                  <article key={workspace.id} className="rounded-xl border border-border bg-muted/20 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground">{workspace.name}</p>
                        <p className="mt-1 break-words text-[10px] leading-5 text-muted-foreground">{workspace.id} · {workspace.access} · {workspace.remote}/{workspace.defaultBranch}</p>
                        <p className="select-all break-all font-mono text-[10px] leading-4 text-muted-foreground" title={workspace.root}>{workspace.root}</p>
                      </div>
                      <StatusPill tone={ready ? "ready" : "warning"} dot>{ready ? "Ready" : "Invalid"}</StatusPill>
                    </div>
                    {workspace.validation.message ? <div className="mt-2"><InlineNotice tone="warning" title="Workspace needs repair">{workspace.validation.message}</InlineNotice></div> : null}
                  </article>
                );
              })}
            </div>

            <div className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">Existing state</p>
                <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{preview.state.status} · schema {preview.state.schemaVersion ?? "unknown"} / supported {preview.state.supportedSchemaVersion}</p>
                <p className="select-all break-all font-mono text-[10px] leading-4 text-muted-foreground" title={preview.state.path}>{preview.state.path}</p>
                {preview.state.message ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{preview.state.message}</p> : null}
              </div>
              <label className="grid gap-1.5"><span className="text-xs font-medium text-muted-foreground">State strategy</span><select className={selectClass} value={strategy} disabled={busy} onChange={(event) => setStrategy(event.target.value as LegacyImportStateStrategy)}>{preview.state.allowedStrategies.map((value) => <option key={value} value={value}>{strategyLabel(value)}</option>)}</select></label>
            </div>

            {preview.legacyProduct.warnings.length > 0 ? <InlineNotice tone="warning" title="Legacy product settings will not override Desktop defaults">{preview.legacyProduct.warnings.join(" ")}</InlineNotice> : null}

            <NoticeBlock title="Reconnect after import" items={["Desktop local bearer is re-provisioned from encrypted Desktop storage.", ...(preview.reconnect.auth0 ? ["Sign in to the SourceNerve account again through Auth0."] : []), ...preview.reconnect.providers.map((provider) => `Reconnect ${provider === "github" ? "GitHub" : "GitLab"} through Connections.`), "Shell environment and shell history are not inspected."]} />

            <div className="rounded-xl border border-primary/15 bg-primary/[0.05] p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /><div><p className="text-xs font-semibold text-foreground">Backup first, then import</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">The original config and legacy state remain untouched until migration commits successfully.</p></div></div>
                <ActionButton disabled={busy || invalidWorkspaces.length > 0} onClick={() => void applyImport()}><ArchiveRestore className="size-4" aria-hidden="true" />{busy ? "Migrating…" : "Backup and import"}</ActionButton>
              </div>
            </div>
          </div>
        ) : null}

        {result ? (
          <InlineNotice tone="success" title="Migration completed" role="status">
            <div className="space-y-2"><p>{result.importedWorkspaces} workspace(s) imported using {strategyLabel(result.stateStrategy)}.</p><p className="break-all text-[10px]">Backup: <code className="select-all font-mono text-foreground">{result.backupPath}</code></p>{result.stateStrategy === "move" && !result.sourceStateRemoved ? <p>The source state was retained as an extra safety copy.</p> : null}<details className="rounded-lg border border-border bg-card/55 px-3 py-2"><summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25"><Undo2 className="size-3.5" aria-hidden="true" />Rollback instructions</summary><ol className="mt-2 list-decimal space-y-1 pl-5 text-[10px] leading-5 text-muted-foreground">{result.rollback.map((step) => <li key={step}>{step}</li>)}</ol></details></div>
          </InlineNotice>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function NoticeBlock({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-xl border border-border bg-muted/20 p-4"><p className="text-xs font-semibold text-foreground">{title}</p><ul className="mt-2 list-disc space-y-1 pl-5 text-[10px] leading-5 text-muted-foreground">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>;
}

function strategyLabel(value: LegacyImportStateStrategy): string {
  if (value === "copy") return "Copy state into Desktop";
  if (value === "move") return "Move state into Desktop";
  if (value === "reference") return "Reference existing state in place";
  return "Start clean and re-index";
}
