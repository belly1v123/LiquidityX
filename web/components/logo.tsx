import { cn } from "./ui/cn";

/** Mark: a rounded square with a broken X (two parties, one agreement). Colour follows the accent token. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <path
        d="M10 10 22 22M22 10l-4.6 4.6M14.6 17.4 10 22"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">LiquidityX</span>
    </span>
  );
}
