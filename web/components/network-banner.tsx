"use client";
import { useAccount, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/chain";
import { Button } from "./ui/button";

/** Shown under the header while a connected wallet is on another network. */
export function NetworkBanner() {
  const { isConnected, chainId } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  if (!isConnected || chainId === activeChain.id) return null;
  return (
    <div role="alert" className="border-t border-line bg-warning-soft">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <p className="text-sm text-ink">
          Your wallet is on another network. LiquidityX runs on {activeChain.name}.
        </p>
        <Button size="sm" variant="secondary" loading={isPending} onClick={() => switchChain({ chainId: activeChain.id })}>
          Switch to {activeChain.name}
        </Button>
      </div>
    </div>
  );
}
