import "server-only";
import { and, asc, count, desc, eq, gte, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Address } from "viem";
import type {
  ActivityDTO,
  ActivityKind,
  LoanDTO,
  LoanStatus,
  OfferDTO,
  OfferStatus,
  Paged,
  RequestDTO,
  RequestStatus,
} from "@/lib/api-types";
import { getDb, schema, type Db } from "./db";
import { chainId as getChainId, deployment } from "./context";
import {
  decimalsOf,
  priceOrNull,
  protocolStateOrNull,
  readHealth,
  readLoans,
  readOffers,
  readRequests,
  withTimeout,
  type LoanHealth,
  type ProtocolState,
} from "./rpc";
import {
  loanDTO,
  loanRow,
  offerDTO,
  offerRow,
  requestCr,
  requestDTO,
  requestRow,
  upsertLoans,
  upsertOffers,
  upsertRequests,
  type LoanRow,
  type OfferRow,
  type RequestRow,
} from "./store";

const { lendingOffers: O, borrowingRequests: R, loans: L, indexedEvents: E } = schema;

export const LIVE_TIMEOUT_MS = 3_000;
const nowSec = () => Math.floor(Date.now() / 1000);

/** Live market context (price + protocol state), each bounded by a timeout; null parts when unavailable. */
export interface MarketCtx {
  price: bigint | null;
  state: ProtocolState | null;
  now: number;
}
export async function marketCtx(): Promise<MarketCtx> {
  if (!deployment()) return { price: null, state: null, now: nowSec() };
  const [price, state] = await Promise.all([
    withTimeout(priceOrNull(), LIVE_TIMEOUT_MS).catch(() => null),
    withTimeout(protocolStateOrNull(), LIVE_TIMEOUT_MS).catch(() => null),
  ]);
  return { price, state, now: nowSec() };
}

function empty<T>(page: number, pageSize: number): Paged<T> {
  return { items: [], page, pageSize, total: 0 };
}

function orderBy(col: PgColumn | SQL, order: "asc" | "desc", idCol: PgColumn) {
  return order === "asc" ? [asc(col), asc(idCol)] : [desc(col), desc(idCol)];
}

// ---------------------------------------------------------------------------------------------
// Live refresh of a page of items (reconciliation on read). Falls back to DB rows on any failure.
// ---------------------------------------------------------------------------------------------

async function refreshOffers(db: Db, chainId: number, rows: OfferRow[]): Promise<OfferRow[]> {
  if (!rows.length) return rows;
  try {
    const live = await withTimeout(readOffers(rows.map((r) => BigInt(r.id))), LIVE_TIMEOUT_MS);
    const fresh = rows.map((r, i) => (live[i] ? { ...offerRow(chainId, live[i]!), id: r.id, txHash: r.txHash } : r));
    const changed = fresh.filter((f, i) => f !== rows[i] && differs(f, rows[i], ["remaining", "status", "fills", "amount"]));
    if (changed.length) await upsertOffers(db, changed);
    return fresh.filter((f) => f.status !== "none");
  } catch {
    return rows;
  }
}

async function refreshRequests(db: Db, chainId: number, rows: RequestRow[]): Promise<RequestRow[]> {
  if (!rows.length) return rows;
  try {
    const live = await withTimeout(readRequests(rows.map((r) => BigInt(r.id))), LIVE_TIMEOUT_MS);
    const fresh = rows.map((r, i) => (live[i] ? { ...requestRow(chainId, live[i]!), id: r.id, txHash: r.txHash } : r));
    const changed = fresh.filter((f, i) => f !== rows[i] && differs(f, rows[i], ["filled", "status", "fills", "collateralRemaining"]));
    if (changed.length) await upsertRequests(db, changed);
    return fresh.filter((f) => f.status !== "none");
  } catch {
    return rows;
  }
}

async function refreshLoans(
  db: Db,
  chainId: number,
  rows: LoanRow[],
): Promise<{ rows: LoanRow[]; health: (LoanHealth | null)[] }> {
  if (!rows.length) return { rows, health: [] };
  try {
    const ids = rows.map((r) => BigInt(r.id));
    const [live, health] = await withTimeout(Promise.all([readLoans(ids), readHealth(ids)]), LIVE_TIMEOUT_MS);
    const fresh = rows.map((r, i) => (live[i] ? { ...loanRow(chainId, live[i]!), id: r.id, txHash: r.txHash } : r));
    const changed = fresh.filter(
      (f, i) => f !== rows[i] && differs(f, rows[i], ["status", "outstandingPrincipal", "accruedInterest", "lastAccrual", "interestPaid"]),
    );
    if (changed.length) await upsertLoans(db, changed);
    return { rows: fresh.filter((f) => f.status !== "none"), health: health.filter((_, i) => fresh[i].status !== "none") };
  } catch {
    return { rows, health: rows.map(() => null) };
  }
}

function differs<T extends Record<string, unknown>>(a: T, b: T, keys: (keyof T)[]) {
  return keys.some((k) => String(a[k]) !== String(b[k]));
}

// ---------------------------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------------------------

export interface OfferQuery {
  asset?: Address; status?: OfferStatus; lender?: Address;
  minApr?: number; maxApr?: number; minAmount?: string; maxAmount?: string; maxDuration?: number;
  sort: "apr" | "amount" | "duration" | "expiry" | "created"; order?: "asc" | "desc";
  page: number; pageSize: number;
}

export function offerWhere(chainId: number, q: Partial<OfferQuery>, now: number): SQL {
  const c: (SQL | undefined)[] = [eq(O.chainId, chainId)];
  if (q.asset) c.push(eq(O.asset, q.asset));
  if (q.lender) c.push(eq(O.lender, q.lender));
  if (q.minApr !== undefined) c.push(gte(O.aprBps, q.minApr));
  if (q.maxApr !== undefined) c.push(lte(O.aprBps, q.maxApr));
  if (q.minAmount !== undefined) c.push(gte(O.remaining, q.minAmount));
  if (q.maxAmount !== undefined) c.push(lte(O.remaining, q.maxAmount));
  if (q.maxDuration !== undefined) c.push(lte(O.maxDuration, q.maxDuration));
  switch (q.status) {
    case "open": c.push(eq(O.status, "open"), gte(O.expiry, now)); break;
    case "expired": c.push(eq(O.status, "open"), lt(O.expiry, now)); break;
    case "filled": c.push(eq(O.status, "filled")); break;
    case "cancelled": c.push(eq(O.status, "cancelled")); break;
  }
  return and(...c)!;
}

export async function listOffers(q: OfferQuery, opts: { live?: boolean } = {}): Promise<Paged<OfferDTO>> {
  if (!deployment()) return empty(q.page, q.pageSize);
  const db = await getDb();
  const chainId = getChainId();
  const now = nowSec();
  const where = offerWhere(chainId, q, now);
  const sortCol = { apr: O.aprBps, amount: O.remaining, duration: O.maxDuration, expiry: O.expiry, created: O.createdAt }[q.sort];
  const order = q.order ?? (q.sort === "created" ? "desc" : "asc");
  const [{ total }] = await db.select({ total: count() }).from(O).where(where);
  let rows = await db
    .select()
    .from(O)
    .where(where)
    .orderBy(...orderBy(sortCol, order, O.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  if (opts.live !== false) rows = await refreshOffers(db, chainId, rows);
  return { items: rows.map((r) => offerDTO(r, now)), page: q.page, pageSize: q.pageSize, total };
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export interface RequestQuery {
  asset?: Address; status?: RequestStatus; borrower?: Address;
  minApr?: number; maxApr?: number; minAmount?: string; maxAmount?: string; maxDuration?: number; minCr?: number;
  sort: "apr" | "amount" | "duration" | "expiry" | "created" | "cr"; order?: "asc" | "desc";
  page: number; pageSize: number;
}

const unfilledExpr = sql`(${R.amount} - ${R.filled})`;

export function requestWhere(chainId: number, q: Partial<RequestQuery>, now: number): SQL {
  const c: (SQL | undefined)[] = [eq(R.chainId, chainId)];
  if (q.asset) c.push(eq(R.asset, q.asset));
  if (q.borrower) c.push(eq(R.borrower, q.borrower));
  if (q.minApr !== undefined) c.push(gte(R.maxAprBps, q.minApr));
  if (q.maxApr !== undefined) c.push(lte(R.maxAprBps, q.maxApr));
  if (q.minAmount !== undefined) c.push(sql`${unfilledExpr} >= ${q.minAmount}::numeric`);
  if (q.maxAmount !== undefined) c.push(sql`${unfilledExpr} <= ${q.maxAmount}::numeric`);
  if (q.maxDuration !== undefined) c.push(lte(R.duration, q.maxDuration));
  switch (q.status) {
    case "open": c.push(eq(R.status, "open"), gte(R.expiry, now), eq(R.filled, "0")); break;
    case "partially_filled": c.push(eq(R.status, "open"), gte(R.expiry, now), sql`${R.filled} > 0`); break;
    case "expired": c.push(eq(R.status, "open"), lt(R.expiry, now)); break;
    case "filled": c.push(eq(R.status, "filled")); break;
    case "cancelled": c.push(eq(R.status, "cancelled")); break;
  }
  return and(...c)!;
}

export async function listRequests(q: RequestQuery, opts: { live?: boolean; ctx?: MarketCtx } = {}): Promise<Paged<RequestDTO>> {
  if (!deployment()) return empty(q.page, q.pageSize);
  const db = await getDb();
  const chainId = getChainId();
  const ctx = opts.ctx ?? (await marketCtx());
  const now = ctx.now;
  const where = requestWhere(chainId, q, now);
  const order = q.order ?? (q.sort === "created" ? "desc" : q.sort === "cr" ? "desc" : "asc");
  const dec = (asset: string) => decimalsOf(asset, ctx.state);
  let rows: RequestRow[];
  let total: number;

  if (q.sort === "cr" || q.minCr !== undefined) {
    // CR depends on the live price, so filter/sort in memory (testnet scale). No price => no CR => minCr matches nothing.
    const all = await db.select().from(R).where(where);
    const withCr = all.map((r) => ({ r, cr: requestCr(r, ctx.price, dec(r.asset)) }));
    const filtered = q.minCr !== undefined ? withCr.filter((x) => x.cr !== null && x.cr >= BigInt(q.minCr!)) : withCr;
    const key = (x: (typeof filtered)[number]) => x.cr ?? -1n;
    const cmpOther = (a: RequestRow, b: RequestRow): number => {
      const pick = (r: RequestRow): bigint =>
        q.sort === "apr" ? BigInt(r.maxAprBps)
        : q.sort === "amount" ? BigInt(r.amount) - BigInt(r.filled)
        : q.sort === "duration" ? BigInt(r.duration)
        : q.sort === "expiry" ? BigInt(r.expiry)
        : BigInt(r.createdAt);
      const d = pick(a) - pick(b);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    };
    filtered.sort((a, b) => {
      let c = q.sort === "cr" ? (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) : cmpOther(a.r, b.r);
      if (c === 0) c = BigInt(a.r.id) < BigInt(b.r.id) ? -1 : 1;
      return order === "asc" ? c : -c;
    });
    total = filtered.length;
    rows = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((x) => x.r);
  } else {
    const sortCol = {
      apr: R.maxAprBps, amount: unfilledExpr, duration: R.duration, expiry: R.expiry, created: R.createdAt,
    }[q.sort];
    [{ total }] = await db.select({ total: count() }).from(R).where(where);
    rows = await db
      .select()
      .from(R)
      .where(where)
      .orderBy(...orderBy(sortCol as PgColumn, order, R.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
  }
  if (opts.live !== false) rows = await refreshRequests(db, chainId, rows);
  return { items: rows.map((r) => requestDTO(r, now, ctx.price, dec(r.asset))), page: q.page, pageSize: q.pageSize, total };
}

// ---------------------------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------------------------

export interface LoanQuery { address?: Address; role: "lender" | "borrower" | "any"; status?: LoanStatus; page: number; pageSize: number }

export function loanWhere(chainId: number, q: Partial<LoanQuery>, now: number): SQL {
  const c: (SQL | undefined)[] = [eq(L.chainId, chainId)];
  if (q.address) {
    if (q.role === "lender") c.push(eq(L.lender, q.address));
    else if (q.role === "borrower") c.push(eq(L.borrower, q.address));
    else c.push(or(eq(L.lender, q.address), eq(L.borrower, q.address)));
  }
  switch (q.status) {
    case "active": c.push(eq(L.status, "active"), gte(L.maturity, now)); break;
    case "overdue": c.push(eq(L.status, "active"), lt(L.maturity, now)); break;
    case "repaid": c.push(eq(L.status, "repaid")); break;
    case "liquidated": c.push(eq(L.status, "liquidated")); break;
  }
  return and(...c)!;
}

export async function loanDTOs(db: Db, chainId: number, rows: LoanRow[], ctx: MarketCtx, live: boolean): Promise<LoanDTO[]> {
  let health: (LoanHealth | null)[] = rows.map(() => null);
  if (live) ({ rows, health } = await refreshLoans(db, chainId, rows));
  return rows.map((r, i) =>
    loanDTO(
      r,
      ctx.now,
      {
        price: ctx.price,
        decimals: decimalsOf(r.asset, ctx.state),
        liquidationCrBps: ctx.state?.risk.liquidationCrBps ?? null,
        gracePeriod: ctx.state?.risk.gracePeriod ?? null,
      },
      health[i],
    ),
  );
}

export async function listLoans(q: LoanQuery, opts: { live?: boolean; ctx?: MarketCtx } = {}): Promise<Paged<LoanDTO>> {
  if (!deployment()) return empty(q.page, q.pageSize);
  const db = await getDb();
  const chainId = getChainId();
  const ctx = opts.ctx ?? (await marketCtx());
  const where = loanWhere(chainId, q, ctx.now);
  const [{ total }] = await db.select({ total: count() }).from(L).where(where);
  const rows = await db.select().from(L).where(where).orderBy(desc(L.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return { items: await loanDTOs(db, chainId, rows, ctx, opts.live !== false), page: q.page, pageSize: q.pageSize, total };
}

// ---------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------

export interface ActivityQuery {
  address?: Address; loanId?: string; offerId?: string; requestId?: string; kind?: ActivityKind;
  page: number; pageSize: number;
}

export function activityDTO(r: typeof E.$inferSelect): ActivityDTO {
  return {
    id: `${r.txHash}:${r.logIndex}`,
    kind: r.kind as ActivityKind,
    txHash: r.txHash as `0x${string}`,
    blockNumber: r.blockNumber,
    logIndex: r.logIndex,
    timestamp: r.timestamp,
    account: (r.account ?? "0x0000000000000000000000000000000000000000") as Address,
    counterparty: (r.counterparty as Address | null) ?? null,
    asset: (r.asset as Address | null) ?? null,
    amount: r.amount ?? null,
    btcAmount: r.btcAmount ?? null,
    offerId: r.offerId ?? null,
    requestId: r.requestId ?? null,
    loanId: r.loanId ?? null,
  };
}

export async function listActivity(q: ActivityQuery): Promise<Paged<ActivityDTO>> {
  if (!deployment()) return empty(q.page, q.pageSize);
  const db = await getDb();
  const chainId = getChainId();
  const c: (SQL | undefined)[] = [eq(E.chainId, chainId), sql`${E.kind} IS NOT NULL`];
  if (q.address) c.push(or(eq(E.account, q.address), eq(E.counterparty, q.address)));
  if (q.loanId) c.push(eq(E.loanId, q.loanId));
  if (q.offerId) c.push(eq(E.offerId, q.offerId));
  if (q.requestId) c.push(eq(E.requestId, q.requestId));
  if (q.kind) c.push(eq(E.kind, q.kind));
  const where = and(...c);
  const [{ total }] = await db.select({ total: count() }).from(E).where(where);
  const rows = await db
    .select()
    .from(E)
    .where(where)
    .orderBy(desc(E.blockNumber), desc(E.logIndex))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return { items: rows.map(activityDTO), page: q.page, pageSize: q.pageSize, total };
}

export async function loanActivity(loanId: string): Promise<ActivityDTO[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(E)
    .where(and(eq(E.chainId, getChainId()), eq(E.loanId, loanId), sql`${E.kind} IS NOT NULL`))
    .orderBy(asc(E.blockNumber), asc(E.logIndex));
  return rows.map(activityDTO);
}

// ---------------------------------------------------------------------------------------------
// Helpers for matches / portfolio
// ---------------------------------------------------------------------------------------------

/** All on-chain-Open offers (including expired ones, so the matcher can explain exclusions), refreshed live. */
export async function openOfferRows(limit = 500): Promise<OfferRow[]> {
  const db = await getDb();
  const chainId = getChainId();
  const rows = await db
    .select()
    .from(O)
    .where(and(eq(O.chainId, chainId), eq(O.status, "open")))
    .orderBy(asc(O.aprBps), asc(O.expiry), asc(O.id))
    .limit(limit);
  return refreshOffers(db, chainId, rows);
}

export async function openRequestRows(asset: string | null, limit = 500): Promise<RequestRow[]> {
  const db = await getDb();
  const chainId = getChainId();
  const rows = await db
    .select()
    .from(R)
    .where(and(eq(R.chainId, chainId), eq(R.status, "open"), asset ? eq(R.asset, asset) : undefined))
    .orderBy(desc(R.maxAprBps), asc(R.expiry), asc(R.id))
    .limit(limit);
  return refreshRequests(db, chainId, rows);
}

export { O as offersTable, R as requestsTable, L as loansTable };
