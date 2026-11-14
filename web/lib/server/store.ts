import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Address } from "viem";
import type { LoanDTO, OfferDTO, OfferStatus, RequestDTO, RequestStatus, LoanStatus } from "@/lib/api-types";
import { collateralRatioBps, owedAt } from "@/lib/finance";
import { schema, type Db } from "./db";
import {
  LIQ_REASON,
  LOAN_STATUS,
  OFFER_STATUS,
  REQUEST_STATUS,
  type ChainLoan,
  type ChainOffer,
  type ChainRequest,
  type LoanHealth,
} from "./rpc";

const { lendingOffers, borrowingRequests, loans } = schema;

export type OfferRow = typeof lendingOffers.$inferSelect;
export type RequestRow = typeof borrowingRequests.$inferSelect;
export type LoanRow = typeof loans.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------------------------
// chain struct -> row
// ---------------------------------------------------------------------------------------------

export function offerRow(chainId: number, o: ChainOffer): OfferRow {
  return {
    chainId,
    id: o.id.toString(),
    lender: o.lender,
    asset: o.asset,
    amount: o.amount.toString(),
    remaining: o.remaining.toString(),
    aprBps: Number(o.aprBps),
    maxDuration: Number(o.maxDuration),
    minCrBps: Number(o.minCrBps),
    expiry: Number(o.expiry),
    createdAt: Number(o.createdAt),
    fills: Number(o.fills),
    status: OFFER_STATUS[Number(o.status)] ?? "none",
    txHash: null,
    updatedAt: nowSec(),
  };
}

export function requestRow(chainId: number, r: ChainRequest): RequestRow {
  return {
    chainId,
    id: r.id.toString(),
    borrower: r.borrower,
    asset: r.asset,
    amount: r.amount.toString(),
    filled: r.filled.toString(),
    maxAprBps: Number(r.maxAprBps),
    duration: Number(r.duration),
    collateral: r.collateral.toString(),
    collateralRemaining: r.collateralRemaining.toString(),
    expiry: Number(r.expiry),
    createdAt: Number(r.createdAt),
    fills: Number(r.fills),
    status: REQUEST_STATUS[Number(r.status)] ?? "none",
    txHash: null,
    updatedAt: nowSec(),
  };
}

export function loanRow(chainId: number, l: ChainLoan): LoanRow {
  return {
    chainId,
    id: l.id.toString(),
    offerId: l.offerId.toString(),
    requestId: l.requestId.toString(),
    lender: l.lender,
    borrower: l.borrower,
    asset: l.asset,
    principal: l.principal.toString(),
    outstandingPrincipal: l.outstandingPrincipal.toString(),
    accruedInterest: l.accruedInterest.toString(),
    interestPaid: l.interestPaid.toString(),
    principalRepaid: l.principalRepaid.toString(),
    collateral: l.collateral.toString(),
    aprBps: Number(l.aprBps),
    start: Number(l.start),
    maturity: Number(l.maturity),
    lastAccrual: Number(l.lastAccrual),
    closedAt: Number(l.closedAt),
    status: LOAN_STATUS[Number(l.status)] ?? "none",
    txHash: null,
    updatedAt: nowSec(),
  };
}

// ---------------------------------------------------------------------------------------------
// upserts (chain wins; tx_hash is kept once known)
// ---------------------------------------------------------------------------------------------

function updateSet<T extends Record<string, unknown>>(table: { txHash: unknown }, row: T, keys: string[]) {
  const set: Record<string, unknown> = {};
  for (const k of Object.keys(row)) if (!keys.includes(k) && k !== "txHash") set[k] = row[k];
  set.txHash = sql`COALESCE(${table.txHash}, excluded.tx_hash)`;
  return set;
}

export async function upsertOffers(db: Db, rows: OfferRow[]) {
  for (const row of rows) {
    if (row.status === "none") {
      await db.delete(lendingOffers).where(and(eq(lendingOffers.chainId, row.chainId), eq(lendingOffers.id, row.id)));
      continue;
    }
    await db
      .insert(lendingOffers)
      .values(row)
      .onConflictDoUpdate({ target: [lendingOffers.chainId, lendingOffers.id], set: updateSet(lendingOffers, row, ["chainId", "id"]) });
  }
}

export async function upsertRequests(db: Db, rows: RequestRow[]) {
  for (const row of rows) {
    if (row.status === "none") {
      await db
        .delete(borrowingRequests)
        .where(and(eq(borrowingRequests.chainId, row.chainId), eq(borrowingRequests.id, row.id)));
      continue;
    }
    await db
      .insert(borrowingRequests)
      .values(row)
      .onConflictDoUpdate({
        target: [borrowingRequests.chainId, borrowingRequests.id],
        set: updateSet(borrowingRequests, row, ["chainId", "id"]),
      });
  }
}

export async function upsertLoans(db: Db, rows: LoanRow[]) {
  for (const row of rows) {
    if (row.status === "none") {
      await db.delete(loans).where(and(eq(loans.chainId, row.chainId), eq(loans.id, row.id)));
      continue;
    }
    await db
      .insert(loans)
      .values(row)
      .onConflictDoUpdate({ target: [loans.chainId, loans.id], set: updateSet(loans, row, ["chainId", "id"]) });
  }
}

export async function getOfferRows(db: Db, chainId: number, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(lendingOffers).where(and(eq(lendingOffers.chainId, chainId), inArray(lendingOffers.id, ids)));
}

// ---------------------------------------------------------------------------------------------
// status mapping (api-types)
// ---------------------------------------------------------------------------------------------

export function offerStatus(onchain: string, expiry: number, now: number): OfferStatus {
  if (onchain === "open") return now > expiry ? "expired" : "open";
  return onchain === "filled" ? "filled" : "cancelled";
}

export function requestStatus(onchain: string, filled: string, expiry: number, now: number): RequestStatus {
  if (onchain === "open") {
    if (now > expiry) return "expired";
    return BigInt(filled) > 0n ? "partially_filled" : "open";
  }
  return onchain === "filled" ? "filled" : "cancelled";
}

export function loanStatus(onchain: string, maturity: number, now: number): LoanStatus {
  if (onchain === "active") return now > maturity ? "overdue" : "active";
  return onchain === "liquidated" ? "liquidated" : "repaid";
}

// ---------------------------------------------------------------------------------------------
// row -> DTO
// ---------------------------------------------------------------------------------------------

export function offerDTO(r: OfferRow, now: number): OfferDTO {
  return {
    id: r.id,
    lender: r.lender as Address,
    asset: r.asset as Address,
    amount: r.amount,
    remaining: r.remaining,
    aprBps: r.aprBps,
    maxDuration: r.maxDuration,
    minCrBps: r.minCrBps,
    expiry: r.expiry,
    createdAt: r.createdAt,
    fills: r.fills,
    status: offerStatus(r.status, r.expiry, now),
    txHash: (r.txHash as `0x${string}` | null) ?? null,
  };
}

/** CR of the unfilled part at `price`; null without a price or when nothing is unfilled. */
export function requestCr(r: Pick<RequestRow, "amount" | "filled" | "collateralRemaining">, price: bigint | null, decimals: number): bigint | null {
  if (price === null) return null;
  const unfilled = BigInt(r.amount) - BigInt(r.filled);
  if (unfilled <= 0n) return null;
  return collateralRatioBps(BigInt(r.collateralRemaining), price, unfilled, decimals);
}

export function requestDTO(r: RequestRow, now: number, price: bigint | null, decimals: number): RequestDTO {
  const cr = requestCr(r, price, decimals);
  return {
    id: r.id,
    borrower: r.borrower as Address,
    asset: r.asset as Address,
    amount: r.amount,
    filled: r.filled,
    maxAprBps: r.maxAprBps,
    duration: r.duration,
    collateral: r.collateral,
    collateralRemaining: r.collateralRemaining,
    expiry: r.expiry,
    createdAt: r.createdAt,
    fills: r.fills,
    status: requestStatus(r.status, r.filled, r.expiry, now),
    crBps: cr === null ? null : cr.toString(),
    txHash: (r.txHash as `0x${string}` | null) ?? null,
  };
}

export interface LoanRisk {
  price: bigint | null;
  decimals: number;
  liquidationCrBps: number | null;
  gracePeriod: number | null;
}

/**
 * LoanDTO from a row (reconciled from chain). If `health` (LiquidationEngine.health, read live) is given it is used
 * as-is; otherwise CR and liquidatable are computed with finance.ts at the live price and risk params.
 */
export function loanDTO(r: LoanRow, now: number, risk: LoanRisk, health?: LoanHealth | null): LoanDTO {
  const active = r.status === "active";
  const owed = active
    ? owedAt(
        { outstandingPrincipal: BigInt(r.outstandingPrincipal), accruedInterest: BigInt(r.accruedInterest), aprBps: r.aprBps, lastAccrual: r.lastAccrual },
        now,
      )
    : { principal: 0n, interest: 0n, total: 0n };

  let crBps: string | null = null;
  let liquidatable: LoanDTO["liquidatable"] = "none";
  let priceOk = risk.price !== null;
  if (health) {
    priceOk = health.priceOk;
    crBps = health.priceOk && active ? health.crBps.toString() : null;
    liquidatable = active ? (LIQ_REASON[health.reason] ?? "none") : "none";
  } else if (active) {
    // Mirrors LiquidationEngine.health: undercollateralized first, then overdue (both need a fresh price to execute).
    if (risk.price !== null) {
      const cr = collateralRatioBps(BigInt(r.collateral), risk.price, owed.total, risk.decimals);
      crBps = cr.toString();
      if (risk.liquidationCrBps !== null && cr < BigInt(risk.liquidationCrBps)) liquidatable = "undercollateralized";
    }
    if (liquidatable === "none" && risk.gracePeriod !== null && now > r.maturity + risk.gracePeriod) liquidatable = "overdue";
  }

  return {
    id: r.id,
    offerId: r.offerId,
    requestId: r.requestId,
    lender: r.lender as Address,
    borrower: r.borrower as Address,
    asset: r.asset as Address,
    principal: r.principal,
    outstandingPrincipal: r.outstandingPrincipal,
    accruedInterest: r.accruedInterest,
    interestPaid: r.interestPaid,
    principalRepaid: r.principalRepaid,
    collateral: r.collateral,
    aprBps: r.aprBps,
    start: r.start,
    maturity: r.maturity,
    lastAccrual: r.lastAccrual,
    closedAt: r.closedAt,
    status: loanStatus(r.status, r.maturity, now),
    owed: { principal: owed.principal.toString(), interest: owed.interest.toString(), total: owed.total.toString() },
    crBps,
    liquidatable,
    priceOk,
    txHash: (r.txHash as `0x${string}` | null) ?? null,
  };
}
