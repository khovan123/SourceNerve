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
      className={cn(
        "flex flex-col h-full overflow-hidden rounded-2xl border border-border/80 bg-card/82 shadow-[0_18px_45px_rgba(40,34,26,0.055)] backdrop-blur-sm",
        className,
      )}
    >
      <header
        className={cn(
          "flex flex-col gap-3 border-b border-border/65 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
          compact ? "px-4 py-3.5" : "px-4 py-4 sm:px-5",
        )}
      >
        <div className="min-w-0">
          {eyebrow ? (
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h2 className="text-sm font-semibold tracking-[-0.015em] text-card-foreground">
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
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            {actions}
          </div>
        ) : null}
      </header>
      <div
        className={cn(
          "flex-1 flex flex-col justify-between",
          compact ? "p-4" : "p-4 sm:p-5",
        )}
      >
        {children}
      </div>
      {footer ? (
        <footer className="border-t border-border/65 bg-muted/18 px-4 py-3 sm:px-5">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
