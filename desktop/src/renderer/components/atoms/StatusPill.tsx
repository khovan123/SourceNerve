import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-tight",
  {
    variants: {
      tone: {
        neutral: "border-border bg-card text-muted-foreground",
        ready: "border-success/20 bg-success/10 text-success",
        working: "border-primary/15 bg-primary/8 text-foreground",
        warning: "border-warning/20 bg-warning/10 text-warning",
        danger: "border-danger/20 bg-danger/10 text-danger",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

type StatusPillProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof pillVariants> & {
  dot?: boolean;
};

export function StatusPill({ className, tone, dot = false, children, ...props }: StatusPillProps) {
  return (
    <span className={cn(pillVariants({ tone }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-80" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
