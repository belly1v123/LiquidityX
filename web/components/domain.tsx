"use client";
/** Small domain-aware display pieces shared across pages. */
import type { LoanStatus, OfferStatus, RequestStatus } from "@/lib/api-types";
import { assetByAddress, PRICE_SOURCE_LABEL, UNLISTED_ASSET_NOTE, type AssetMeta, MUSD } from "@/lib/chain";
import { formatAgo, formatAmount, formatUsd } from "@/lib/format";
import { useOraclePrice } from "@/hooks/use-protocol";
import { useNow } from "@/hooks/use-now";
import { Skeleton, Status, type Tone } from "./ui/misc";
import { cn } from "./ui/cn";

export function assetMeta(address: string | null | undefined): AssetMeta {
  return assetByAddress(address) ?? { ...MUSD, symbol: "MUSD", address: (address ?? MUSD.address) as `0x${string}` };
}

/** Asset symbol; unofficial assets carry a visible note (not just a tooltip). */
export function AssetName({ address, withNote = false, className }: { address: string | null | undefined; withNote?: boolean; className?: string }) {
  const known = assetByAddress(address);
  if (!known) return <span className={cn("font-mono text-xs", className)}>{address ? `${address.slice(0, 8)}…` : "-"}</span>;
  return (
    <span className={cn("inline-flex flex-col", className)}>
      <span title={known.officiallyListed ? known.name : `${known.name}. ${UNLISTED_ASSET_NOTE}.`}>{known.symbol}</span>
      {withNote && !known.officiallyListed && <span className="text-2xs text-warning">{UNLISTED_ASSET_NOTE}</span>}
    </span>
  );
}

/** "1,250.5 MUSD" */
export function Amount({ value, asset, compact, className }: { value: bigint | string | null | undefined; asset: string | null | undefined; compact?: boolean; className?: string }) {
  const m = assetMeta(asset);
  return (
    <span className={cn("num whitespace-nowrap", className)}>
      {formatAmount(value, m.decimals, { compact })} <span className="text-ink-3">{m.symbol}</span>
    </span>
  );
}

const offerTone: Record<OfferStatus, [Tone, string]> = {
  open: ["positive", "Open"],
  filled: ["neutral", "Filled"],
  cancelled: ["neutral", "Cancelled"],
  expired: ["warning", "Expired"],
};
const requestTone: Record<RequestStatus, [Tone, string]> = {
  open: ["positive", "Open"],
  partially_filled: ["accent", "Partly filled"],
  filled: ["neutral", "Filled"],
  cancelled: ["neutral", "Cancelled"],
  expired: ["warning", "Expired"],
};
const loanTone: Record<LoanStatus, [Tone, string]> = {
  active: ["positive", "Active"],
  overdue: ["warning", "Overdue"],
  repaid: ["neutral", "Repaid"],
  liquidated: ["danger", "Liquidated"],
};

export function OfferStatusLabel({ status }: { status: OfferStatus }) {
  const [t, l] = offerTone[status] ?? ["neutral", status];
  return <Status tone={t}>{l}</Status>;
}
export function RequestStatusLabel({ status }: { status: RequestStatus }) {
  const [t, l] = requestTone[status] ?? ["neutral", status];
  return <Status tone={t}>{l}</Status>;
}
export function LoanStatusLabel({ status, liquidatable }: { status: LoanStatus; liquidatable?: "none" | "undercollateralized" | "overdue" }) {
  if (status === "active" && liquidatable === "undercollateralized") return <Status tone="danger">Under limit</Status>;
  const [t, l] = loanTone[status] ?? ["neutral", status];
  return <Status tone={t}>{l}</Status>;
}

/** CR colour by distance to the liquidation threshold. */
export function crTone(crBps: bigint | null, liquidationCrBps: number, minInitialCrBps: number): Tone {
  if (crBps === null) return "neutral";
  if (crBps < BigInt(liquidationCrBps)) return "danger";
  if (crBps < BigInt(Math.round((liquidationCrBps + minInitialCrBps) / 2))) return "warning";
  return "positive";
}

/** "BTC $1,213,005.06 · Mezo testnet oracle · updated 3 min ago" */
export function PriceLine({ className }: { className?: string }) {
  const p = useOraclePrice();
  const now = useNow(15_000);
  if (p.isLoading) return <Skeleton className={cn("h-4 w-64", className)} />;
  if (!p.price) {
    return <p className={cn("text-xs text-warning", className)}>BTC price unavailable from the {PRICE_SOURCE_LABEL}. New loans wait until it&apos;s back.</p>;
  }
  return (
    <p className={cn("text-xs text-ink-3", className)}>
      <span className="num font-medium text-ink">BTC {formatUsd(p.price)}</span>
      <span className="mx-1.5" aria-hidden>·</span>
      {PRICE_SOURCE_LABEL}
      {p.updatedAt ? (
        <>
          , updated <span className="num">{now ? formatAgo(p.updatedAt, now) : "…"}</span>
        </>
      ) : null}
      {!p.ok && <span className="ml-1.5 text-warning">(stale: new loans paused)</span>}
    </p>
  );
}
