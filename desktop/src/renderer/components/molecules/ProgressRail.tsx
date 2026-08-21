import { Check, Circle } from "lucide-react";

import { cn } from "../../lib/cn";

export interface ProgressRailStep {
  id: string;
  label: string;
  description?: string;
}

export function ProgressRail({
  steps,
  currentIndex,
  ariaLabel,
  compact = false,
}: {
  steps: ProgressRailStep[];
  currentIndex: number;
  ariaLabel: string;
  compact?: boolean;
}) {
  return (
    <ol
      className={cn(
        "grid gap-2",
        compact ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3 xl:grid-cols-6",
      )}
      aria-label={ariaLabel}
    >
      {steps.map((step, index) => {
        const completed = index < currentIndex;
        const current = index === currentIndex;
        return (
          <li
            key={step.id}
            aria-current={current ? "step" : undefined}
            className={cn(
              "relative min-w-0 rounded-xl border px-3 py-2.5 transition-colors",
              completed && "border-success/20 bg-success/[0.06]",
              current && "border-primary/25 bg-primary/[0.055] shadow-sm",
              index > currentIndex && "border-border bg-muted/15",
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[9px] font-semibold",
                  completed && "border-success/30 bg-success/10 text-success",
                  current && "border-primary/30 bg-primary/10 text-foreground",
                  index > currentIndex && "border-border bg-card text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {completed ? <Check className="size-3" strokeWidth={2.4} /> : current ? <Circle className="size-2.5 fill-current" /> : index + 1}
              </span>
              <span className={cn("truncate text-xs font-semibold", current || completed ? "text-foreground" : "text-muted-foreground")}>{step.label}</span>
            </div>
            {step.description ? <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground">{step.description}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
