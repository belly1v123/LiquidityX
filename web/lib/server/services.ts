import "server-only";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Address } from "viem";
import type {
  AssetInfo,
  ConfigResponse,
  LoanDTO,
  MatchSuggestion,
  PortfolioResponse,
  PriceResponse,
  StatsResponse,
} from "@/lib/api-types";
import { BTC_FEED, explorerUrl, getAssets } from "@/lib/chain";
import { suggestMatches, suggestRequestsForOffer, type MatchableOffer, type MatchableRequest, type RequestForOffer } from "@/lib/matching";
import { dbKind, getDb } from "./db";
import { chainId as getChainId, deployment, getClient } from "./context";
import { getSyncState, lastIndexerError } from "./indexer";
import {
  abis,
  assetSymbol,
  decimalsOf,
  must,
  officiallyListed,
  readMany,
  readOffers,
  readPrice,
  readProtocolState,
  readRequests,
  withRetry,
  withTimeout,
  type Call,
} from "./rpc";
import { loanDTOs, marketCtx, openOfferRows, openRequestRows, offersTable as O, requestsTable as R, loansTable as L } from "./queries";
import { HttpError, notFound } from "./http";
import { loanRow, offerDTO, offerRow, requestDTO, requestRow, upsertLoans, upsertOffers, upsertRequests, type OfferRow, type RequestRow } from "./store";

const nowSec = () => Math.floor(Date.now() / 1000);
const unavailable = (what: string) => new HttpError(503, "chain_unavailable", `${what}: RPC unavailable, try again shortly`);

// ---------------------------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  chainId: number;
  deployed: boolean;
  rpcOk: boolean;
  indexedToBlock: string | null;
  headBlock: string | null;
  lagBlocks: number | null;
  db: "postgres" | "pglite";
  dbOk: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

export async function health(): Promise<HealthResponse> {
  const d = deployment();
  const chainId = getChainId();
  let head: bigint | null = null;
  let rpcOk = false;
  try {
    head = await withTimeout(withRetry(() => getClient().getBlockNumber(), 2), 4_000);
    rpcOk = true;
  } catch {
    rpcOk = false;
  }
  let indexed: string | null = null;
  let dbOk = false;
  let lastSyncAt: number | null = null;
  let lastError: string | null = lastIndexerError();
  try {
    const db = await getDb();
    dbOk = true;
    if (d) {
      const s = await getSyncState(db, chainId);
      indexed = s?.lastBlock ?? null;
      lastSyncAt = s?.lastSyncAt ?? null;
      lastError = lastError ?? s?.lastError ?? null;
    }
  } catch (e) {
    lastError = lastError ?? (e instanceof Error ? e.message : String(e));
  }
  const lag = head !== null && indexed !== null ? Number(head - BigInt(indexed)) : null;
  return {
    ok: rpcOk && dbOk,
    chainId,
    deployed: Boolean(d),
    rpcOk,
    indexedToBlock: indexed,
    headBlock: head?.toString() ?? null,
    lagBlocks: lag,
    db: dbKind(),
    dbOk,
    lastSyncAt,
    lastError,
  };
}

// ---------------------------------------------------------------------------------------------
// /api/config
// ---------------------------------------------------------------------------------------------

export async function config(): Promise<ConfigResponse> {
  const d = deployment();
  const base: ConfigResponse = {
    chainId: getChainId(),
    deployed: Boolean(d),
    contracts: {
      oracle: d?.contracts.oracle ?? null,
      config: d?.contracts.config ?? null,
      vault: d?.contracts.vault ?? null,
      collateral: d?.contracts.collateral ?? null,
      loans: d?.contracts.loans ?? null,
      marketplace: d?.contracts.marketplace ?? null,
      liquidation: d?.contracts.liquidation ?? null,
    },
    startBlock: d ? d.startBlock.toString() : null,
    assets: [],
    risk: null,
    paused: false,
    explorerUrl,
  };
  const known = (): AssetInfo[] =>
    getAssets().map((a) => ({
      address: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      enabled: false,
      minLoan: "0",
      maxLoan: "0",
      officiallyListed: a.officiallyListed,
    }));
  if (!d) return { ...base, assets: known() };
  let st;
  try {
    st = await withTimeout(readProtocolState(), 6_000);
  } catch {
    // RPC down: addresses still useful; risk null and assets disabled tell the UI not to transact.
    return { ...base, assets: known() };
  }
  const assets: AssetInfo[] = st.assets.map((a) => ({
    address: a.address,
    symbol: assetSymbol(a.address),
    decimals: a.decimals,
    enabled: a.enabled,
    minLoan: a.minLoan.toString(),
    maxLoan: a.maxLoan.toString(),
    officiallyListed: officiallyListed(a.address),
  }));
  const r = st.risk;
  return {
    ...base,
    assets,
    paused: st.paused,
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
      maxCollateralPerLoan: r.maxCollateralPerLoan.toString(),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// /api/price
// ---------------------------------------------------------------------------------------------

export async function price(): Promise<PriceResponse> {
  const d = deployment();
  if (!d) return { ok: false, price: null, updatedAt: null, source: BTC_FEED, maxStaleness: null };
  try {
    const p = await withTimeout(readPrice(), 6_000);
    return { ok: p.ok, price: p.price?.toString() ?? null, updatedAt: p.updatedAt, source: BTC_FEED, maxStaleness: p.maxStaleness };
  } catch {
    return { ok: false, price: null, updatedAt: null, source: BTC_FEED, maxStaleness: null };
  }
}

// ---------------------------------------------------------------------------------------------
// /api/loans/[id]
// ---------------------------------------------------------------------------------------------

/** Loan read live from LoanManager + LiquidationEngine.health (DB row as fallback when the RPC is down). */
export async function loanById(id: string): Promise<LoanDTO> {
  if (!deployment()) throw notFound(`loan ${id} not found (contracts not deployed)`);
  const db = await getDb();
  const chainId = getChainId();
  const ctx = await marketCtx();
  let rows = await db.select().from(L).where(and(eq(L.chainId, chainId), eq(L.id, id)));
  if (!rows.length) {
    // Not indexed yet (or index behind): read straight from chain.
    try {
      const [live] = await withTimeout(
        readMany([{ address: deployment()!.contracts.loans, abi: abis.loans, functionName: "getLoan", args: [BigInt(id)] }]),
        6_000,
      );
      const l = must<Parameters<typeof loanRow>[1]>(live);
      if (Number(l.status) === 0) throw notFound(`loan ${id} not found`);
      const row = loanRow(chainId, l);
      await upsertLoans(db, [row]);
      rows = [row];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw notFound(`loan ${id} not found`);
    }
  }
  const [dto] = await loanDTOs(db, chainId, rows, ctx, true);
  return dto;
}

// ---------------------------------------------------------------------------------------------
// /api/matches, /api/matches/for-offer
// ---------------------------------------------------------------------------------------------

const toMatchOffer = (r: OfferRow): MatchableOffer => ({
  id: BigInt(r.id), lender: r.lender, asset: r.asset, remaining: BigInt(r.remaining), aprBps: r.aprBps,
  maxDuration: r.maxDuration, minCrBps: r.minCrBps, expiry: r.expiry, open: r.status === "open",
});
const toMatchRequest = (r: RequestRow): MatchableRequest => ({
  id: BigInt(r.id), borrower: r.borrower, asset: r.asset, amount: BigInt(r.amount), filled: BigInt(r.filled),
  maxAprBps: r.maxAprBps, duration: r.duration, collateral: BigInt(r.collateral),
  collateralRemaining: BigInt(r.collateralRemaining), expiry: r.expiry, open: r.status === "open",
});

export async function matchesForRequest(requestId: string): Promise<MatchSuggestion> {
  if (!deployment()) throw notFound(`request ${requestId} not found (contracts not deployed)`);
  const chainId = getChainId();
  const db = await getDb();
  let req: RequestRow;
  try {
    const [live] = await withTimeout(readRequests([BigInt(requestId)]), 6_000);
    if (!live) throw new Error("read failed");
    req = requestRow(chainId, live);
  } catch {
    throw unavailable("request");
  }
  if (req.status === "none") throw notFound(`request ${requestId} not found`);
  await upsertRequests(db, [req]);
  const [ctx, offers] = await Promise.all([marketCtx(), openOfferRows()]);
  if (!ctx.state) throw unavailable("protocol config");
  const asset = ctx.state.assets.find((a) => a.address.toLowerCase() === req.asset.toLowerCase());
  return suggestMatches(toMatchRequest(req), offers.map(toMatchOffer), {
    minInitialCrBps: ctx.state.risk.minInitialCrBps,
    minLoan: asset?.minLoan ?? 0n,
    price: ctx.price,
    now: ctx.now,
    decimals: decimalsOf(req.asset, ctx.state),
  });
}

export async function requestsForOffer(offerId: string): Promise<{ offerId: string; requests: RequestForOffer[] }> {
  if (!deployment()) throw notFound(`offer ${offerId} not found (contracts not deployed)`);
  const chainId = getChainId();
  const db = await getDb();
  let offer: OfferRow;
  try {
    const [live] = await withTimeout(readOffers([BigInt(offerId)]), 6_000);
    if (!live) throw new Error("read failed");
    offer = offerRow(chainId, live);
  } catch {
    throw unavailable("offer");
  }
  if (offer.status === "none") throw notFound(`offer ${offerId} not found`);
  await upsertOffers(db, [offer]);
  const [ctx, requests] = await Promise.all([marketCtx(), openRequestRows(offer.asset)]);
  if (!ctx.state) throw unavailable("protocol config");
  const asset = ctx.state.assets.find((a) => a.address.toLowerCase() === offer.asset.toLowerCase());
  return {
    offerId,
    requests: suggestRequestsForOffer(toMatchOffer(offer), requests.map(toMatchRequest), {
      minInitialCrBps: ctx.state.risk.minInitialCrBps,
      minLoan: asset?.minLoan ?? 0n,
      price: ctx.price,
      now: ctx.now,
      decimals: decimalsOf(offer.asset, ctx.state),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// /api/stats
// ---------------------------------------------------------------------------------------------

export async function stats(): Promise<StatsResponse> {
  const d = deployment();
  const out: StatsResponse = {
    perAsset: [], activeLoans: 0, totalLoans: 0, openOffers: 0, openRequests: 0, avgOfferAprBps: null,
    btcLocked: "0", source: "chain", indexedToBlock: null,
  };
  if (!d) return out;
  const db = await getDb();
  const chainId = getChainId();
  const now = nowSec();

  const [[active], [totalL], [openO], [openR], [avg], sync] = await Promise.all([
    db.select({ n: count() }).from(L).where(and(eq(L.chainId, chainId), eq(L.status, "active"))),
    db.select({ n: count() }).from(L).where(eq(L.chainId, chainId)),
    db.select({ n: count() }).from(O).where(and(eq(O.chainId, chainId), eq(O.status, "open"), gte(O.expiry, now))),
    db.select({ n: count() }).from(R).where(and(eq(R.chainId, chainId), eq(R.status, "open"), gte(R.expiry, now))),
    db
      .select({
        w: sql<string | null>`sum(${O.remaining} * ${O.aprBps})`,
        s: sql<string | null>`sum(${O.remaining})`,
      })
      .from(O)
      .where(and(eq(O.chainId, chainId), eq(O.status, "open"), gte(O.expiry, now))),
    getSyncState(db, chainId),
  ]);
  out.activeLoans = Number(active.n);
  out.totalLoans = Number(totalL.n);
  out.openOffers = Number(openO.n);
  out.openRequests = Number(openR.n);
  // Liquidity-weighted by remaining amount (assets with different decimals would skew this; MUSD-only in practice).
  if (avg.s && BigInt(avg.s) > 0n) out.avgOfferAprBps = Number(BigInt(avg.w!) / BigInt(avg.s));
  out.indexedToBlock = sync?.lastBlock ?? null;

  try {
    const st = await withTimeout(readProtocolState(), 5_000);
    const assets = st.assets.map((a) => a.address);
    const fns = ["totalAvailable", "totalReserved", "totalLent", "totalInterestPaid"] as const;
    const calls: Call[] = assets.flatMap((a) => fns.map((fn) => ({ address: d.contracts.vault, abi: abis.vault, functionName: fn, args: [a] })));
    calls.push(
      { address: d.contracts.collateral, abi: abis.collateral, functionName: "totalLockedInRequests" },
      { address: d.contracts.collateral, abi: abis.collateral, functionName: "totalLockedInLoans" },
    );
    const res = await withTimeout(readMany(calls), 5_000);
    out.perAsset = assets.map((asset, i) => {
      const v = (k: number) => must<bigint>(res[i * 4 + k]).toString();
      return { asset, totalAvailable: v(0), totalReserved: v(1), totalLent: v(2), totalInterestPaid: v(3) };
    });
    const n = assets.length * 4;
    out.btcLocked = (must<bigint>(res[n]) + must<bigint>(res[n + 1])).toString();
  } catch {
    // RPC down: counts from the index are still returned; totals stay empty/zero.
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// /api/portfolio/[address]
// ---------------------------------------------------------------------------------------------

export async function portfolio(address: Address): Promise<PortfolioResponse> {
  const d = deployment();
  const out: PortfolioResponse = { address, lender: [], freeCollateral: "0", loansAsLender: [], loansAsBorrower: [], offers: [], requests: [] };
  if (!d) return out;
  const db = await getDb();
  const chainId = getChainId();
  const ctx = await marketCtx();

  const [offerRows, requestRows, loanRows] = await Promise.all([
    db.select().from(O).where(and(eq(O.chainId, chainId), eq(O.lender, address))).orderBy(sql`${O.id} desc`).limit(200),
    db.select().from(R).where(and(eq(R.chainId, chainId), eq(R.borrower, address))).orderBy(sql`${R.id} desc`).limit(200),
    db
      .select()
      .from(L)
      .where(and(eq(L.chainId, chainId), sql`(${L.lender} = ${address} OR ${L.borrower} = ${address})`))
      .orderBy(sql`${L.id} desc`)
      .limit(200),
  ]);

  // Live: vault balances per asset + free collateral.
  const assets = ctx.state?.assets.map((a) => a.address) ?? getAssets().map((a) => a.address);
  const fns = ["available", "reserved", "lent", "interestEarned"] as const;
  try {
    const calls: Call[] = assets.flatMap((a) => fns.map((fn) => ({ address: d.contracts.vault, abi: abis.vault, functionName: fn, args: [address, a] })));
    calls.push({ address: d.contracts.collateral, abi: abis.collateral, functionName: "freeCollateral", args: [address] });
    const res = await withTimeout(readMany(calls), 5_000);
    out.lender = assets.map((asset, i) => {
      const v = (k: number) => {
        const r = res[i * 4 + k];
        return r.ok ? String(r.result) : "0";
      };
      return { asset, available: v(0), reserved: v(1), lent: v(2), interestEarned: v(3) };
    });
    const free = res[assets.length * 4];
    out.freeCollateral = free.ok ? String(free.result) : "0";
  } catch {
    throw unavailable("balances");
  }

  const loanDtos = await loanDTOs(db, chainId, loanRows, ctx, true);
  out.loansAsLender = loanDtos.filter((l) => l.lender === address);
  out.loansAsBorrower = loanDtos.filter((l) => l.borrower === address);
  out.offers = offerRows.map((r) => offerDTO(r, ctx.now));
  out.requests = requestRows.map((r) => requestDTO(r, ctx.now, ctx.price, decimalsOf(r.asset, ctx.state)));
  return out;
}

