import { useMemo, useState } from "react";

import type {
  LegacyImportPreview,
  LegacyImportResult,
  LegacyImportStateStrategy,
} from "../../shared/desktop-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

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
    <Panel title="Existing setup migration" eyebrow="Current SourceNerve users">
      <div className="migration-stack">
        <p className="muted">
          Import repository/workspace metadata from an existing <code>sourcenerve.toml</code>.
          Desktop keeps its packaged server, OAuth, Public MCP and Cloudflare policy; legacy secrets
          are never copied from TOML, shell history, or process environment.
        </p>
        <div className="workspace-actions">
          <button className="button button--quiet" type="button" disabled={busy} onClick={() => void chooseConfig()}>
            {busy ? "Inspecting…" : "Choose sourcenerve.toml"}
          </button>
          {preview ? (
            <button className="button button--quiet" type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel preview
            </button>
          ) : null}
        </div>

        {error ? <div className="workspace-error" role="alert">{error}</div> : null}

        {preview ? (
          <div className="migration-preview">
            <div className="migration-heading">
              <div>
                <strong>{preview.workspaces.length} workspace(s) detected</strong>
                <small title={preview.configPath}>{compactPath(preview.configPath)}</small>
              </div>
              <StatusBadge
                label={invalidWorkspaces.length === 0 ? "Repositories valid" : `${invalidWorkspaces.length} need repair`}
                tone={invalidWorkspaces.length === 0 ? "ready" : "warning"}
              />
            </div>

            <div className="migration-workspaces">
              {preview.workspaces.map((workspace) => (
                <div key={workspace.id} className="migration-workspace">
                  <div>
                    <strong>{workspace.name}</strong>
                    <small>{workspace.id} · {workspace.access} · {workspace.remote}/{workspace.defaultBranch}</small>
                    <small title={workspace.root}>{compactPath(workspace.root)}</small>
                  </div>
                  <StatusBadge
                    label={workspace.validation.state === "ready" ? "Ready" : "Invalid"}
                    tone={workspace.validation.state === "ready" ? "ready" : "warning"}
                  />
                  {workspace.validation.message ? <p className="workspace-validation-error">{workspace.validation.message}</p> : null}
                </div>
              ))}
            </div>

            <div className="migration-state">
              <div>
                <strong>Existing state</strong>
                <small>
                  {preview.state.status} · schema {preview.state.schemaVersion ?? "unknown"} / supported {preview.state.supportedSchemaVersion}
                </small>
                <small title={preview.state.path}>{compactPath(preview.state.path)}</small>
                {preview.state.message ? <p className="muted">{preview.state.message}</p> : null}
              </div>
              <label>
                <span>State strategy</span>
                <select
                  value={strategy}
                  disabled={busy}
                  onChange={(event) => setStrategy(event.target.value as LegacyImportStateStrategy)}
                >
                  {preview.state.allowedStrategies.map((value) => (
                    <option key={value} value={value}>{strategyLabel(value)}</option>
                  ))}
                </select>
              </label>
            </div>

            {preview.legacyProduct.warnings.length > 0 ? (
              <div className="migration-warnings">
                <strong>Legacy product settings will not override Desktop defaults</strong>
                <ul>
                  {preview.legacyProduct.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            ) : null}

            <div className="migration-warnings">
              <strong>Reconnect after import</strong>
              <ul>
                <li>Desktop local bearer is re-provisioned from encrypted Desktop storage.</li>
                {preview.reconnect.auth0 ? <li>Sign in to the SourceNerve account again through Auth0.</li> : null}
                {preview.reconnect.providers.map((provider) => <li key={provider}>Reconnect {provider === "github" ? "GitHub" : "GitLab"} through Connections.</li>)}
                <li>Shell environment and shell history are not inspected.</li>
              </ul>
            </div>

            <div className="migration-confirm">
              <strong>A backup is created before import.</strong>
              <span>The original config and legacy state remain untouched until the migration commits successfully.</span>
              <button
                className="button"
                type="button"
                disabled={busy || invalidWorkspaces.length > 0}
                onClick={() => void applyImport()}
              >
                {busy ? "Migrating…" : "Backup and import"}
              </button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="migration-result" role="status">
            <strong>Migration completed</strong>
            <p>{result.importedWorkspaces} workspace(s) imported using {strategyLabel(result.stateStrategy)}.</p>
            <p>Backup: <code title={result.backupPath}>{compactPath(result.backupPath)}</code></p>
            {result.stateStrategy === "move" && !result.sourceStateRemoved ? (
              <p className="muted">The source state was retained as an extra safety copy.</p>
            ) : null}
            <details>
              <summary>Rollback instructions</summary>
              <ol>{result.rollback.map((step) => <li key={step}>{step}</li>)}</ol>
            </details>
          </div>
        ) : null}
      </div>
    </Panel>
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
