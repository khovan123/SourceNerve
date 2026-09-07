import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-[12px] border border-dashed border-border bg-muted/20 text-center", compact ? "px-4 py-5" : "px-5 py-9", className)}>
      {Icon ? (
        <div className="mx-auto grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.8} aria-hidden="true" />
        </div>
      ) : null}
      <p className={cn("font-medium text-foreground", Icon ? "mt-3" : "", compact ? "text-xs" : "text-sm")}>{title}</p>
      {description ? <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
