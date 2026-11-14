"use client";
import { getDeployment } from "@/lib/chain";
import { Notice } from "./ui/misc";

/** Calm notice when contracts aren't deployed. Pages still render around it. */
export function NotDeployedNotice({ className }: { className?: string }) {
  if (getDeployment()) return null;
  return (
    <Notice className={className} title="Contracts not deployed yet" role="status">
      You can look around and try the calculators. Deposits, listings and loans turn on once the contracts are live on
      Mezo Testnet.
    </Notice>
  );
}

export function PausedNotice({ paused }: { paused: boolean }) {
  if (!paused) return null;
  return (
    <Notice tone="warning" title="LiquidityX is paused" role="status">
      New deposits, listings and matches are off for now. Repay, withdraw, cancel and liquidate still work.
    </Notice>
  );
}
