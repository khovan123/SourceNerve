import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm font-medium leading-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:translate-y-0 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border border-primary bg-primary text-primary-foreground shadow-[0_1px_2px_var(--sn-shadow)] hover:bg-primary/90 hover:border-primary/90 disabled:border-muted disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
        secondary: "border border-border bg-card text-card-foreground shadow-[0_1px_2px_var(--sn-shadow)] hover:border-muted-foreground/25 hover:bg-muted/55 disabled:bg-muted/40 disabled:text-muted-foreground disabled:shadow-none",
        ghost: "border border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground disabled:text-muted-foreground",
        destructive: "border border-danger bg-danger text-white shadow-[0_1px_2px_var(--sn-shadow)] hover:bg-danger/90 disabled:border-danger/20 disabled:bg-danger/20 disabled:text-muted-foreground",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-3.5",
        icon: "size-8 p-0",
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
