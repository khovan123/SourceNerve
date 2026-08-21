import { ShieldCheck, Trash2 } from "lucide-react";

import { ActionButton } from "../atoms/ActionButton";
import { StatusPill } from "../atoms/StatusPill";
import { SurfaceCard } from "../molecules/SurfaceCard";

export function PluginDomainChallengeCard({
  challengeToken,
  configured,
  verified,
  lastVerifiedAt,
  busy,
  onTokenChange,
  onSet,
  onVerify,
  onRemove,
}: {
  challengeToken: string;
  configured: boolean;
  verified: boolean;
  lastVerifiedAt?: string;
  busy: string | null;
  onTokenChange(value: string): void;
  onSet(): void;
  onVerify(): void;
  onRemove(): void;
}) {
  return (
    <SurfaceCard title="Domain challenge helper" eyebrow="Publication verification">
      <div className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Use only when the current publication/domain-verification flow gives you a one-time challenge token. It is stored in OS secure storage and passed only to the managed daemon environment.
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={configured ? "working" : "neutral"}>{configured ? "Challenge configured" : "No challenge"}</StatusPill>
          <StatusPill tone={verified ? "ready" : "warning"}>{verified ? "Public response verified" : "Not verified"}</StatusPill>
        </div>
        <label className="grid gap-1.5 text-sm">
          <span className="text-xs font-medium text-muted-foreground">One-time challenge token</span>
          <input
            className="h-10 w-full rounded-xl border border-border bg-background/70 px-3 text-sm text-foreground outline-none transition focus:border-primary/45 focus:ring-2 focus:ring-primary/10"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={challengeToken}
            maxLength={1024}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder="Paste current challenge token"
          />
        </label>
        <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
          <ActionButton size="sm" disabled={!challengeToken || busy === "challenge-set"} onClick={onSet}>
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {busy === "challenge-set" ? "Configuring…" : "Set & verify"}
          </ActionButton>
          <ActionButton variant="secondary" size="sm" disabled={!configured || busy === "challenge-verify"} onClick={onVerify}>
            {busy === "challenge-verify" ? "Verifying…" : "Verify again"}
          </ActionButton>
          <ActionButton variant="ghost" size="sm" disabled={!configured || busy === "challenge-remove"} onClick={onRemove} className="text-danger hover:text-danger">
            <Trash2 className="size-3.5" aria-hidden="true" />
            {busy === "challenge-remove" ? "Removing…" : "Remove challenge"}
          </ActionButton>
        </div>
        {lastVerifiedAt ? <p className="text-[11px] text-muted-foreground">Last exact public response check: {new Date(lastVerifiedAt).toLocaleString()}</p> : null}
      </div>
    </SurfaceCard>
  );
}
