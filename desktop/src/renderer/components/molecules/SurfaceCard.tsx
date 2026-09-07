import type { PropsWithChildren, ReactNode } from "react";

import { cn } from "../../lib/cn";

interface SurfaceCardProps extends PropsWithChildren {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  compact?: boolean;
  descriptionClassName?: string;
  className?: string;
}

export function SurfaceCard({
  title,
  eyebrow,
  description,
  actions,
  footer,
  compact = false,
  descriptionClassName,
  className,
  children,
}: SurfaceCardProps) {
  return (
    <section
      data-surface-card
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-[14px] border border-border bg-card shadow-[0_1px_2px_var(--sn-shadow)]",
        className,
      )}
    >
      <header
        className={cn(
          "flex flex-col gap-2.5 border-b border-border/80 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
          compact ? "px-4 py-3" : "px-4 py-3.5 sm:px-5",
        )}
      >
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-card-foreground">
            {title}
          </h2>
          {description ? (
            <p
              className={cn(
                "mt-1 max-w-2xl text-xs leading-5 text-muted-foreground",
                descriptionClassName,
              )}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </header>
      <div
        className={cn(
          "flex flex-1 flex-col justify-between",
          compact ? "p-4" : "p-4 sm:p-5",
        )}
      >
        {children}
      </div>
      {footer ? (
        <footer className="border-t border-border/80 bg-muted/20 px-4 py-3 sm:px-5">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
