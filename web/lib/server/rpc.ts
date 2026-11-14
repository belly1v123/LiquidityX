import "server-only";
import type { Abi, Address } from "viem";
import {
  collateralManagerAbi,
  liquidationEngineAbi,
  liquidityXVaultAbi,
  loanManagerAbi,
  loanMarketplaceAbi,
  priceOracleAdapterAbi,
  protocolConfigAbi,
} from "@/lib/abi";
import { getAssets, MUSD } from "@/lib/chain";
import { deployment, getClient, hasMulticall, type Deployment } from "./context";

// ---------------------------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------------------------

let baseDelayMs = 250;
/** Tests: make retries instant. */
export function setRetryBaseDelay(ms: number) {
  baseDelayMs = ms;
}

/** Runs fn up to `tries` times with exponential backoff (250ms, 500ms, ...). Rethrows the last error. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1 && baseDelayMs > 0) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw last;
}

/** Rejects after `ms` (the underlying promise keeps running). */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} after ${ms}ms`)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Batched reads (multicall3 when the chain has it, else parallel eth_call)
// ---------------------------------------------------------------------------------------------

export interface Call {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}
export type CallResult = { ok: true; result: unknown } | { ok: false; error: unknown };

export async function readMany(calls: Call[]): Promise<CallResult[]> {
  if (calls.length === 0) return [];
  const client = getClient();
  if (hasMulticall()) {
    const res = await withRetry(() =>
      client.multicall({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contracts: calls as any,
        allowFailure: true,
        batchSize: 2048,
      }),
    );
    return (res as { status: string; result?: unknown; error?: unknown }[]).map((r) =>
      r.status === "success" ? { ok: true, result: r.result } : { ok: false, error: r.error },
    );
  }
  return Promise.all(
    calls.map((c) =>
      withRetry(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.readContract(c as any),
      ).then(
        (result): CallResult => ({ ok: true, result }),
        (error): CallResult => ({ ok: false, error }),
      ),
    ),
  );
}

export async function readOne<T>(call: Call): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await withRetry(() => getClient().readContract(call as any))) as T;
}

/** Result of a batch entry or throw. */
export function must<T>(r: CallResult): T {
  if (!r.ok) throw r.error instanceof Error ? r.error : new Error(String(r.error));
  return r.result as T;
}

// ---------------------------------------------------------------------------------------------
// Typed on-chain structs (as decoded by viem)
// ---------------------------------------------------------------------------------------------

export interface ChainOffer {
  id: bigint; lender: Address; asset: Address; amount: bigint; remaining: bigint; aprBps: number;
  maxDuration: number; minCrBps: number; expiry: bigint; createdAt: bigint; fills: number; status: number;
}
export interface ChainRequest {
  id: bigint; borrower: Address; asset: Address; amount: bigint; filled: bigint; maxAprBps: number; duration: number;
  collateral: bigint; collateralRemaining: bigint; expiry: bigint; createdAt: bigint; fills: number; status: number;
}
export interface ChainLoan {
  id: bigint; offerId: bigint; requestId: bigint; lender: Address; borrower: Address; asset: Address;
  principal: bigint; outstandingPrincipal: bigint; accruedInterest: bigint; interestPaid: bigint; principalRepaid: bigint;
  collateral: bigint; aprBps: number; start: bigint; maturity: bigint; lastAccrual: bigint; closedAt: bigint; status: number;
}
export interface RiskParams {
  minInitialCrBps: number; liquidationCrBps: number; liquidationBonusBps: number; minAprBps: number; maxAprBps: number;
  minDuration: number; maxDuration: number; gracePeriod: number; maxListingLifetime: number; maxCollateralPerLoan: bigint;
}
export interface AssetCfg { address: Address; enabled: boolean; decimals: number; minLoan: bigint; maxLoan: bigint }

export const OFFER_STATUS = ["none", "open", "filled", "cancelled"] as const;
export const REQUEST_STATUS = ["none", "open", "filled", "cancelled"] as const;
export const LOAN_STATUS = ["none", "active", "repaid", "liquidated"] as const;
export const LIQ_REASON = ["none", "undercollateralized", "overdue"] as const;

export const abis = {
  oracle: priceOracleAdapterAbi,
  config: protocolConfigAbi,
  vault: liquidityXVaultAbi,
  collateral: collateralManagerAbi,
  loans: loanManagerAbi,
  marketplace: loanMarketplaceAbi,
  liquidation: liquidationEngineAbi,
} as const;

export function requireDeployment(): Deployment {
  const d = deployment();
  if (!d) throw new NotDeployedError();
  return d;
}

export class NotDeployedError extends Error {
  constructor() {
    super("contracts not deployed");
  }
}

// ---------------------------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------------------------

export interface PriceRead { ok: boolean; price: bigint | null; updatedAt: number | null; maxStaleness: number | null }

let priceCache: { at: number; value: PriceRead } | null = null;
const PRICE_TTL_MS = 5_000;

/** PriceOracleAdapter.tryGetPrice() (never reverts) + maxStaleness. Throws only if the RPC is unreachable. */
export async function readPrice(fresh = false): Promise<PriceRead> {
  const d = requireDeployment();
  if (!fresh && priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.value;
  const [p, s] = await readMany([
    { address: d.contracts.oracle, abi: abis.oracle, functionName: "tryGetPrice" },
    { address: d.contracts.oracle, abi: abis.oracle, functionName: "maxStaleness" },
  ]);
  const [ok, price, updatedAt] = must<readonly [boolean, bigint, bigint]>(p);
  const value: PriceRead = {
    ok,
    price: ok ? price : null,
    updatedAt: updatedAt > 0n ? Number(updatedAt) : null,
    maxStaleness: s.ok ? Number(s.result as bigint) : null,
  };
  priceCache = { at: Date.now(), value };
  return value;
}

/** Price usable for CR math, or null (stale / RPC down). Never throws. */
export async function priceOrNull(): Promise<bigint | null> {
  try {
    const p = await readPrice();
    return p.ok ? p.price : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Protocol config (cached briefly; it changes rarely)
// ---------------------------------------------------------------------------------------------

export interface ProtocolState { risk: RiskParams; paused: boolean; assets: AssetCfg[] }
let configCache: { at: number; value: ProtocolState } | null = null;
const CONFIG_TTL_MS = 30_000;

export async function readProtocolState(fresh = false): Promise<ProtocolState> {
  const d = requireDeployment();
  if (!fresh && configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const [r, p, l] = await readMany([
    { address: d.contracts.config, abi: abis.config, functionName: "riskParams" },
    { address: d.contracts.config, abi: abis.config, functionName: "paused" },
    { address: d.contracts.config, abi: abis.config, functionName: "listAssets" },
  ]);
  const risk = must<RiskParams>(r);
  const addrs = [...must<readonly Address[]>(l)];
  const cfgs = await readMany(
    addrs.map((a) => ({ address: d.contracts.config, abi: abis.config, functionName: "assetConfig", args: [a] })),
  );
  const assets: AssetCfg[] = addrs.map((address, i) => {
    const c = must<{ enabled: boolean; decimals: number; minLoan: bigint; maxLoan: bigint }>(cfgs[i]);
    return { address, enabled: c.enabled, decimals: Number(c.decimals), minLoan: c.minLoan, maxLoan: c.maxLoan };
  });
  const value: ProtocolState = { risk: normalizeRisk(risk), paused: must<boolean>(p), assets };
  configCache = { at: Date.now(), value };
  return value;
}

function normalizeRisk(r: RiskParams): RiskParams {
  return {
    minInitialCrBps: Number(r.minInitialCrBps),
    liquidationCrBps: Number(r.liquidationCrBps),
    liquidationBonusBps: Number(r.liquidationBonusBps),
    minAprBps: Number(r.minAprBps),
    maxAprBps: Number(r.maxAprBps),
    minDuration: Number(r.minDuration),
    maxDuration: Number(r.maxDuration),
    gracePeriod: Number(r.gracePeriod),
    maxListingLifetime: Number(r.maxListingLifetime),
    maxCollateralPerLoan: BigInt(r.maxCollateralPerLoan),
  };
}

/** Decimals for an asset: protocol config if reachable, else known asset list, else 18. */
export function decimalsOf(asset: string, state: ProtocolState | null): number {
  const a = asset.toLowerCase();
  const fromCfg = state?.assets.find((x) => x.address.toLowerCase() === a);
  if (fromCfg) return fromCfg.decimals;
  const known = getAssets().find((x) => x.address.toLowerCase() === a);
  return known?.decimals ?? 18;
}

export async function protocolStateOrNull(): Promise<ProtocolState | null> {
  try {
    return await readProtocolState();
  } catch {
    return null;
  }
}

export function assetSymbol(asset: string): string {
  const a = asset.toLowerCase();
  return getAssets().find((x) => x.address.toLowerCase() === a)?.symbol ?? "ERC20";
}

export function officiallyListed(asset: string): boolean {
  return asset.toLowerCase() === MUSD.address.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Entity reads
// ---------------------------------------------------------------------------------------------

export async function readOffers(ids: bigint[]): Promise<(ChainOffer | null)[]> {
  const d = requireDeployment();
  const res = await readMany(
    ids.map((id) => ({ address: d.contracts.marketplace, abi: abis.marketplace, functionName: "getOffer", args: [id] })),
  );
  return res.map((r) => (r.ok ? (r.result as ChainOffer) : null));
}

export async function readRequests(ids: bigint[]): Promise<(ChainRequest | null)[]> {
  const d = requireDeployment();
  const res = await readMany(
    ids.map((id) => ({ address: d.contracts.marketplace, abi: abis.marketplace, functionName: "getRequest", args: [id] })),
  );
  return res.map((r) => (r.ok ? (r.result as ChainRequest) : null));
}

export async function readLoans(ids: bigint[]): Promise<(ChainLoan | null)[]> {
  const d = requireDeployment();
  const res = await readMany(
    ids.map((id) => ({ address: d.contracts.loans, abi: abis.loans, functionName: "getLoan", args: [id] })),
  );
  return res.map((r) => (r.ok ? (r.result as ChainLoan) : null));
}

export interface LoanHealth { crBps: bigint; reason: number; priceOk: boolean }
export async function readHealth(ids: bigint[]): Promise<(LoanHealth | null)[]> {
  const d = requireDeployment();
  const res = await readMany(
    ids.map((id) => ({ address: d.contracts.liquidation, abi: abis.liquidation, functionName: "health", args: [id] })),
  );
  return res.map((r) => {
    if (!r.ok) return null;
    const [crBps, reason, priceOk] = r.result as readonly [bigint, number, boolean];
    return { crBps, reason: Number(reason), priceOk };
  });
}

/** Tests: drop cached price/config. */
export function resetRpcCaches() {
  priceCache = null;
  configCache = null;
}
