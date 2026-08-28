import { HarnessApprovalPanel } from "../HarnessApprovalPanel";
import { InlineNotice } from "../molecules/InlineNotice";

export function TaskWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      {error ? <InlineNotice tone="danger" title="Task workflow blocked" role="alert">{error}</InlineNotice> : null}
      {notice ? <InlineNotice tone="success" title="Task workflow updated" role="status">{notice}</InlineNotice> : null}
      <HarnessApprovalPanel />
    </div>
  );
}
