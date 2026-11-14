import { ArrowUpRight } from "lucide-react";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { shortAddress, shortHash } from "@/lib/format";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "positive" | "warning" | "danger";

const dot: Record<Tone, string> = {
  neutral: "bg-ink-3",
  accent: "bg-accent",
  positive: "bg-positive",
  warning: "bg-warning",
  danger: "bg-danger",
};
const toneText: Record<Tone, string> = {
  neutral: "text-ink-2",
  accent: "text-accent-text",
  positive: "text-positive",
  warning: "text-warning",
  danger: "text-danger",
};

/** Status as a dot and a word. No pills. */
export function Status({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs whitespace-nowrap", toneText[tone], className)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", dot[tone])} />
      {children}
    </span>
  );
}

/** Flat tag (square-ish, hairline). Used rarely: asset notes, "Testnet". */
export function Tag({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex items-center rounded-sm border border-line px-1.5 py-px text-2xs text-ink-2 whitespace-nowrap", className)}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block h-4", className)} />;
}

const noticeTone: Record<Tone, string> = {
  neutral: "bg-surface border-line text-ink-2",
  accent: "bg-accent-soft border-transparent text-ink",
  positive: "bg-positive-soft border-transparent text-ink",
  warning: "bg-warning-soft border-transparent text-ink",
  danger: "bg-danger-soft border-transparent text-ink",
};

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: Tone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div role={role} className={cn("flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-center", noticeTone[tone], className)}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children && <div className={cn(title && "mt-0.5", "text-ink-2")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-0.5 text-ink-2 underline decoration-line-strong underline-offset-[3px] hover:text-ink hover:decoration-ink-3", className)}
    >
      {children}
      <ArrowUpRight aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
    </a>
  );
}

export function AddressLink({ address, you, className }: { address: string | null | undefined; you?: boolean; className?: string }) {
  if (!address) return <span className="text-ink-3">-</span>;
  const label = you ? "You" : shortAddress(address);
  const href = explorerAddress(address);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={address} className={cn("font-mono text-xs text-ink-2 hover:text-ink hover:underline", you && "font-sans font-medium text-ink", className)}>
      {label}
    </a>
  ) : (
    <span className={cn("font-mono text-xs", className)}>{label}</span>
  );
}

export function TxHashLink({ hash, className }: { hash: string | null | undefined; className?: string }) {
  if (!hash) return <span className="text-ink-3">-</span>;
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" title={hash} className={cn("font-mono text-xs text-ink-2 hover:text-ink hover:underline", className)}>
      {shortHash(hash)}
    </a>
  );
}

/** Label + value pair, stacked. Labels are sentence case, never tracked caps. */
export function Figure({
  label,
  value,
  sub,
  className,
  size = "md",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd
        className={cn(
          "num mt-1 truncate text-ink",
          size === "lg" ? "text-2xl font-medium tracking-tight" : size === "md" ? "text-lg font-medium" : "text-sm",
        )}
      >
        {value}
      </dd>
      {sub && <dd className="mt-0.5 text-xs text-ink-3 num">{sub}</dd>}
    </div>
  );
}

/** Key/value row used in review steps and detail panels. */
export function Row({ label, children, strong }: { label: React.ReactNode; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className={cn("num text-right", strong ? "font-medium text-ink" : "text-ink")}>{children}</dd>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-10 sm:items-center sm:text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-[62ch] text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

/** A plain section block inside a page: heading + content, separated by a hairline. */
export function Section({ title, description, actions, children, className, id }: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("rounded-lg border border-line bg-bg", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
