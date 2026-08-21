import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import type {
  PluginDomainChallengeResult,
  PluginVerificationRunResult,
  PluginVerificationView,
} from "../../shared/plugin-verification-api";
import { InlineNotice } from "./molecules/InlineNotice";
import { PluginDomainChallengeCard } from "./organisms/PluginDomainChallengeCard";
import { PluginSetupFieldsCard } from "./organisms/PluginSetupFieldsCard";
import { PluginVerificationStatus } from "./organisms/PluginVerificationStatus";

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
        ? "SourceNerve is ready for the manual ChatGPT connection step."
        : "Verification completed. Review the checks that still need attention.");
    } else setError(result.error.message);
    setBusy(null);
  }

  async function copyFields(): Promise<void> {
    setBusy("copy");
    setError(null);
    const result = await window.sourcenerveDesktop.copyPluginSetupFields();
    if (result.ok) setNotice("Setup fields copied.");
    else setError(result.error.message);
    setBusy(null);
  }

  async function openChatGpt(): Promise<void> {
    setBusy("open");
    setError(null);
    const result = await window.sourcenerveDesktop.openChatGptPluginSetup();
    if (result.ok) setNotice("ChatGPT setup opened in your browser.");
    else setError(result.error.message);
    setBusy(null);
  }

  async function exportIcon(): Promise<void> {
    setBusy("icon");
    setError(null);
    const result = await window.sourcenerveDesktop.exportPluginIcon();
    if (result.ok && result.value.saved) setNotice("Plugin icon exported.");
    else if (result.ok) setNotice("Icon export cancelled.");
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
  const mcpServerUrl = view?.publicMcp.publicMcpUrl;

  return (
    <section className="mt-4 space-y-4" aria-label="ChatGPT plugin verification">
      {error ? <InlineNotice tone="danger" title="ChatGPT verification failed" role="alert">{error}</InlineNotice> : null}
      {notice ? (
        <div className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground" role="status">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      <PluginVerificationStatus
        view={view}
        run={run}
        busy={busy}
        onVerify={() => void verify()}
        onRefresh={() => void refresh()}
      />

      {fields ? (
        <PluginSetupFieldsCard
          fields={fields}
          mcpServerUrl={mcpServerUrl}
          busy={busy}
          onCopy={() => void copyFields()}
          onOpenChatGpt={() => void openChatGpt()}
          onExportIcon={() => void exportIcon()}
        />
      ) : null}

      <PluginDomainChallengeCard
        challengeToken={challengeToken}
        configured={view?.challenge.configured ?? false}
        verified={view?.challenge.verified ?? false}
        lastVerifiedAt={view?.challenge.lastVerifiedAt}
        busy={busy}
        onTokenChange={setChallengeToken}
        onSet={() => void setChallenge()}
        onVerify={() => void verifyChallenge()}
        onRemove={() => void removeChallenge()}
      />
    </section>
  );
}
