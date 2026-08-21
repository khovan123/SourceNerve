import type { ReactNode } from "react";
import { Code2 } from "lucide-react";

import { cn } from "../../lib/cn";

export function CodeSurface({
  title,
  meta,
  children,
  maxHeightClass = "max-h-[34rem]",
  className,
}: {
  title?: string;
  meta?: ReactNode;
  children: ReactNode;
  maxHeightClass?: string;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-xl border border-border bg-[#11100e] shadow-inner dark:bg-black/40", className)}>
      {title || meta ? (
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.035] px-3 py-2 text-[10px] text-[#bdb5aa]">
          <div className="flex min-w-0 items-center gap-2">
            <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
            {title ? <span className="truncate font-medium text-[#e8e0d5]" title={title}>{title}</span> : null}
          </div>
          {meta ? <div className="min-w-0 break-all font-mono">{meta}</div> : null}
        </header>
      ) : null}
      <pre className={cn("overflow-auto overscroll-contain p-4 font-mono text-[11px] leading-5 text-[#f2eadf]", maxHeightClass)} tabIndex={0}>
        <code>{children}</code>
      </pre>
    </section>
  );
}
