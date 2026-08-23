import { useEffect, useMemo, useState } from "react";

import type {
  McpExtensionAuthType,
  McpExtensionInstallInput,
  McpExtensionToolView,
  McpExtensionView,
  McpToolApproval,
} from "../../shared/mcp-extension-api";
import { ActionButton } from "./atoms/ActionButton";
import { InlineNotice } from "./molecules/InlineNotice";
import { Panel } from "./Panel";

interface InstallDraft {
  id: string;
  name: string;
  version: string;
  namespace: string;
  source: string;
  transport: "stdio" | "streamable-http";
  command: string;
  args: string;
  url: string;
  authType: McpExtensionAuthType;
  credential: string;
  oauthAuthorizationEndpoint: string;
  oauthTokenEndpoint: string;
  oauthClientId: string;
  oauthScopes: string;
  oauthRevokeEndpoint: string;
  oauthResource: string;
}

const EMPTY_DRAFT: InstallDraft = {
  id: "",
  name: "",
  version: "1.0.0",
  namespace: "",
  source: "manual",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  authType: "none",
  credential: "",
  oauthAuthorizationEndpoint: "",
  oauthTokenEndpoint: "",
  oauthClientId: "",
  oauthScopes: "",
  oauthRevokeEndpoint: "",
  oauthResource: "",
};

export function McpExtensionsScreen() {
  const [extensions, setExtensions] = useState<McpExtensionView[]>([]);
  const [tools, setTools] = useState<Record<string, McpExtensionToolView[]>>({});
  const [draft, setDraft] = useState<InstallDraft>(EMPTY_DRAFT);
  const [showInstall, setShowInstall] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
  }, []);

  const activeCount = useMemo(
    () => extensions.filter((extension) => extension.enabled).length,
    [extensions],
  );

  async function refresh(): Promise<void> {
    try {
      const result = await window.sourcenerveMcpExtensions.list();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setExtensions(result.value);
      setError(null);
    } catch (refreshError) {
      setError(invokeError(refreshError, "MCP extension state could not be loaded."));
    }
  }

  async function install(): Promise<void> {
    setBusy("install");
    setError(null);
    setNotice(null);
    try {
      const input: McpExtensionInstallInput = {
        id: draft.id.trim(),
        name: draft.name.trim(),
        version: draft.version.trim(),
        namespace: draft.namespace.trim(),
        source: draft.source.trim(),
        transport:
          draft.transport === "stdio"
            ? {
                transport: "stdio",
                command: draft.command.trim(),
                args: parseArgs(draft.args),
              }
            : { transport: "streamable-http", url: draft.url.trim() },
        authType: draft.authType,
        ...(draft.authType === "bearer" && draft.credential
          ? { credential: draft.credential }
          : {}),
        ...(draft.authType === "oauth"
          ? {
              oauth: {
                authorizationEndpoint: draft.oauthAuthorizationEndpoint.trim(),
                tokenEndpoint: draft.oauthTokenEndpoint.trim(),
                clientId: draft.oauthClientId.trim(),
                scopes: parseScopes(draft.oauthScopes),
                ...(draft.oauthRevokeEndpoint.trim()
                  ? { revokeEndpoint: draft.oauthRevokeEndpoint.trim() }
                  : {}),
                ...(draft.oauthResource.trim() ? { resource: draft.oauthResource.trim() } : {}),
              },
            }
          : {}),
        updateChannel: "stable",
      };
      const result = await window.sourcenerveMcpExtensions.install(input);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setDraft(EMPTY_DRAFT);
      setShowInstall(false);
      setNotice(
        `${result.value.name} installed. Its discovered tools stay blocked until you explicitly permit them.`,
      );
      await refresh();
    } catch (actionError) {
      setError(invokeError(actionError, "MCP extension could not be installed."));
    } finally {
      setBusy(null);
    }
  }

  async function lifecycle(
    extension: McpExtensionView,
    action: "enable" | "disable" | "restart" | "remove",
  ): Promise<void> {
    if (
      action === "remove" &&
      !window.confirm(
        extension.exposedTools > 0
          ? `Remove ${extension.name}? ${extension.exposedTools} tool(s) are currently exposed through SourceNerve.`
          : `Remove ${extension.name}? Its registry record and stored credentials will be removed.`,
      )
    ) {
      return;
    }
    setBusy(`${extension.id}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const api = window.sourcenerveMcpExtensions;
      if (action === "enable") {
        const result = await api.enable(extension.id);
        if (!result.ok) return setError(result.error.message);
      } else if (action === "disable") {
        const result = await api.disable(extension.id);
        if (!result.ok) return setError(result.error.message);
      } else if (action === "restart") {
        const result = await api.restart(extension.id);
        if (!result.ok) return setError(result.error.message);
        setTools((current) => ({ ...current, [extension.id]: result.value }));
      } else {
        const result = await api.remove(extension.id);
        if (!result.ok) return setError(result.error.message);
        setTools((current) => {
          const next = { ...current };
          delete next[extension.id];
          return next;
        });
      }
      setNotice(`${extension.name}: ${action} completed.`);
      await refresh();
    } catch (actionError) {
      setError(invokeError(actionError, `MCP extension ${action} failed.`));
    } finally {
      setBusy(null);
    }
  }

  async function toggleTools(extensionId: string): Promise<void> {
    if (tools[extensionId]) {
      setTools((current) => {
        const next = { ...current };
        delete next[extensionId];
        return next;
      });
      return;
    }
    setBusy(`${extensionId}:tools`);
    setError(null);
    try {
      const result = await window.sourcenerveMcpExtensions.listTools(extensionId);
      if (result.ok) setTools((current) => ({ ...current, [extensionId]: result.value }));
      else setError(result.error.message);
    } finally {
      setBusy(null);
    }
  }

  async function updatePolicy(
    tool: McpExtensionToolView,
    enabled: boolean,
    approval: McpToolApproval,
  ): Promise<void> {
    const key = `${tool.extensionId}:${tool.originalName}:policy`;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sourcenerveMcpExtensions.updateToolPolicy({
        extensionId: tool.extensionId,
        toolName: tool.originalName,
        enabled,
        approval,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setTools((current) => ({
        ...current,
        [tool.extensionId]: (current[tool.extensionId] ?? []).map((item) =>
          item.originalName === tool.originalName ? result.value : item,
        ),
      }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function approveNext(tool: McpExtensionToolView): Promise<void> {
    setBusy(`${tool.publicName}:approve`);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sourcenerveMcpExtensions.approveNext(tool.publicName);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(
        `${tool.publicName} is approved for one execution within ${result.value.expiresInSeconds} seconds. The approval is consumed by the next call.`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function saveCredential(extension: McpExtensionView): Promise<void> {
    const credential = credentialDrafts[extension.id] ?? "";
    setBusy(`${extension.id}:credential`);
    setError(null);
    setNotice(null);
    try {
      const result = await window.sourcenerveMcpExtensions.setCredential({
        extensionId: extension.id,
        credential,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCredentialDrafts((current) => ({ ...current, [extension.id]: "" }));
      setNotice(
        `${extension.name} credential stored in OS-backed secure storage and materialized only to the local gateway.`,
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function clearCredential(extension: McpExtensionView): Promise<void> {
    if (!window.confirm(`Clear the stored credential for ${extension.name}?`)) return;
    setBusy(`${extension.id}:credential-clear`);
    setError(null);
    try {
      const result = await window.sourcenerveMcpExtensions.clearCredential(extension.id);
      if (!result.ok) setError(result.error.message);
      else await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function oauthAction(
    extension: McpExtensionView,
    action: "connect" | "refresh" | "revoke",
  ): Promise<void> {
    if (
      action === "revoke" &&
      !window.confirm(
        `Revoke the OAuth connection for ${extension.name}? The extension will be disabled and its stored access/refresh tokens will be removed.`,
      )
    ) {
      return;
    }
    setBusy(`${extension.id}:oauth-${action}`);
    setError(null);
    setNotice(null);
    try {
      const api = window.sourcenerveMcpExtensions;
      const result =
        action === "connect"
          ? await api.connectOAuth(extension.id)
          : action === "refresh"
            ? await api.refreshOAuth(extension.id)
            : await api.revokeOAuth(extension.id);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setNotice(result.value.message);
      await refresh();
    } catch (actionError) {
      setError(invokeError(actionError, `OAuth ${action} failed.`));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="MCP Extensions">
      <Panel
        title="MCP Extensions"
        eyebrow="SourceNerve Gateway"
        actions={
          <ActionButton
            size="sm"
            variant={showInstall ? "secondary" : "default"}
            onClick={() => setShowInstall((value) => !value)}
          >
            {showInstall ? "Close installer" : "Install extension"}
          </ActionButton>
        }
      >
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{extensions.length} installed</span>
          <span>·</span>
          <span>{activeCount} enabled</span>
          <span>·</span>
          <span>ChatGPT sees only enabled + explicitly permitted tools</span>
        </div>
      </Panel>

      {error ? (
        <InlineNotice tone="danger" title="MCP extension action failed" role="alert">
          {error}
        </InlineNotice>
      ) : null}
      {notice ? (
        <InlineNotice tone="info" title="MCP extension updated">
          {notice}
        </InlineNotice>
      ) : null}

      {showInstall ? (
        <InstallPanel
          draft={draft}
          busy={busy === "install"}
          onChange={setDraft}
          onInstall={() => void install()}
        />
      ) : null}

      {extensions.length === 0 ? (
        <Panel title="No MCP extensions installed" eyebrow="Default deny">
          <p className="text-sm text-muted-foreground">
            Add a local stdio server or a remote Streamable HTTP MCP. New tools are discovered behind the SourceNerve policy boundary and start disabled + blocked.
          </p>
        </Panel>
      ) : (
        extensions.map((extension) => (
          <ExtensionPanel
            key={extension.id}
            extension={extension}
            tools={tools[extension.id]}
            busy={busy}
            credential={credentialDrafts[extension.id] ?? ""}
            onCredentialChange={(value) =>
              setCredentialDrafts((current) => ({ ...current, [extension.id]: value }))
            }
            onLifecycle={(action) => void lifecycle(extension, action)}
            onToggleTools={() => void toggleTools(extension.id)}
            onPolicy={(tool, enabled, approval) => void updatePolicy(tool, enabled, approval)}
            onApprove={(tool) => void approveNext(tool)}
            onSaveCredential={() => void saveCredential(extension)}
            onClearCredential={() => void clearCredential(extension)}
            onOAuth={(action) => void oauthAction(extension, action)}
          />
        ))
      )}
    </section>
  );
}

function InstallPanel({
  draft,
  busy,
  onChange,
  onInstall,
}: {
  draft: InstallDraft;
  busy: boolean;
  onChange(value: InstallDraft): void;
  onInstall(): void;
}) {
  return (
    <Panel title="Install MCP extension" eyebrow="Review before enabling">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Extension ID">
          <input
            className={inputClass}
            value={draft.id}
            placeholder="memory"
            onChange={(event) => onChange({ ...draft, id: event.target.value })}
          />
        </Field>
        <Field label="Namespace">
          <input
            className={inputClass}
            value={draft.namespace}
            placeholder="memory"
            onChange={(event) => onChange({ ...draft, namespace: event.target.value })}
          />
        </Field>
        <Field label="Display name">
          <input
            className={inputClass}
            value={draft.name}
            placeholder="Codebase Memory"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </Field>
        <Field label="Version">
          <input
            className={inputClass}
            value={draft.version}
            onChange={(event) => onChange({ ...draft, version: event.target.value })}
          />
        </Field>
        <Field label="Transport">
          <select
            className={inputClass}
            value={draft.transport}
            onChange={(event) =>
              onChange({ ...draft, transport: event.target.value as InstallDraft["transport"] })
            }
          >
            <option value="stdio">Local stdio</option>
            <option value="streamable-http">Streamable HTTP</option>
          </select>
        </Field>
        <Field label="Authentication">
          <select
            className={inputClass}
            value={draft.authType}
            onChange={(event) =>
              onChange({
                ...draft,
                authType: event.target.value as McpExtensionAuthType,
                credential: "",
              })
            }
          >
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="oauth">OAuth 2.1 / PKCE</option>
          </select>
        </Field>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {draft.transport === "stdio" ? (
          <>
            <Field label="Executable / command">
              <input
                className={inputClass}
                value={draft.command}
                placeholder="npx"
                onChange={(event) => onChange({ ...draft, command: event.target.value })}
              />
            </Field>
            <Field label="Arguments (one per line)">
              <textarea
                className={`${inputClass} min-h-24 resize-y py-2`}
                value={draft.args}
                placeholder={"-y\n@vendor/mcp-server"}
                onChange={(event) => onChange({ ...draft, args: event.target.value })}
              />
            </Field>
          </>
        ) : (
          <Field label="Remote MCP URL">
            <input
              className={inputClass}
              value={draft.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => onChange({ ...draft, url: event.target.value })}
            />
          </Field>
        )}
        <Field label="Source / publisher reference">
          <input
            className={inputClass}
            value={draft.source}
            placeholder="https://github.com/vendor/server"
            onChange={(event) => onChange({ ...draft, source: event.target.value })}
          />
        </Field>
        {draft.authType === "bearer" ? (
          <Field label="Bearer token">
            <input
              type="password"
              autoComplete="off"
              className={inputClass}
              value={draft.credential}
              onChange={(event) => onChange({ ...draft, credential: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      {draft.authType === "oauth" ? (
        <div className="mt-4 grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4 md:grid-cols-2">
          <Field label="Authorization endpoint">
            <input
              className={inputClass}
              value={draft.oauthAuthorizationEndpoint}
              placeholder="https://provider.example.com/oauth/authorize"
              onChange={(event) =>
                onChange({ ...draft, oauthAuthorizationEndpoint: event.target.value })
              }
            />
          </Field>
          <Field label="Token endpoint">
            <input
              className={inputClass}
              value={draft.oauthTokenEndpoint}
              placeholder="https://provider.example.com/oauth/token"
              onChange={(event) => onChange({ ...draft, oauthTokenEndpoint: event.target.value })}
            />
          </Field>
          <Field label="Public client ID">
            <input
              className={inputClass}
              value={draft.oauthClientId}
              placeholder="desktop-public-client"
              onChange={(event) => onChange({ ...draft, oauthClientId: event.target.value })}
            />
          </Field>
          <Field label="Scopes (space or newline separated)">
            <textarea
              className={`${inputClass} min-h-20 resize-y py-2`}
              value={draft.oauthScopes}
              placeholder="openid profile mcp:tools"
              onChange={(event) => onChange({ ...draft, oauthScopes: event.target.value })}
            />
          </Field>
          <Field label="Revocation endpoint (optional)">
            <input
              className={inputClass}
              value={draft.oauthRevokeEndpoint}
              placeholder="https://provider.example.com/oauth/revoke"
              onChange={(event) => onChange({ ...draft, oauthRevokeEndpoint: event.target.value })}
            />
          </Field>
          <Field label="OAuth resource (optional)">
            <input
              className={inputClass}
              value={draft.oauthResource}
              placeholder="https://mcp.example.com/"
              onChange={(event) => onChange({ ...draft, oauthResource: event.target.value })}
            />
          </Field>
          <p className="text-xs text-muted-foreground md:col-span-2">
            SourceNerve opens the system browser with PKCE S256 and receives the authorization response on a temporary 127.0.0.1 loopback port. Access and refresh tokens never pass through the Renderer.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="max-w-2xl text-xs text-muted-foreground">
          Raw credentials are never returned to the Renderer. SourceNerve stores downstream secrets with OS-backed secure storage, while the registry persists only an opaque secret reference.
        </p>
        <ActionButton disabled={busy} onClick={onInstall}>
          {busy ? "Installing…" : "Install"}
        </ActionButton>
      </div>
    </Panel>
  );
}

function ExtensionPanel({
  extension,
  tools,
  busy,
  credential,
  onCredentialChange,
  onLifecycle,
  onToggleTools,
  onPolicy,
  onApprove,
  onSaveCredential,
  onClearCredential,
  onOAuth,
}: {
  extension: McpExtensionView;
  tools?: McpExtensionToolView[];
  busy: string | null;
  credential: string;
  onCredentialChange(value: string): void;
  onLifecycle(action: "enable" | "disable" | "restart" | "remove"): void;
  onToggleTools(): void;
  onPolicy(tool: McpExtensionToolView, enabled: boolean, approval: McpToolApproval): void;
  onApprove(tool: McpExtensionToolView): void;
  onSaveCredential(): void;
  onClearCredential(): void;
  onOAuth(action: "connect" | "refresh" | "revoke"): void;
}) {
  const working = busy?.startsWith(`${extension.id}:`) ?? false;
  const statusTone =
    extension.status === "error"
      ? "text-danger"
      : extension.enabled
        ? "text-success"
        : "text-muted-foreground";
  const credentialStatus =
    extension.authType === "none"
      ? "Not required"
      : extension.authType === "oauth"
        ? extension.oauthConnected
          ? "OAuth active"
          : extension.oauthConfigured
            ? "OAuth ready"
            : "OAuth config missing"
        : extension.credentialConfigured
          ? extension.credentialMaterialized
            ? "Secure + active"
            : "Secure"
          : "Missing";

  return (
    <Panel
      title={extension.name}
      eyebrow={`${extension.namespace} · ${extension.transport.transport} · v${extension.version}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <ActionButton size="sm" variant="secondary" disabled={working} onClick={onToggleTools}>
            {tools ? "Hide tools" : `Tools (${extension.discoveredTools})`}
          </ActionButton>
          {extension.enabled ? (
            <ActionButton
              size="sm"
              variant="secondary"
              disabled={working}
              onClick={() => onLifecycle("disable")}
            >
              Disable
            </ActionButton>
          ) : (
            <ActionButton size="sm" disabled={working} onClick={() => onLifecycle("enable")}>
              Enable
            </ActionButton>
          )}
          <ActionButton
            size="sm"
            variant="secondary"
            disabled={working || !extension.enabled}
            onClick={() => onLifecycle("restart")}
          >
            Restart
          </ActionButton>
          <ActionButton
            size="sm"
            variant="destructive"
            disabled={working}
            onClick={() => onLifecycle("remove")}
          >
            Remove
          </ActionButton>
        </div>
      }
    >
      <div className="grid gap-3 text-xs md:grid-cols-4">
        <Metric label="Status" value={extension.status} className={statusTone} />
        <Metric label="Discovered" value={String(extension.discoveredTools)} />
        <Metric label="Exposed to ChatGPT" value={String(extension.exposedTools)} />
        <Metric label="Credential" value={credentialStatus} />
      </div>
      {extension.lastError ? (
        <div className="mt-3 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {extension.lastError}
        </div>
      ) : null}

      {extension.authType === "bearer" ? (
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border/70 pt-4">
          <Field label="Bearer token" compact>
            <input
              type="password"
              autoComplete="off"
              className={`${inputClass} min-w-72`}
              value={credential}
              onChange={(event) => onCredentialChange(event.target.value)}
              placeholder={extension.credentialConfigured ? "Replace stored credential" : "Enter credential"}
            />
          </Field>
          <ActionButton size="sm" disabled={working || !credential} onClick={onSaveCredential}>
            Store securely
          </ActionButton>
          {extension.credentialConfigured ? (
            <ActionButton size="sm" variant="ghost" disabled={working} onClick={onClearCredential}>
              Clear
            </ActionButton>
          ) : null}
        </div>
      ) : null}

      {extension.authType === "oauth" ? (
        <div className="mt-4 space-y-3 border-t border-border/70 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              size="sm"
              disabled={working || !extension.oauthConfigured}
              onClick={() => onOAuth("connect")}
            >
              {extension.oauthConnected ? "Reconnect" : "Connect OAuth"}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="secondary"
              disabled={working || !extension.oauthConnected}
              onClick={() => onOAuth("refresh")}
            >
              Refresh token
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              disabled={working || !extension.oauthConnected}
              onClick={() => onOAuth("revoke")}
            >
              Revoke
            </ActionButton>
          </div>
          <p className="text-xs text-muted-foreground">
            {extension.oauthConnected
              ? `Connected${extension.oauthExpiresAt ? ` · access token expires ${formatExpiry(extension.oauthExpiresAt)}` : ""}. Refresh tokens remain in OS-backed secure storage; refreshed access tokens are materialized only in gateway RAM.`
              : "OAuth uses a temporary localhost loopback callback with PKCE S256. Enable is blocked until Connect completes successfully."}
          </p>
        </div>
      ) : null}

      {tools ? (
        <div className="mt-4 space-y-2 border-t border-border/70 pt-4">
          {tools.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tools discovered yet. Enable or restart the extension to run initialize + tools/list.
            </p>
          ) : (
            tools.map((tool) => (
              <ToolRow
                key={tool.originalName}
                tool={tool}
                busy={
                  busy === `${tool.extensionId}:${tool.originalName}:policy` ||
                  busy === `${tool.publicName}:approve`
                }
                onPolicy={onPolicy}
                onApprove={onApprove}
              />
            ))
          )}
        </div>
      ) : null}
    </Panel>
  );
}

function ToolRow({
  tool,
  busy,
  onPolicy,
  onApprove,
}: {
  tool: McpExtensionToolView;
  busy: boolean;
  onPolicy(tool: McpExtensionToolView, enabled: boolean, approval: McpToolApproval): void;
  onApprove(tool: McpExtensionToolView): void;
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/25 p-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <code className="truncate text-xs font-semibold text-foreground">{tool.publicName}</code>
          {tool.classification.readOnly === true ? <Badge>read-only</Badge> : null}
          {tool.classification.destructive === true ? <Badge>destructive</Badge> : null}
          {tool.classification.openWorld === true ? <Badge>open-world</Badge> : null}
        </div>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {tool.description ?? tool.originalName}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={tool.enabled}
            disabled={busy}
            onChange={(event) =>
              onPolicy(tool, event.target.checked, event.target.checked ? tool.approval : "blocked")
            }
          />
          Enabled
        </label>
        <select
          className={`${inputClass} h-9 w-32`}
          value={tool.approval}
          disabled={busy || !tool.enabled}
          onChange={(event) => onPolicy(tool, true, event.target.value as McpToolApproval)}
        >
          <option value="automatic">Automatic</option>
          <option value="ask">Ask</option>
          <option value="blocked">Blocked</option>
        </select>
        {tool.enabled && tool.approval === "ask" ? (
          <ActionButton
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onApprove(tool)}
          >
            Approve next call
          </ActionButton>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <label className={compact ? "space-y-1" : "block space-y-1.5"}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Metric({
  label,
  value,
  className = "text-foreground",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
      <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </span>
      <strong className={`mt-1 block truncate text-xs ${className}`}>{value}</strong>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function parseArgs(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseScopes(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatExpiry(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString();
}

function invokeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const inputClass =
  "h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/15 disabled:opacity-60";
