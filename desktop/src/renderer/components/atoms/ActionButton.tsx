import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
        secondary: "border border-border bg-card text-card-foreground shadow-sm hover:bg-muted disabled:bg-muted/50 disabled:text-muted-foreground disabled:shadow-none",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground disabled:text-muted-foreground",
        destructive: "bg-danger text-white hover:bg-danger/90 disabled:bg-danger/25 disabled:text-foreground",
      },
      size: {
        sm: "h-9 px-3 text-xs",
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
