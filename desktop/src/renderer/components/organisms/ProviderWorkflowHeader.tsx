import { ShieldCheck } from "lucide-react";

export function ProviderWorkflowHeader({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <div className="space-y-3">
      <section className="flex items-start gap-3 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-4 shadow-[0_14px_36px_rgba(40,34,26,0.04)]">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/15 bg-card text-primary">
          <ShieldCheck className="size-4" aria-hidden="true" />
        </div>
        <div>
          <strong className="text-sm text-foreground">Provider constraints are authoritative.</strong>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Desktop never bypasses branch protection, required checks, reviews, provider permissions, or exact-head guards. A head mismatch requires Refresh and a new explicit confirmation.
          </p>
        </div>
      </section>
      {error ? <div className="rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">{error}</div> : null}
      {notice ? <div className="rounded-xl border border-success/20 bg-success/5 px-4 py-3 text-sm text-success" role="status">{notice}</div> : null}
    </div>
  );
}
