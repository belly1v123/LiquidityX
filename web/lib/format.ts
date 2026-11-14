/**
 * Display formatting. bigint in, string out. Never used for math that reaches a contract.
 * All figures render with tabular numerals (the `.num` class); these helpers only produce text.
 */
import { formatUnits, parseUnits } from "viem";

const BPS = 10_000;

function groupInt(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Exact decimal string -> grouped string with at most `maxDp` decimals (truncated, never rounded up,
 * so a balance is never overstated). Trailing zeros are trimmed unless `minDp` asks for them.
 */
export function formatDecimalString(value: string, maxDp: number, minDp = 0): string {
  const neg = value.startsWith("-");
  const v = neg ? value.slice(1) : value;
  const [i, f = ""] = v.split(".");
  let frac = f.slice(0, maxDp).replace(/0+$/, "");
  if (frac.length < minDp) frac = frac.padEnd(minDp, "0");
  const out = groupInt(i || "0") + (frac ? "." + frac : "");
  return (neg ? "-" : "") + out;
}

const COMPACT = [
  { v: 1_000_000_000_000n, s: "T" },
  { v: 1_000_000_000n, s: "B" },
  { v: 1_000_000n, s: "M" },
  { v: 1_000n, s: "K" },
];

export interface AmountOptions {
  /** Max decimals shown. Defaults: 2 for >= 1, 4 below 1, up to 6 for dust. */
  maxDp?: number;
  minDp?: number;
  /** Use K/M/B for values >= 100,000. */
  compact?: boolean;
}

/** Token amount in base units -> human string. "0" for zero, "< 0.0001" for dust. */
export function formatAmount(value: bigint | string | null | undefined, decimals: number, opts: AmountOptions = {}): string {
  if (value === null || value === undefined || value === "") return "-";
  const v = typeof value === "string" ? BigInt(value) : value;
  if (v === 0n) return opts.minDp ? "0." + "0".repeat(opts.minDp) : "0";
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const one = 10n ** BigInt(decimals);
  if (opts.compact && abs >= 100_000n * one) {
    for (const c of COMPACT) {
      if (abs >= c.v * one) {
        const scaled = formatUnits((abs * 100n) / c.v, decimals); // keep 2 dp of the scaled value
        const n = Number(scaled) / 100;
        const str = n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : 2 });
        return (neg ? "-" : "") + str + c.s;
      }
    }
  }
  const s = formatUnits(abs, decimals);
  const maxDp = opts.maxDp ?? (abs >= one ? 2 : 4);
  let out = formatDecimalString(s, maxDp, opts.minDp);
  if (out === "0" || /^0\.?0*$/.test(out)) {
    // Dust: show more precision before giving up.
    const fine = formatDecimalString(s, Math.max(maxDp, 6));
    out = /^0\.?0*$/.test(fine) ? `< 0.${"0".repeat(Math.max(maxDp, 6) - 1)}1` : fine;
  }
  return (neg ? "-" : "") + out;
}

/** BTC (18 dec wei). Up to 6 decimals, which is ~ $1 at testnet prices. */
export function formatBtc(wei: bigint | string | null | undefined, opts: AmountOptions = {}): string {
  return formatAmount(wei, 18, { maxDp: 6, ...opts });
}

/** USD with 18 decimals (oracle price, USD values) -> "$1,213,005.06". */
export function formatUsd(value18: bigint | string | null | undefined, opts: AmountOptions = {}): string {
  if (value18 === null || value18 === undefined) return "-";
  const s = formatAmount(value18, 18, { maxDp: 2, minDp: 2, ...opts });
  return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
}

/** APR in bps -> "6.25%". */
export function formatApr(bps: number | bigint | null | undefined): string {
  if (bps === null || bps === undefined) return "-";
  const n = Number(bps) / 100;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

const MAX_UINT = 2n ** 256n - 1n;

/** Collateral ratio in bps -> "154%". Huge or MAX (no debt) -> "No debt". */
export function formatCr(bps: bigint | string | number | null | undefined): string {
  if (bps === null || bps === undefined) return "-";
  const b = BigInt(bps);
  if (b >= MAX_UINT / 2n) return "No debt";
  if (b > 10_000_000n) return "> 100,000%";
  const n = Number(b) / 100;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : 1 })}%`;
}

/** Duration in seconds -> "30 days", "6 hours", "1 year". */
export function formatDuration(seconds: number | bigint | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  const s = Number(seconds);
  const plural = (n: number, w: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${w}${n === 1 ? "" : "s"}`;
  if (s % (365 * 86400) === 0 && s >= 365 * 86400) return plural(s / (365 * 86400), "year");
  if (s >= 86400) return plural(Math.round((s / 86400) * 10) / 10, "day");
  if (s >= 3600) return plural(Math.round((s / 3600) * 10) / 10, "hour");
  if (s >= 60) return plural(Math.round(s / 60), "minute");
  return plural(s, "second");
}

/** Remaining time from now to `target` (unix s) -> "3d 4h", "5h 12m", "in 40s", or "ended". */
export function formatCountdown(target: number, now: number): string {
  let d = Math.floor(target - now);
  if (d <= 0) return "ended";
  const days = Math.floor(d / 86400);
  d -= days * 86400;
  const h = Math.floor(d / 3600);
  d -= h * 3600;
  const m = Math.floor(d / 60);
  const s = d - m * 60;
  if (days > 0) return `${days}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Relative past time: "just now", "4 min ago", "3 h ago", "2 days ago". */
export function formatAgo(ts: number, now: number): string {
  const d = Math.max(0, Math.floor(now - ts));
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  const days = Math.round(d / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Unix seconds -> "7 Nov 2026". */
export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "-";
  return dateFmt.format(new Date(ts * 1000));
}
/** Unix seconds -> "7 Nov, 14:05" (local time). */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return dateTimeFmt.format(new Date(ts * 1000));
}

/** 0x1234…abcd */
export function shortAddress(addr: string | null | undefined, chars = 4): string {
  if (!addr) return "-";
  return `${addr.slice(0, 2 + chars)}…${addr.slice(-chars)}`;
}
export const shortHash = (h: string | null | undefined) => shortAddress(h, 6);

/** Percent string (e.g. "6.25") -> bps (625). null if invalid or more than 2 decimals. */
export function percentToBps(input: string): number | null {
  const t = input.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [i, f = ""] = t.split(".");
  return Number(i) * 100 + Number(f.padEnd(2, "0"));
}

/** User-typed amount -> base units. null if empty, malformed or too many decimals. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const t = input.trim().replace(/,/g, "");
  if (!t || !/^\d*\.?\d*$/.test(t) || t === ".") return null;
  const frac = t.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

/** Base units -> plain string for an input field ("1250.5"), no grouping. */
export function toInputString(value: bigint, decimals: number, maxDp = decimals): string {
  const s = formatUnits(value, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, maxDp).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}

/** Ratio as percent of a whole: 0..100 number, for progress displays. */
export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  const r = Number((part * 10_000n) / whole) / 100;
  return Math.max(0, Math.min(100, r));
}

/** Current unix time in seconds. Call from event handlers, not during render (use the useNow hook there). */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export { BPS };
