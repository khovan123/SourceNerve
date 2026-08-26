import { useState } from "react";

import type { DesktopHarnessApprovalView, HarnessApprovalDecision } from "../../shared/harness-approval-api";
import { ActionButton } from "./atoms/ActionButton";
import { Panel } from "./Panel";

export function HarnessApprovalPanel() {
  const [runId, setRunId] = useState("");
  const [approvals, setApprovals] = useState<DesktopHarnessApprovalView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    const value = runId.trim();
    if (!value) return;
    setBusy("load");
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.listHarnessApprovals({
      runId: value,
      status: "pending",
      limit: 100,
    });
    if (result.ok) setApprovals(result.value);
    else setError(result.error.message);
    setBusy(null);
  }

  async function respond(approval: DesktopHarnessApprovalView, decision: HarnessApprovalDecision): Promise<void> {
    const label = decision === "allow" ? "Allow once" : "Deny";
    if (!window.confirm(`${label} ${approval.tool}?\n\nRun: ${approval.runId}\nWorkspace: ${approval.workspace}\nHEAD: ${approval.headSha}\nArguments SHA-256: ${approval.argumentSha256}\n\nApproval is bound to this exact execution intent.`)) return;
    setBusy(approval.id);
    setError(null);
    setNotice(null);
    const result = await window.sourcenerveDesktop.respondHarnessApproval({
      approvalId: approval.id,
      decision,
    });
    if (result.ok) {
      setApprovals((items) => items.filter((item) => item.id !== approval.id));
      setNotice(decision === "allow"
        ? `${approval.tool} allowed once. The client must retry the exact same request before the approval expires.`
        : `${approval.tool} denied for this execution intent.`);
    } else setError(result.error.message);
    setBusy(null);
  }

  return (
    <Panel title="Harness approvals" eyebrow="Human-in-the-loop">
      <p className="muted">
        Review pending ASK decisions for a durable Harness run. SourceNerve binds each decision to the exact tool, workspace, Git HEAD and argument digest; Allow is one-shot and does not weaken task or provider guards.
      </p>
      <div className="form-row">
        <label className="field grow">
          <span>Harness run ID</span>
          <input
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
            placeholder="Paste a run ID from the Harness tool response"
            maxLength={128}
          />
        </label>
        <ActionButton onClick={() => void load()} disabled={!runId.trim() || busy !== null}>
          {busy === "load" ? "Loading…" : "Load pending"}
        </ActionButton>
      </div>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {notice ? <p className="success-banner">{notice}</p> : null}
      {approvals.length === 0 ? (
        <p className="muted">No pending approvals loaded.</p>
      ) : (
        <div className="space-y-3">
          {approvals.map((approval) => (
            <article className="panel nested-panel" key={approval.id}>
              <div className="split-row">
                <div>
                  <strong>{approval.tool}</strong>
                  <p className="muted">{approval.capabilityId}</p>
                </div>
                <span className="status-pill">pending</span>
              </div>
              <dl className="detail-grid">
                <div><dt>Workspace</dt><dd>{approval.workspace}</dd></div>
                <div><dt>HEAD</dt><dd><code>{approval.headSha.slice(0, 12)}</code></dd></div>
                <div><dt>Arguments</dt><dd><code>{approval.argumentSha256.slice(0, 16)}…</code></dd></div>
                <div><dt>Expires</dt><dd>{new Date(approval.expiresAt * 1000).toLocaleTimeString()}</dd></div>
              </dl>
              <div className="button-row">
                <ActionButton onClick={() => void respond(approval, "allow")} disabled={busy !== null}>
                  Allow once
                </ActionButton>
                <ActionButton onClick={() => void respond(approval, "deny")} disabled={busy !== null}>
                  Deny
                </ActionButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
