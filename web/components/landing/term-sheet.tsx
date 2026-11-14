"use client";
import { useMemo, useState } from "react";
import { liquidationPrice, minCollateral, termInterest } from "@/lib/finance";
import { formatApr, formatBtc, formatUsd, parseAmount, percentToBps } from "@/lib/format";
import { PRICE_SOURCE_LABEL } from "@/lib/chain";
import { useOraclePrice, useRiskParams } from "@/hooks/use-protocol";
import { Skeleton } from "../ui/misc";

const DAYS = [7, 30, 90, 180];

/** A real, live-priced example loan. Nothing here is a fixture: inputs are the reader's, price is the oracle's. */
export function TermSheet() {
  const [amount, setAmount] = useState("1000");
  const [apr, setApr] = useState("6");
  const [days, setDays] = useState(30);
  const price = useOraclePrice();
  const { risk } = useRiskParams();

  const calc = useMemo(() => {
    const amt = parseAmount(amount, 18);
    const bps = percentToBps(apr);
    if (amt === null || amt === 0n || bps === null || bps === 0) return null;
    const interest = termInterest(amt, bps, days * 86400);
    const coll = price.price ? minCollateral(amt, price.price, risk.minInitialCrBps, 18) : null;
    const liq = coll ? liquidationPrice(amt + interest, 18, coll, risk.liquidationCrBps) : null;
    return { amt, interest, total: amt + interest, coll, liq };
  }, [amount, apr, days, price.price, risk.minInitialCrBps, risk.liquidationCrBps]);

  return (
    <div className="rounded-lg border border-line bg-bg">
      <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3">
        <p className="text-sm font-semibold text-ink">Example loan</p>
        <p className="text-xs text-ink-3">Priced live</p>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3 px-5 pt-4">
        <label className="flex flex-col gap-1.5 text-xs text-ink-2">
          Borrow
          <span className="relative">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              aria-label="Amount in MUSD"
              className="num h-10 w-full rounded-md border border-line-strong bg-bg px-3 pr-14 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-3">MUSD</span>
          </span>
        </label>
        <label className="flex w-24 flex-col gap-1.5 text-xs text-ink-2">
          APR
          <span className="relative">
            <input
              value={apr}
              onChange={(e) => setApr(e.target.value)}
              inputMode="decimal"
              aria-label="APR percent"
              className="num h-10 w-full rounded-md border border-line-strong bg-bg px-3 pr-7 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-3">%</span>
          </span>
        </label>
      </div>
      <div className="px-5 pt-3">
        <div role="radiogroup" aria-label="Term" className="flex gap-1">
          {DAYS.map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className={
                "num h-8 flex-1 rounded-md border text-xs transition-colors " +
                (days === d ? "border-accent bg-accent-soft font-medium text-ink" : "border-line text-ink-2 hover:text-ink")
              }
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      <dl className="mt-4 divide-y divide-line border-t border-line text-sm">
        <Line label={`Interest at ${calc ? formatApr(percentToBps(apr)) : "-"}`} value={calc ? `${formatBtcLike(calc.interest)} MUSD` : "-"} />
        <Line label="Repay at maturity" value={calc ? `${formatBtcLike(calc.total)} MUSD` : "-"} strong />
        <Line
          label={`BTC to lock (${risk.minInitialCrBps / 100}% minimum)`}
          value={price.isLoading ? <Skeleton className="ml-auto h-4 w-20" /> : calc?.coll ? `${formatBtc(calc.coll)} BTC` : "-"}
        />
        <Line
          label={`Liquidated if BTC falls below`}
          value={price.isLoading ? <Skeleton className="ml-auto h-4 w-24" /> : calc?.liq ? formatUsd(calc.liq) : "-"}
        />
      </dl>
      <p className="border-t border-line px-5 py-3 text-xs text-ink-3">
        BTC {price.price ? <span className="num">{formatUsd(price.price)}</span> : "price unavailable"} from the {PRICE_SOURCE_LABEL}. Testnet prices
        are not market prices.
      </p>
    </div>
  );
}

function formatBtcLike(v: bigint) {
  // 2 decimals for MUSD figures in this summary.
  const whole = v / 10n ** 16n;
  const s = (Number(whole) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s;
}

function Line({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-2.5">
      <dt className="text-ink-2">{label}</dt>
      <dd className={"num text-right " + (strong ? "font-semibold text-ink" : "text-ink")}>{value}</dd>
    </div>
  );
}
