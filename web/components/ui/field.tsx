import { forwardRef, useId } from "react";
import { cn } from "./cn";

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  aside,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  htmlFor?: string;
  /** Right side of the label row, e.g. a balance with a Max button. */
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-xs font-medium text-ink">
          {label}
        </label>
        {aside && <div className="text-xs text-ink-3 num">{aside}</div>}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

const control =
  "h-10 w-full rounded-md border border-line-strong bg-bg px-3 text-sm text-ink transition-colors duration-150 hover:border-ink-3 focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus/40 disabled:opacity-50 aria-[invalid=true]:border-danger";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  suffix?: React.ReactNode;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ suffix, invalid, className, ...rest }, ref) {
  if (!suffix) return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, "num", className)} {...rest} />;
  return (
    <div className="relative">
      <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, "num pr-16", className)} {...rest} />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-3">{suffix}</span>
    </div>
  );
});

export function AmountInput(props: Omit<InputProps, "type" | "inputMode">) {
  return <Input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0.00" {...props} />;
}

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        control,
        "appearance-none bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat pr-8",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function useFieldId(prefix: string) {
  return `${prefix}-${useId().replace(/:/g, "")}`;
}
