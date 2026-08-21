import { useEffect, useState } from "react";

import type {
  PluginDomainChallengeResult,
  PluginVerificationRunResult,
  PluginVerificationView,
} from "../../shared/plugin-verification-api";
import { Panel } from "./Panel";
import { StatusBadge } from "./StatusBadge";

export function PluginVerificationPanel() {
  const [view, setView] = useState<PluginVerificationView | null>(null);
  const [run, setRun] = useState<PluginVerificationRunResult | null>(null);
  const [challengeToken, setChallengeToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setBusy("state");
    setError(null);
    const result = await window.sourcenerveDesktop.getPluginVerificationState();
    if (result.ok) setView(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function verify(): Promise<void> {
    setBusy("verify");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.verifyPluginConnection();
    if (result.ok) {
      setRun(result.value);
      setView(result.value.view);
      setNotice(result.value.view.status === "ready-to-connect"
        ? "SourceNerve is ready for the manual ChatGPT connection step. Desktop does not claim that ChatGPT is connected until an external product signal exists."
        : "Verification completed. Fix the failing layer(s) below and run Verify again.");
    } else setError(result.error.message);
    setBusy(null);
  }

  async function copyFields(): Promise<void> {
    setBusy("copy");
    setError(null);
    const result = await window.sourcenerveDesktop.copyPluginSetupFields();
    if (result.ok) setNotice(`Copied ${result.value.characters} non-secret setup characters.`);
    else setError(result.error.message);
    setBusy(null);
  }

  async function openChatGpt(): Promise<void> {
    setBusy("open");
    setError(null);
    const result = await window.sourcenerveDesktop.openChatGptPluginSetup();
    if (result.ok) setNotice("Opened the packaged ChatGPT setup URL in your browser. Desktop will not click, attest, publish, or configure the ChatGPT UI for you.");
    else setError(result.error.message);
    setBusy(null);
  }

  async function exportIcon(): Promise<void> {
    setBusy("icon");
    setError(null);
    const result = await window.sourcenerveDesktop.exportPluginIcon();
    if (result.ok && result.value.saved) setNotice(`Exported ${result.value.bytes.toLocaleString()} bytes of the packaged plugin icon.`);
    else if (result.ok) setNotice("Icon export was cancelled.");
    else setError(result.error.message);
    setBusy(null);
  }

  async function setChallenge(): Promise<void> {
    const token = challengeToken;
    if (!token) return;
    setChallengeToken("");
    setBusy("challenge-set");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.setPluginDomainChallenge({ token });
    if (result.ok) applyChallengeResult(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function verifyChallenge(): Promise<void> {
    setBusy("challenge-verify");
    setError(null);
    const result = await window.sourcenerveDesktop.verifyPluginDomainChallenge();
    if (result.ok) applyChallengeResult(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function removeChallenge(): Promise<void> {
    if (!window.confirm("Remove the current public-domain challenge from SourceNerve secure storage and reload the managed daemon?")) return;
    setChallengeToken("");
    setBusy("challenge-remove");
    setError(null);
    const result = await window.sourcenerveDesktop.removePluginDomainChallenge();
    if (result.ok) applyChallengeResult(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  function applyChallengeResult(result: PluginDomainChallengeResult): void {
    setNotice(result.message);
    setView((current) => current ? {
      ...current,
      challenge: {
        configured: result.configured,
        verified: result.verified,
        ...(result.lastVerifiedAt ? { lastVerifiedAt: result.lastVerifiedAt } : {}),
      },
    } : current);
  }

  const fields = view?.fields;
  const account = view?.account;
  const mcpServerUrl = view?.publicMcp.publicMcpUrl;

  return (
    <Panel title="ChatGPT connection" eyebrow="Same SourceNerve Auth0 account · product infrastructure is read-only">
      <div className="plugin-verification-callout">
        <strong>Desktop verifies SourceNerve; it does not automate ChatGPT.</strong>
        <span>OAuth issuer/resource/scopes, legal URLs and plugin metadata come from the packaged product profile. The MCP Server URL comes from this installation&apos;s managed Public MCP enrollment.</span>
      </div>

      {error ? <p className="plugin-verification-error" role="alert">{error}</p> : null}
      {notice ? <p className="plugin-verification-notice">{notice}</p> : null}

      <div className="plugin-verification-status-row">
        <StatusBadge
          label={view?.status === "ready-to-connect" ? "Ready to connect" : "Needs attention"}
          tone={view?.status === "ready-to-connect" ? "ready" : "warning"}
        />
        <StatusBadge
          label={`Account: ${account?.status ?? "unavailable"}`}
          tone={account?.status === "authenticated" ? "ready" : "warning"}
        />
        <StatusBadge
          label={`Public MCP: ${view?.publicMcp.state ?? "unavailable"}`}
          tone={view?.publicMcp.state === "ready" ? "ready" : "warning"}
        />
      </div>

      {account?.identity ? (
        <div className="plugin-verification-account">
          <strong>{account.identity.email ?? account.identity.name ?? account.identity.subject}</strong>
          <span>{account.workspaceGrants.length} effective workspace grant(s)</span>
          <div className="plugin-verification-grants">
            {account.workspaceGrants.map((grant) => <code key={`${grant.workspace}:${grant.access}`}>{grant.workspace} · {grant.access}</code>)}
          </div>
        </div>
      ) : null}

      <div className="plugin-verification-actions">
        <button className="button" type="button" disabled={busy === "verify"} onClick={() => void verify()}>
          {busy === "verify" ? "Verifying…" : "Verify SourceNerve connection"}
        </button>
        <button className="button button--quiet" type="button" disabled={busy === "state"} onClick={() => void refresh()}>Refresh state</button>
        <button className="button button--quiet" type="button" disabled={!fields || !mcpServerUrl || busy === "copy"} onClick={() => void copyFields()}>Copy setup fields</button>
        <button className="button button--quiet" type="button" disabled={!fields || busy === "open"} onClick={() => void openChatGpt()}>Open ChatGPT setup</button>
        <button className="button button--quiet" type="button" disabled={!fields || busy === "icon"} onClick={() => void exportIcon()}>Export icon</button>
      </div>

      {view ? (
        <div className="plugin-verification-checks">
          {view.checks.map((item) => (
            <article key={item.id} className={`plugin-check plugin-check--${item.state}`}>
              <div><strong>{item.label}</strong><StatusBadge label={item.state} tone={item.state === "ready" ? "ready" : item.state === "warning" || item.state === "not-checked" ? "warning" : "warning"} /></div>
              <p>{item.message}</p>
            </article>
          ))}
        </div>
      ) : null}

      {run ? (
        <div className="plugin-verification-run-meta">
          {run.toolCount !== undefined ? <span>Tools discovered: <strong>{run.toolCount}</strong></span> : null}
          {run.serverName ? <span>Server: <strong>{run.serverName}</strong>{run.serverVersion ? ` ${run.serverVersion}` : ""}</span> : null}
        </div>
      ) : null}

      {fields ? (
        <details className="plugin-verification-fields">
          <summary>ChatGPT setup fields</summary>
          <dl>
            <Field label="Name" value={fields.name} />
            <Field label="Description" value={fields.description} />
            <Field label="MCP Server URL" value={mcpServerUrl ?? "Unavailable — repair Public MCP first"} />
            <Field label="OAuth issuer" value={fields.oauthIssuer} />
            <Field label="OAuth resource" value={fields.oauthResource} />
            <Field label="OAuth scopes" value={fields.oauthScopes.join(" ")} />
            <Field label="Privacy" value={fields.privacyUrl} />
            <Field label="Terms" value={fields.termsUrl} />
            <Field label="Support" value={fields.supportUrl} />
            {fields.iconUrl ? <Field label="Icon" value={fields.iconUrl} /> : null}
          </dl>
        </details>
      ) : null}

      <div className="plugin-challenge">
        <div>
          <h3>Domain challenge helper</h3>
          <p>Use only when a current publication/domain-verification flow gives you a challenge token. The token is stored in OS secure storage and passed only to the managed daemon environment.</p>
        </div>
        <div className="plugin-verification-status-row">
          <StatusBadge label={view?.challenge.configured ? "Challenge configured" : "No challenge"} tone={view?.challenge.configured ? "working" : "neutral"} />
          <StatusBadge label={view?.challenge.verified ? "Public response verified" : "Not verified"} tone={view?.challenge.verified ? "ready" : "warning"} />
        </div>
        <label className="field">
          <span>One-time challenge token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={challengeToken}
            maxLength={1024}
            onChange={(event) => setChallengeToken(event.target.value)}
            placeholder="Paste current challenge token"
          />
        </label>
        <div className="plugin-verification-actions">
          <button className="button" type="button" disabled={!challengeToken || busy === "challenge-set"} onClick={() => void setChallenge()}>{busy === "challenge-set" ? "Configuring…" : "Set & verify"}</button>
          <button className="button button--quiet" type="button" disabled={!view?.challenge.configured || busy === "challenge-verify"} onClick={() => void verifyChallenge()}>Verify again</button>
          <button className="button button--danger" type="button" disabled={!view?.challenge.configured || busy === "challenge-remove"} onClick={() => void removeChallenge()}>Remove challenge</button>
        </div>
        {view?.challenge.lastVerifiedAt ? <p className="muted">Last exact public response check: {new Date(view.challenge.lastVerifiedAt).toLocaleString()}</p> : null}
      </div>
    </Panel>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd><code>{value}</code></dd></>;
}
