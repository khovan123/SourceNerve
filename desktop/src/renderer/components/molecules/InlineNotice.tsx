import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, TriangleAlert } from "lucide-react";

import { cn } from "../../lib/cn";

type NoticeTone = "neutral" | "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<NoticeTone, string> = {
  neutral: "border-border bg-muted/35 text-foreground",
  info: "border-primary/12 bg-primary/[0.035] text-foreground",
  success: "border-success/20 bg-success/[0.07] text-foreground",
  warning: "border-warning/25 bg-warning/[0.08] text-foreground",
  danger: "border-danger/25 bg-danger/[0.07] text-foreground",
};

const ICON_CLASSES: Record<NoticeTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function InlineNotice({
  tone = "neutral",
  title,
  children,
  action,
  role,
  className,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  const Icon = tone === "success"
    ? CheckCircle2
    : tone === "warning"
      ? TriangleAlert
      : tone === "danger"
        ? CircleAlert
        : Info;

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs leading-5",
        TONE_CLASSES[tone],
        className,
      )}
      role={role}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_CLASSES[tone])} strokeWidth={1.8} aria-hidden="true" />
      <div className="min-w-0 flex flex-1 flex-wrap items-start gap-x-2 gap-y-1 [&_p]:m-0">
        {title ? <strong className="shrink-0 font-semibold text-foreground">{title}</strong> : null}
        <div className="min-w-0 flex-1 text-muted-foreground">{children}</div>
      </div>
      {action ? <div className="shrink-0 self-start">{action}</div> : null}
    </div>
  );
}
