"use client";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { activeChainId, MUSD } from "@/lib/chain";
import { formatAmount, formatBtc } from "@/lib/format";
import { useNativeBalance, useTokenBalance } from "@/hooks/use-protocol";
import { buttonClass } from "./ui/button";
import { cn } from "./ui/cn";

function Balances() {
  const { address } = useAccount();
  const btc = useNativeBalance(address);
  const musd = useTokenBalance(MUSD.address, address);
  return (
    <span className="hidden items-center gap-3 pr-1 text-xs text-ink-2 num lg:inline-flex">
      <span title="Native BTC on Mezo testnet">{btc.data ? formatBtc(btc.data.value, { maxDp: 4 }) : "…"} BTC</span>
      <span aria-hidden className="h-3 w-px bg-line-strong" />
      <span>{musd.data !== undefined ? formatAmount(musd.data, 18, { compact: true }) : "…"} MUSD</span>
    </span>
  );
}

export function WalletButton({ className }: { className?: string }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openConnectModal, openChainModal, mounted }) => {
        const ready = mounted;
        if (!ready) return <span aria-hidden className={cn("skeleton h-9 w-28 rounded-md", className)} />;
        if (!account) {
          return (
            <button type="button" onClick={openConnectModal} className={buttonClass("primary", "md", className)}>
              Connect wallet
            </button>
          );
        }
        if (chain?.unsupported || chain?.id !== activeChainId) {
          return (
            <button type="button" onClick={openChainModal} className={buttonClass("danger", "md", className)}>
              Wrong network
            </button>
          );
        }
        return (
          <span className={cn("inline-flex items-center gap-2", className)}>
            <Balances />
            <button
              type="button"
              onClick={openAccountModal}
              className={buttonClass("secondary", "md", "font-mono text-xs")}
              aria-label={`Wallet ${account.address}. Open account menu.`}
            >
              {account.displayName}
            </button>
          </span>
        );
      }}
    </ConnectButton.Custom>
  );
}
