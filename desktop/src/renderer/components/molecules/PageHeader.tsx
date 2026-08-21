import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
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
    <div className="mb-5 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:mb-2 sm:text-[11px]">{eyebrow}</p> : null}
        <h1 className="text-[1.75rem] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-3xl xl:text-[2.2rem]">{title}</h1>
        <p className="mt-2.5 max-w-2xl text-sm leading-6 text-muted-foreground sm:mt-3">{description}</p>
      </div>
      {action ? <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">{action}</div> : null}
    </div>
  );
}
