import { cn } from "../../lib/cn";

export function ToggleSwitch({
  checked,
  disabled = false,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
  label: string;
  className?: string;
}) {
  return (
    <label className={cn("relative inline-flex h-6 w-11 shrink-0 items-center", disabled && "cursor-not-allowed opacity-50", className)}>
      <input
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="pointer-events-none h-6 w-11 rounded-full border border-border bg-muted shadow-inner transition peer-checked:border-primary/40 peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/25" aria-hidden="true" />
      <span className="pointer-events-none absolute left-1 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" aria-hidden="true" />
    </label>
  );
}
