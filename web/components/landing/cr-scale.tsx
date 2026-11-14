"use client";
import { useRiskParams } from "@/hooks/use-protocol";

/** The collateral ratio line every loan lives on, drawn from live risk params. */
export function CrScale() {
  const { risk } = useRiskParams();
  const liq = risk.liquidationCrBps / 100;
  const init = risk.minInitialCrBps / 100;
  const min = 100;
  const max = Math.max(200, init + 50);
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <figure className="w-full">
      <div className="relative h-24" aria-hidden>
        <div className="absolute inset-x-0 top-10 h-2 overflow-hidden rounded-full">
          <div className="absolute inset-y-0 left-0 bg-danger/70" style={{ width: pos(liq) }} />
          <div className="absolute inset-y-0 bg-warning/60" style={{ left: pos(liq), width: `calc(${pos(init)} - ${pos(liq)})` }} />
          <div className="absolute inset-y-0 right-0 bg-positive/60" style={{ left: pos(init) }} />
        </div>
        {[
          { v: liq, label: `${liq}%`, note: "Liquidation", side: "end" },
          { v: init, label: `${init}%`, note: "Minimum to open", side: "start" },
        ].map((m) => (
          <div
            key={m.v}
            className={"absolute top-0 flex flex-col " + (m.side === "end" ? "-translate-x-full items-end" : "items-start")}
            style={{ left: pos(m.v) }}
          >
            <span className="num px-1 text-sm font-medium text-ink">{m.label}</span>
            <span className={"mt-[18px] h-5 w-px bg-ink " + (m.side === "end" ? "self-end" : "self-start")} />
            <span className="mt-1 whitespace-nowrap px-1 text-xs text-ink-2">{m.note}</span>
          </div>
        ))}
        <span className="num absolute left-0 top-[78px] text-2xs text-ink-3 sm:top-[52px]">100%</span>
        <span className="num absolute right-0 top-[52px] text-2xs text-ink-3">{max}%+</span>
      </div>
      <figcaption className="sr-only">
        Loans open at a collateral ratio of at least {init}%. Below {liq}% the lender can liquidate.
      </figcaption>
    </figure>
  );
}
