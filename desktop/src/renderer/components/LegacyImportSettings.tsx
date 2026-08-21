import { useMemo, useState } from "react";
import { ArchiveRestore, FileCog, ShieldCheck, Undo2, X } from "lucide-react";

import type {
  LegacyImportPreview,
  LegacyImportResult,
  LegacyImportStateStrategy,
} from "../../shared/desktop-api";
import { ActionButton } from "./atoms/ActionButton";
import { StatusPill } from "./atoms/StatusPill";
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
      actions={preview ? (
        <ActionButton variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
          <X className="size-3.5" aria-hidden="true" />
          Cancel preview
        </ActionButton>
      ) : null}
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-muted/25 p-4">
          <div className="flex items-start gap-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
              <ArchiveRestore className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">Import workspace metadata, not infrastructure secrets</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                Import repository/workspace metadata from an existing <code className="font-mono text-foreground">sourcenerve.toml</code>. Desktop keeps its packaged server, OAuth, Public MCP and Cloudflare policy; legacy secrets are never copied from TOML, shell history, or process environment.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <ActionButton variant="secondary" size="sm" disabled={busy} onClick={() => void chooseConfig()}>
              <FileCog className="size-3.5" aria-hidden="true" />
              {busy ? "Inspecting…" : "Choose sourcenerve.toml"}
            </ActionButton>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-danger/20 bg-danger/8 px-3 py-2 text-xs leading-5 text-danger" role="alert">{error}</div>
        ) : null}

        {preview ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">{preview.workspaces.length} workspace(s) detected</p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={preview.configPath}>{compactPath(preview.configPath)}</p>
              </div>
              <StatusPill tone={invalidWorkspaces.length === 0 ? "ready" : "warning"} dot>
                {invalidWorkspaces.length === 0 ? "Repositories valid" : `${invalidWorkspaces.length} need repair`}
              </StatusPill>
            </div>

            <div className="grid gap-2">
              {preview.workspaces.map((workspace) => {
                const ready = workspace.validation.state === "ready";
                return (
                  <article key={workspace.id} className="rounded-xl border border-border bg-muted/20 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground">{workspace.name}</p>
                        <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{workspace.id} · {workspace.access} · {workspace.remote}/{workspace.defaultBranch}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground" title={workspace.root}>{compactPath(workspace.root)}</p>
                      </div>
                      <StatusPill tone={ready ? "ready" : "warning"} dot>{ready ? "Ready" : "Invalid"}</StatusPill>
                    </div>
                    {workspace.validation.message ? <p className="mt-2 rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-2 text-[10px] leading-4 text-warning">{workspace.validation.message}</p> : null}
                  </article>
                );
              })}
            </div>

            <div className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">Existing state</p>
                <p className="mt-1 text-[10px] leading-5 text-muted-foreground">{preview.state.status} · schema {preview.state.schemaVersion ?? "unknown"} / supported {preview.state.supportedSchemaVersion}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground" title={preview.state.path}>{compactPath(preview.state.path)}</p>
                {preview.state.message ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{preview.state.message}</p> : null}
              </div>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">State strategy</span>
                <select className={selectClass} value={strategy} disabled={busy} onChange={(event) => setStrategy(event.target.value as LegacyImportStateStrategy)}>
                  {preview.state.allowedStrategies.map((value) => <option key={value} value={value}>{strategyLabel(value)}</option>)}
                </select>
              </label>
            </div>

            {preview.legacyProduct.warnings.length > 0 ? (
              <NoticeBlock title="Legacy product settings will not override Desktop defaults" tone="warning" items={preview.legacyProduct.warnings} />
            ) : null}

            <NoticeBlock
              title="Reconnect after import"
              items={[
                "Desktop local bearer is re-provisioned from encrypted Desktop storage.",
                ...(preview.reconnect.auth0 ? ["Sign in to the SourceNerve account again through Auth0."] : []),
                ...preview.reconnect.providers.map((provider) => `Reconnect ${provider === "github" ? "GitHub" : "GitLab"} through Connections.`),
                "Shell environment and shell history are not inspected.",
              ]}
            />

            <div className="rounded-xl border border-primary/15 bg-primary/6 p-4">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <p className="text-xs font-semibold text-foreground">A backup is created before import.</p>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">The original config and legacy state remain untouched until the migration commits successfully.</p>
                </div>
              </div>
              <div className="mt-4">
                <ActionButton size="sm" disabled={busy || invalidWorkspaces.length > 0} onClick={() => void applyImport()}>
                  <ArchiveRestore className="size-3.5" aria-hidden="true" />
                  {busy ? "Migrating…" : "Backup and import"}
                </ActionButton>
              </div>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="rounded-xl border border-success/20 bg-success/8 p-4" role="status">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-success">Migration completed</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{result.importedWorkspaces} workspace(s) imported using {strategyLabel(result.stateStrategy)}.</p>
                <p className="mt-1 break-all text-[10px] text-muted-foreground">Backup: <code className="font-mono text-foreground" title={result.backupPath}>{compactPath(result.backupPath)}</code></p>
                {result.stateStrategy === "move" && !result.sourceStateRemoved ? <p className="mt-2 text-[11px] leading-5 text-muted-foreground">The source state was retained as an extra safety copy.</p> : null}
                <details className="mt-3 rounded-lg border border-border bg-card/55 px-3 py-2">
                  <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground"><Undo2 className="size-3.5" aria-hidden="true" />Rollback instructions</summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-[10px] leading-5 text-muted-foreground">{result.rollback.map((step) => <li key={step}>{step}</li>)}</ol>
                </details>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </SurfaceCard>
  );
}

function NoticeBlock({ title, items, tone = "neutral" }: { title: string; items: string[]; tone?: "neutral" | "warning" }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === "warning" ? "border-warning/20 bg-warning/8" : "border-border bg-muted/20"}`}>
      <p className={`text-xs font-semibold ${tone === "warning" ? "text-warning" : "text-foreground"}`}>{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[10px] leading-5 text-muted-foreground">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}

function strategyLabel(value: LegacyImportStateStrategy): string {
  if (value === "copy") return "Copy state into Desktop";
  if (value === "move") return "Move state into Desktop";
  if (value === "reference") return "Reference existing state in place";
  return "Start clean and re-index";
}

function compactPath(value: string): string {
  if (value.length <= 72) return value;
  return `${value.slice(0, 32)}…${value.slice(-36)}`;
}
