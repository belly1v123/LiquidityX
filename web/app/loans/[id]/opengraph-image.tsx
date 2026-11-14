import { ImageResponse } from "next/og";
import { createPublicClient, http } from "viem";
import { OgCard } from "@/components/og";
import { loanManagerAbi } from "@/lib/abi";
import { activeChain, assetByAddress, getDeployment } from "@/lib/chain";
import { formatAmount, formatApr, formatBtc, formatDuration } from "@/lib/format";

export const alt = "LiquidityX loan";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const STATUS = ["", "Active", "Repaid", "Liquidated"];

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lines: string[] = [];
  const d = getDeployment();
  if (d && /^\d+$/.test(id)) {
    try {
      const client = createPublicClient({ chain: activeChain, transport: http(undefined, { timeout: 5000 }) });
      const l = await client.readContract({ address: d.contracts.loans, abi: loanManagerAbi, functionName: "getLoan", args: [BigInt(id)] });
      if (l.status !== 0) {
        const a = assetByAddress(l.asset);
        lines.push(`${formatAmount(l.principal, a?.decimals ?? 18)} ${a?.symbol ?? ""} at ${formatApr(l.aprBps)} APR for ${formatDuration(Number(l.maturity - l.start))}`);
        lines.push(`${formatBtc(l.collateral)} BTC collateral · ${STATUS[l.status]}`);
      }
    } catch {
      // Fall back to the plain card; a failed RPC read must never break link previews.
    }
  }
  return new ImageResponse(<OgCard title={`Loan #${id}`} lines={lines.length ? lines : ["Fixed-rate loan backed by BTC"]} foot="LiquidityX loan" />, size);
}
