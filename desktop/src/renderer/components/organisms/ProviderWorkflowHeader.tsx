import { InlineNotice } from "../molecules/InlineNotice";

export function ProviderWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      {error ? <InlineNotice tone="danger" title="Provider workflow blocked" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="success" title="Provider workflow updated" role="status">{notice}</InlineNotice> : null}
    </div>
  );
}
