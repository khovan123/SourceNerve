import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
        secondary: "border border-border bg-card text-card-foreground shadow-sm hover:bg-muted",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "bg-danger text-white hover:bg-danger/90",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function ActionButton({ className, variant, size, type = "button", ...props }: ActionButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
