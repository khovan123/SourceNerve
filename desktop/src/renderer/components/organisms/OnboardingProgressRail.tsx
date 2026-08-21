import { Check } from "lucide-react";

import type { OnboardingStep } from "../../onboarding";
import { cn } from "../../lib/cn";

const STEP_COPY: Record<OnboardingStep, string> = {
  welcome: "Welcome",
  account: "SourceNerve account",
  bootstrap: "Secure bootstrap",
  git: "Git provider",
  repository: "Repository",
  workspace: "Workspace",
  indexing: "Runtime & indexing",
  ready: "Ready",
};

type StepState = "complete" | "current" | "blocked" | "pending";

export function OnboardingProgressRail({ views }: { views: Array<{ id: OnboardingStep; state: StepState }> }) {
  return (
    <div className="overflow-x-auto overscroll-contain pb-1" aria-label="Setup progress">
      <ol className="flex min-w-max gap-2 xl:grid xl:min-w-0 xl:grid-cols-4 2xl:grid-cols-8">
        {views.map((view, index) => {
          const complete = view.state === "complete";
          const current = view.state === "current";
          return (
            <li
              key={view.id}
              aria-current={current ? "step" : undefined}
              className={cn(
                "grid w-44 shrink-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 py-2.5 transition xl:w-auto",
                current && "border-primary/30 bg-primary/[0.07] shadow-sm",
                complete && "border-success/20 bg-success/[0.07]",
                !current && !complete && "border-border bg-card/55",
                view.state === "blocked" && "opacity-55",
              )}
            >
              <span
                className={cn(
                  "grid size-7 place-items-center rounded-full border text-[10px] font-bold",
                  complete && "border-success bg-success text-white",
                  current && "border-primary bg-primary text-primary-foreground",
                  !complete && !current && "border-border bg-muted text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {complete ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-xs text-foreground" title={STEP_COPY[view.id]}>{STEP_COPY[view.id]}</strong>
                <small className="mt-0.5 block text-[10px] text-muted-foreground">{stepStateLabel(view.state)}</small>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function stepStateLabel(state: StepState): string {
  if (state === "complete") return "Complete";
  if (state === "current") return "Current";
  if (state === "pending") return "Pending";
  return "Blocked by prior step";
}
