import type { ReactNode } from "react";

export function PageHeader({
  eyebrow = "SourceNerve Desktop",
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-6">
      <div className="max-w-3xl">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
