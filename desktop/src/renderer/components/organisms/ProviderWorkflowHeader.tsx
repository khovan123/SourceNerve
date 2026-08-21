import { ShieldCheck } from "lucide-react";

import { InlineNotice } from "../molecules/InlineNotice";

export function ProviderWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 px-1 text-[11px] leading-5 text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p><strong className="font-semibold text-foreground">Provider constraints are authoritative.</strong> Branch protection, required checks, reviews, permissions and exact-head guards are always enforced.</p>
      </div>
      {error ? <InlineNotice tone="danger" title="Provider workflow blocked" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="success" title="Provider workflow updated" role="status">{notice}</InlineNotice> : null}
    </div>
  );
}
