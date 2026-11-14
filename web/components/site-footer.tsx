import Link from "next/link";
import { explorerAddress, explorerUrl, getDeployment } from "@/lib/chain";
import { LogoMark } from "./logo";

const CONTRACT_LABELS = [
  ["marketplace", "Marketplace"],
  ["loans", "Loan manager"],
  ["vault", "Vault"],
  ["collateral", "Collateral manager"],
  ["liquidation", "Liquidation engine"],
  ["oracle", "Price oracle adapter"],
  ["config", "Protocol config"],
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function SiteFooter() {
  const deployment = getDeployment();
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-6 px-4 py-8 text-xs text-ink-3 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="flex max-w-sm flex-col gap-2">
          <span className="inline-flex items-center gap-2 text-ink-2">
            <LogoMark className="size-4" />
            LiquidityX
          </span>
          <p>Peer-to-peer fixed-rate loans backed by BTC. Testnet only: tokens and prices have no real-world value.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/marketplace" className="hover:text-ink">Marketplace</Link>
          <Link href="/activity" className="hover:text-ink">Activity</Link>
          <a href={explorerUrl} target="_blank" rel="noreferrer" className="hover:text-ink">Explorer</a>
          <a href="https://faucet.test.mezo.org" target="_blank" rel="noreferrer" className="hover:text-ink">Testnet BTC faucet</a>
          <a href="https://mezo.org" target="_blank" rel="noreferrer" className="hover:text-ink">Built on Mezo</a>
        </nav>
      </div>
      {deployment && (
        <div className="mx-auto max-w-[1240px] border-t border-line px-4 py-6 text-xs text-ink-3 sm:px-6">
          <p className="mb-3 text-ink-2">Contracts on chain {deployment.chainId}</p>
          <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-4">
            {CONTRACT_LABELS.map(([key, label]) => (
              <li key={key} className="flex justify-between gap-3">
                <span>{label}</span>
                <a
                  href={explorerAddress(deployment.contracts[key])}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono tabular-nums hover:text-ink"
                  title={deployment.contracts[key]}
                >
                  {short(deployment.contracts[key])}
                </a>
              </li>
            ))}
            {deployment.assets.filter((a) => a.symbol === "MUSD").map((a) => (
              <li key={a.address} className="flex justify-between gap-3">
                <span>{a.symbol} token</span>
                <a href={explorerAddress(a.address)} target="_blank" rel="noreferrer" className="font-mono tabular-nums hover:text-ink" title={a.address}>
                  {short(a.address)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </footer>
  );
}
