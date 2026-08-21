import { ShieldCheck } from "lucide-react";

import { InlineNotice } from "../molecules/InlineNotice";

export function ProviderWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      <InlineNotice tone="info" title="Provider constraints are authoritative.">
        <span className="inline-flex items-start gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Desktop never bypasses branch protection, required checks, reviews, provider permissions, or exact-head guards. A head mismatch requires Refresh and a new explicit confirmation.</span>
      </InlineNotice>
      {error ? <InlineNotice tone="danger" title="Provider workflow blocked" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="success" title="Provider workflow updated" role="status">{notice}</InlineNotice> : null}
    </div>
  );
}
