"use client";
import { getDeployment, MUSD } from "@/lib/chain";
import { formatAmount, formatApr } from "@/lib/format";
import { useStats } from "@/hooks/use-api";

/** One honest sentence about the live market, or nothing. Never a placeholder number. */
export function MarketLine() {
  const stats = useStats();
  if (!getDeployment()) {
    return <p className="text-sm text-ink-3">Contracts aren&apos;t deployed yet, so there&apos;s no live market to show.</p>;
  }
  if (stats.isLoading) return <p className="text-sm text-ink-3">Reading the market…</p>;
  if (!stats.data) return null;
  const s = stats.data;
  const musd = s.perAsset.find((a) => a.asset.toLowerCase() === MUSD.address.toLowerCase());
  const available = musd ? BigInt(musd.totalReserved) : 0n;
  if (s.openOffers === 0 && s.activeLoans === 0) {
    return <p className="text-sm text-ink-2">The market is open and empty. The first offer sets the going rate.</p>;
  }
  return (
    <p className="text-sm text-ink-2">
      Right now: <span className="num font-medium text-ink">{formatAmount(available, 18, { compact: true })} MUSD</span> on offer across{" "}
      <span className="num">{s.openOffers}</span> {s.openOffers === 1 ? "offer" : "offers"}
      {s.avgOfferAprBps !== null && (
        <>
          {" "}at an average <span className="num font-medium text-ink">{formatApr(s.avgOfferAprBps)}</span> APR
        </>
      )}
      , <span className="num">{s.activeLoans}</span> {s.activeLoans === 1 ? "loan" : "loans"} running.
    </p>
  );
}
