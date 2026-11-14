"use client";
/**
 * Direct contract reads (the source of truth for balances, prices, risk params).
 * All return undefined-safe data and work (quietly empty) when contracts aren't deployed.
 */
import { useAccount, useBalance, useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import {
  collateralManagerAbi,
  erc20Abi,
  liquidityXVaultAbi,
  priceOracleAdapterAbi,
  protocolConfigAbi,
} from "@/lib/abi";
import { activeChainId, BTC_FEED, getAssets, getDeployment, type AssetMeta } from "@/lib/chain";

export function useDeployment() {
  return getDeployment();
}

/** Documented launch defaults (docs/CONTRACTS.md). Used only for previews before contracts are deployed. */
export const DEFAULT_RISK = {
  minInitialCrBps: 15_000,
  liquidationCrBps: 12_000,
  liquidationBonusBps: 500,
  minAprBps: 1,
  maxAprBps: 10_000,
  minDuration: 3600,
  maxDuration: 365 * 86400,
  gracePeriod: 86400,
  maxListingLifetime: 30 * 86400,
  maxCollateralPerLoan: 10n * 10n ** 18n,
};
export type Risk = typeof DEFAULT_RISK;

export function useRiskParams(): { risk: Risk; live: boolean; isLoading: boolean } {
  const d = getDeployment();
  const q = useReadContract({
    address: d?.contracts.config,
    abi: protocolConfigAbi,
    functionName: "riskParams",
    chainId: activeChainId,
    query: { enabled: !!d, staleTime: 60_000 },
  });
  if (q.data) {
    const r = q.data;
    return {
      risk: {
        minInitialCrBps: r.minInitialCrBps,
        liquidationCrBps: r.liquidationCrBps,
        liquidationBonusBps: r.liquidationBonusBps,
        minAprBps: r.minAprBps,
        maxAprBps: r.maxAprBps,
        minDuration: r.minDuration,
        maxDuration: r.maxDuration,
        gracePeriod: r.gracePeriod,
        maxListingLifetime: r.maxListingLifetime,
        maxCollateralPerLoan: r.maxCollateralPerLoan,
      },
      live: true,
      isLoading: false,
    };
  }
  return { risk: DEFAULT_RISK, live: false, isLoading: !!d && q.isLoading };
}

export function usePaused(): boolean {
  const d = getDeployment();
  const q = useReadContract({
    address: d?.contracts.config,
    abi: protocolConfigAbi,
    functionName: "paused",
    chainId: activeChainId,
    query: { enabled: !!d, refetchInterval: 60_000 },
  });
  return q.data === true;
}

export interface AssetLive extends AssetMeta {
  enabled: boolean;
  minLoan: bigint;
  maxLoan: bigint;
}

/** Assets with their live on-chain config. Not-deployed: enabled=false, limits 0. */
export function useAssets(): { assets: AssetLive[]; isLoading: boolean } {
  const d = getDeployment();
  const metas = getAssets();
  const q = useReadContracts({
    contracts: metas.map((m) => ({
      address: d?.contracts.config,
      abi: protocolConfigAbi,
      functionName: "assetConfig",
      args: [m.address],
      chainId: activeChainId,
    })),
    query: { enabled: !!d, staleTime: 60_000 },
  });
  const assets = metas.map((m, i) => {
    const r = q.data?.[i];
    const c = r?.status === "success" ? (r.result as { enabled: boolean; minLoan: bigint; maxLoan: bigint; decimals: number }) : null;
    return {
      ...m,
      decimals: c?.decimals || m.decimals,
      enabled: c?.enabled ?? false,
      minLoan: c?.minLoan ?? 0n,
      maxLoan: c?.maxLoan ?? 0n,
    };
  });
  return { assets, isLoading: !!d && q.isLoading };
}

export interface OraclePrice {
  ok: boolean;
  price: bigint | null;
  updatedAt: number | null;
  /** "adapter" = LiquidityX staleness rules apply; "feed" = raw precompile read before deployment. */
  via: "adapter" | "feed";
  isLoading: boolean;
}

const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** BTC/USD (18 dec) from the oracle adapter, or straight from the precompile when not deployed. */
export function useOraclePrice(): OraclePrice {
  const d = getDeployment();
  const adapter = useReadContract({
    address: d?.contracts.oracle,
    abi: priceOracleAdapterAbi,
    functionName: "tryGetPrice",
    chainId: activeChainId,
    query: { enabled: !!d, refetchInterval: 30_000 },
  });
  const feed = useReadContract({
    address: BTC_FEED,
    abi: feedAbi,
    functionName: "latestRoundData",
    chainId: activeChainId,
    query: { enabled: !d && activeChainId === 31611, refetchInterval: 30_000 },
  });
  if (d) {
    const [ok, price, updatedAt] = adapter.data ?? [false, 0n, 0n];
    return {
      ok: !!adapter.data && ok,
      price: adapter.data && price > 0n ? price : null,
      updatedAt: adapter.data ? Number(updatedAt) : null,
      via: "adapter",
      isLoading: adapter.isLoading,
    };
  }
  const f = feed.data;
  return {
    ok: !!f && f[1] > 0n,
    price: f && f[1] > 0n ? f[1] : null,
    updatedAt: f ? Number(f[3]) : null,
    via: "feed",
    isLoading: feed.isLoading,
  };
}

export function useTokenBalance(token: Address | undefined, owner?: Address) {
  const { address } = useAccount();
  const who = owner ?? address;
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: who ? [who] : undefined,
    chainId: activeChainId,
    query: { enabled: !!token && !!who, refetchInterval: 30_000 },
  });
}

export function useNativeBalance(owner?: Address) {
  const { address } = useAccount();
  const who = owner ?? address;
  return useBalance({ address: who, chainId: activeChainId, query: { enabled: !!who, refetchInterval: 30_000 } });
}

export function useFreeCollateral(owner?: Address) {
  const d = getDeployment();
  const { address } = useAccount();
  const who = owner ?? address;
  return useReadContract({
    address: d?.contracts.collateral,
    abi: collateralManagerAbi,
    functionName: "freeCollateral",
    args: who ? [who] : undefined,
    chainId: activeChainId,
    query: { enabled: !!d && !!who },
  });
}

export interface VaultPosition {
  available: bigint;
  reserved: bigint;
  lent: bigint;
  interestEarned: bigint;
}

export function useVaultPosition(asset: Address | undefined, owner?: Address) {
  const d = getDeployment();
  const { address } = useAccount();
  const who = owner ?? address;
  const fns = ["available", "reserved", "lent", "interestEarned"] as const;
  const q = useReadContracts({
    contracts: fns.map((fn) => ({
      address: d?.contracts.vault,
      abi: liquidityXVaultAbi,
      functionName: fn,
      args: who && asset ? [who, asset] : undefined,
      chainId: activeChainId,
    })),
    query: { enabled: !!d && !!who && !!asset },
  });
  const v = (i: number) => (q.data?.[i]?.status === "success" ? (q.data[i].result as bigint) : 0n);
  const data: VaultPosition | undefined = q.data
    ? { available: v(0), reserved: v(1), lent: v(2), interestEarned: v(3) }
    : undefined;
  return { data, isLoading: q.isLoading, refetch: q.refetch };
}
