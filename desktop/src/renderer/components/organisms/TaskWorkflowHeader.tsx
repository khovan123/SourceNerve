import { ShieldCheck } from "lucide-react";

import { InlineNotice } from "../molecules/InlineNotice";

export function TaskWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      <InlineNotice tone="info" title="No direct Git controls">
        <span className="inline-flex items-start gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />Desktop never offers default-branch commits, force push, reset, raw refspecs or shell commands. Server-side SourceNerve task guards remain authoritative at every mutation step.</span>
      </InlineNotice>
      {error ? <InlineNotice tone="danger" title="Task workflow blocked" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="success" title="Task workflow updated" role="status">{notice}</InlineNotice> : null}
    </div>
  );
}
