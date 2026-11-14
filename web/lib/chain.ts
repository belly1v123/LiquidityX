/**
 * Single place for chain config, contract addresses and asset metadata.
 * Shared: created by the frontend, imported read-only by the backend (web/lib/server/**).
 * No "server-only" or "use client" here: safe to import from both.
 */
import { defineChain, getAddress, isAddress, type Address, type Chain, type Hex } from "viem";
import { rawDeployments } from "./deployments";

export const MEZO_TESTNET_ID = 31611;
export const ANVIL_ID = 31337;

const MEZO_RPC = process.env.NEXT_PUBLIC_MEZO_RPC_URL || "https://rpc.test.mezo.org";
const MEZO_EXPLORER = "https://explorer.test.mezo.org";

export const mezoTestnet = defineChain({
  id: MEZO_TESTNET_ID,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [MEZO_RPC] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: MEZO_EXPLORER, apiUrl: `${MEZO_EXPLORER.replace("://", "://api.")}/api/v2` } },
  // Multicall3 verified with eth_getCode on rpc.test.mezo.org (2026-11-07).
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const anvilLocal = defineChain({
  id: ANVIL_ID,
  name: "Anvil (local)",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC_URL || "http://127.0.0.1:8545"] } },
  testnet: true,
});

export const isLocal = process.env.NEXT_PUBLIC_CHAIN === "local";
export const activeChain: Chain = isLocal ? anvilLocal : mezoTestnet;
export const activeChainId: number = activeChain.id;
export const explorerUrl: string = activeChain.blockExplorers?.default.url ?? "";

export function explorerTx(hash: Hex | string): string {
  return explorerUrl ? `${explorerUrl}/tx/${hash}` : "";
}
export function explorerAddress(addr: Address | string): string {
  return explorerUrl ? `${explorerUrl}/address/${addr}` : "";
}

// ---------------------------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------------------------

export interface AssetMeta {
  symbol: "MUSD" | "mUSDC";
  name: string;
  address: Address;
  decimals: number;
  /** true only for addresses in Mezo's official contracts reference. */
  officiallyListed: boolean;
}

/** Canonical Mezo testnet MUSD. Use `MUSD` (below), which follows the active deployment. */
export const MUSD_TESTNET: AssetMeta = {
  symbol: "MUSD",
  name: "Mezo USD",
  address: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  decimals: 18,
  officiallyListed: true,
};
export const MUSDC_TESTNET: AssetMeta = {
  symbol: "mUSDC",
  name: "Mezo Circle USDC",
  address: "0xe1a26db653708A2AD8F824E92Db9852410e33A59",
  decimals: 6,
  officiallyListed: false,
};
/** Shown wherever a not-officially-listed asset appears. */
export const UNLISTED_ASSET_NOTE = "Not in Mezo's official contract list";

export const BTC_FEED: Address = "0x7b7c000000000000000000000000000000000015";
export const PRICE_SOURCE_LABEL = "Mezo testnet oracle";
export const COLLATERAL_LABEL = "BTC (Mezo testnet)";

// ---------------------------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------------------------

export type ContractKey = "oracle" | "config" | "vault" | "collateral" | "loans" | "marketplace" | "liquidation";

export interface Deployment {
  chainId: number;
  deployer: Address | null;
  startBlock: bigint;
  contracts: Record<ContractKey, Address>;
  /** symbol -> address, from the deployment file merged with the known asset list. */
  assets: AssetMeta[];
  txs: Record<string, Hex>;
}

/** Accepted spellings for each contract key in the deployment JSON. */
const ALIASES: Record<ContractKey, string[]> = {
  oracle: ["oracle", "priceOracleAdapter", "PriceOracleAdapter", "oracleAdapter"],
  config: ["config", "protocolConfig", "ProtocolConfig"],
  vault: ["vault", "liquidityXVault", "LiquidityXVault"],
  collateral: ["collateral", "collateralManager", "CollateralManager"],
  loans: ["loans", "loanManager", "LoanManager"],
  marketplace: ["marketplace", "loanMarketplace", "LoanMarketplace"],
  liquidation: ["liquidation", "liquidationEngine", "LiquidationEngine"],
};

function pick(obj: Record<string, unknown>, keys: string[]): Address | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && isAddress(v)) return getAddress(v);
    if (v && typeof v === "object" && typeof (v as { address?: unknown }).address === "string") {
      const a = (v as { address: string }).address;
      if (isAddress(a)) return getAddress(a);
    }
  }
  return null;
}

function parseDeployment(chainId: number, raw: unknown): Deployment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const c = (r.contracts ?? {}) as Record<string, unknown>;
  const contracts = {} as Record<ContractKey, Address>;
  for (const key of Object.keys(ALIASES) as ContractKey[]) {
    const a = pick(c, ALIASES[key]);
    if (!a) return null;
    contracts[key] = a;
  }
  const rawAssets = (r.assets ?? {}) as Record<string, unknown>;
  const assets: AssetMeta[] = [MUSD_TESTNET, MUSDC_TESTNET].map((m) => {
    const a = pick(rawAssets, [m.symbol, m.symbol.toLowerCase(), m.symbol.toUpperCase()]);
    return a ? { ...m, address: a } : m;
  });
  const sb = r.startBlock;
  return {
    chainId,
    deployer: typeof r.deployer === "string" && isAddress(r.deployer) ? getAddress(r.deployer) : null,
    startBlock: typeof sb === "number" || typeof sb === "string" ? BigInt(sb) : 0n,
    contracts,
    assets,
    txs: (r.txs ?? {}) as Record<string, Hex>,
  };
}

const cache = new Map<number, Deployment | null>();

/** Deployment for the active chain (or `chainId`), or null when contracts are not deployed yet. */
export function getDeployment(chainId: number = activeChainId): Deployment | null {
  if (!cache.has(chainId)) cache.set(chainId, parseDeployment(chainId, rawDeployments[chainId]));
  return cache.get(chainId) ?? null;
}

/** Known assets for the active chain (deployment overrides, else defaults). */
export function getAssets(): AssetMeta[] {
  return getDeployment()?.assets ?? [MUSD_TESTNET, MUSDC_TESTNET];
}

/** MUSD / mUSDC for the active chain (addresses from the deployment file when present). */
export const MUSD: AssetMeta = getAssets()[0];
export const MUSDC: AssetMeta = getAssets()[1];

export function assetByAddress(addr: string | null | undefined): AssetMeta | undefined {
  if (!addr) return undefined;
  const a = addr.toLowerCase();
  return getAssets().find((x) => x.address.toLowerCase() === a);
}
