import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-tight",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted/35 text-muted-foreground",
        ready: "border-success/20 bg-success/8 text-success",
        working: "border-primary/20 bg-primary/8 text-primary",
        warning: "border-warning/20 bg-warning/8 text-warning",
        danger: "border-danger/20 bg-danger/8 text-danger",
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
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-75" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
