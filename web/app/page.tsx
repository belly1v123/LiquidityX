import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { TermSheet } from "@/components/landing/term-sheet";
import { MarketLine } from "@/components/landing/market-line";
import { CrScale } from "@/components/landing/cr-scale";

const STEPS = [
  {
    who: "Lender",
    title: "Deposits MUSD and posts an offer",
    body: "Pick the amount, the APR, the longest term you'll accept and the collateral you want. The offer is fully funded from your deposit.",
  },
  {
    who: "Borrower",
    title: "Locks BTC and asks for a loan",
    body: "Either take an open offer straight away, or post a request with the most APR you'll pay and wait for lenders.",
  },
  {
    who: "Contract",
    title: "Checks every term and opens the loan",
    body: "Rate, term, size and collateral ratio are checked on chain at a fresh BTC price. MUSD goes to the borrower in the same transaction.",
  },
  {
    who: "Borrower",
    title: "Repays and gets the BTC back",
    body: "Interest accrues by the second on what's still owed. Repay any time. The lender's balance is credited at once.",
  },
];

const COMPARE: { row: string; lx: string; pool: string }[] = [
  { row: "Who sets the rate", lx: "The lender, per offer", pool: "A utilisation curve" },
  { row: "Rate over the loan", lx: "Fixed for the whole term", pool: "Changes block to block" },
  { row: "Term", lx: "Fixed date, chosen up front", pool: "Open-ended" },
  { row: "Your counterparty", lx: "One named lender per loan", pool: "Everyone in the pool" },
  { row: "If collateral runs short", lx: "Lender is paid in BTC plus a bonus", pool: "Liquidators race to buy it" },
];

export default function Home() {
  return (
    <>
      <section className="border-b border-line">
        <div className="mx-auto grid max-w-[1240px] gap-12 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pb-20 lg:pt-20">
          <div className="flex flex-col justify-center">
            <h1 className="max-w-[16ch] text-[2.375rem] font-semibold leading-[1.08] tracking-[-0.025em] text-ink sm:text-5xl sm:leading-[1.05]">
              Fixed-rate loans between people, backed by Bitcoin.
            </h1>
            <p className="mt-5 max-w-[46ch] text-base text-ink-2 sm:text-lg sm:leading-relaxed">
              Lenders name their rate. Borrowers lock BTC and pick the terms that fit. Contracts hold the funds and enforce every term.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/marketplace" size="lg">
                Explore marketplace
              </ButtonLink>
              <ButtonLink href="#how-it-works" size="lg" variant="ghost">
                How a loan works
              </ButtonLink>
            </div>
            <div className="mt-10 max-w-[52ch]">
              <MarketLine />
            </div>
          </div>
          <div className="lg:pt-2">
            <TermSheet />
          </div>
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20 border-b border-line">
        <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-20">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">How a loan works</h2>
          <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative border-t border-line-strong pt-5">
                <span aria-hidden className="absolute -top-[5px] left-0 size-2.5 rounded-full border-2 border-bg bg-accent" />
                <p className="text-xs text-ink-3">
                  <span className="num">{i + 1}</span> <span aria-hidden>·</span> {s.who}
                </p>
                <h3 className="mt-2 text-base font-semibold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm text-ink-2">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-[1240px] gap-12 px-4 py-16 sm:px-6 md:grid-cols-2 lg:gap-20 lg:py-20">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">Lending</h2>
            <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
              Your MUSD earns the rate you set, on a term you agreed to, against BTC worth well more than the loan. Interest is
              paid straight into your vault balance on every repayment, and you can withdraw anything that isn&apos;t lent out.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-ink">
              <li>Set APR, maximum term, minimum collateral and expiry per offer.</li>
              <li>Fund any open request directly at the borrower&apos;s rate.</li>
              <li>Cancel an unfilled offer and the MUSD is available again.</li>
            </ul>
            <Link href="/lend" className="mt-6 inline-block text-sm font-medium text-accent-text underline-offset-4 hover:underline">
              Create an offer
            </Link>
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">Borrowing</h2>
            <p className="mt-3 max-w-[52ch] text-sm leading-relaxed text-ink-2">
              Get MUSD without selling your BTC. You know the rate and the repayment date before you sign, and it doesn&apos;t
              move. Repay early and you only pay interest for the time you used.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-ink">
              <li>Take an open offer in one transaction.</li>
              <li>Or post a request; several lenders can fill parts of it.</li>
              <li>Collateral comes back to you as soon as the loan is repaid.</li>
            </ul>
            <Link href="/borrow" className="mt-6 inline-block text-sm font-medium text-accent-text underline-offset-4 hover:underline">
              Request a loan
            </Link>
          </div>
        </div>
      </section>

      <section className="border-b border-line">
        <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.2fr] lg:gap-20 lg:py-20">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-ink">How collateral protects lenders</h2>
            <p className="mt-4 max-w-[54ch] text-sm leading-relaxed text-ink-2">
              Every loan opens with more BTC locked than it&apos;s worth. If the BTC price falls far enough that the loan drops
              under the liquidation line, or the borrower is more than a day past the due date, the lender can liquidate.
            </p>
            <p className="mt-3 max-w-[54ch] text-sm leading-relaxed text-ink-2">
              Liquidation pays the lender the debt in BTC at the oracle price, plus a bonus. Whatever is left goes back to the
              borrower. Nothing is sold on a market.
            </p>
          </div>
          <div className="flex items-center">
            <CrScale />
          </div>
        </div>
      </section>

      <section className="border-b border-line">
        <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-6 lg:py-20">
          <h2 className="text-2xl font-semibold tracking-tight text-ink">Different from a lending pool</h2>
          <dl className="mt-6 divide-y divide-line sm:hidden">
            {COMPARE.map((c) => (
              <div key={c.row} className="py-3 text-sm">
                <dt className="text-ink-2">{c.row}</dt>
                <dd className="mt-1 text-ink">LiquidityX: {c.lx}</dd>
                <dd className="text-ink-3">Pools: {c.pool}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-8 hidden sm:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line-strong text-xs text-ink-3">
                  <th scope="col" className="py-2.5 pr-6 font-normal" />
                  <th scope="col" className="py-2.5 pr-6 font-medium text-ink">LiquidityX</th>
                  <th scope="col" className="py-2.5 font-normal">Pooled lending markets</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((c) => (
                  <tr key={c.row} className="border-b border-line last:border-0">
                    <th scope="row" className="py-3 pr-6 font-normal text-ink-2">{c.row}</th>
                    <td className="py-3 pr-6 text-ink">{c.lx}</td>
                    <td className="py-3 text-ink-2">{c.pool}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1fr] lg:gap-20 lg:py-20">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">Before you start</h2>
            <ul className="mt-4 space-y-3 text-sm text-ink-2">
              <li>
                This runs on Mezo testnet. Collateral is the chain&apos;s native testnet BTC. Get some from the{" "}
                <a className="text-ink underline underline-offset-2" href="https://faucet.test.mezo.org" target="_blank" rel="noreferrer">
                  testnet faucet
                </a>
                .
              </li>
              <li>Loans are in MUSD. You can borrow testnet MUSD against BTC at testnet.mezo.org.</li>
              <li>The BTC price comes from the Mezo testnet oracle. It is not the market price, and liquidations follow it.</li>
              <li>A liquidated lender receives BTC, not MUSD.</li>
            </ul>
          </div>
          <div className="flex flex-col items-start justify-center gap-4 rounded-lg border border-line p-6 sm:p-8">
            <p className="text-lg font-semibold text-ink">See what&apos;s on offer, then pick your side.</p>
            <ButtonLink href="/marketplace" size="lg">
              Explore marketplace
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
