import type { PropsWithChildren, ReactNode } from "react";

import { cn } from "../../lib/cn";

interface SurfaceCardProps extends PropsWithChildren {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
}

export function SurfaceCard({ title, eyebrow, actions, className, children }: SurfaceCardProps) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card/80 shadow-[0_18px_45px_rgba(40,34,26,0.06)] backdrop-blur-sm", className)}>
      <header className="flex items-start justify-between gap-4 border-b border-border/70 px-5 py-4">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{eyebrow}</p> : null}
          <h2 className="text-sm font-semibold tracking-[-0.015em] text-card-foreground">{title}</h2>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
