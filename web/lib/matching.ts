/**
 * Pure, deterministic matcher (docs/ARCHITECTURE.md "Matching"). No server-only imports: the UI can use it too.
 *
 * suggestMatches(request, offers, ctx):
 *  1. Exclude offers that are not open ("not_open"), expired ("expired"), for another asset ("asset"),
 *     owned by the borrower ("self"), with APR > request max APR ("apr"), or maxDuration < request duration ("duration").
 *  2. Sort the rest by APR asc, then expiry asc, then id asc.
 *  3. Fill greedily: fill = min(unfilled, offer.remaining). A fill below minLoan that does not complete the request
 *     is excluded ("size"). Each fill's collateral share is computed exactly like LoanMarketplace
 *     (finance.fillCollateralShare, simulating the request's state after the earlier fills) and its CR must be
 *     >= max(offer.minCrBps, ctx.minInitialCrBps) at ctx.price, else the offer is excluded ("collateral").
 *  4. state = unmatched | partially_matchable | fully_matchable.
 *
 * If ctx.price is null (oracle stale or unreachable) nothing is matchable: every offer that passes step 1 is
 * excluded with reason "collateral", because the contract also refuses to match without a fresh price.
 * `excluded` is ordered by offer id. If the request itself is not open, expired or already fully filled, there are no fills and no exclusions.
 * "Expired" means now > expiry (same rule as api-types).
 */
import type { MatchFill, MatchSuggestion, OfferDTO, RequestDTO } from "./api-types";
import { collateralRatioBps, fillCollateralShare } from "./finance";

export interface MatchableOffer {
  id: bigint;
  lender: string;
  asset: string;
  remaining: bigint;
  aprBps: number;
  maxDuration: number;
  minCrBps: number;
  expiry: number;
  /** on-chain status is Open (expiry is checked separately) */
  open: boolean;
}

export interface MatchableRequest {
  id: bigint;
  borrower: string;
  asset: string;
  amount: bigint;
  filled: bigint;
  maxAprBps: number;
  duration: number;
  collateral: bigint;
  collateralRemaining: bigint;
  expiry: number;
  open: boolean;
}

export interface MatchContext {
  minInitialCrBps: number | bigint;
  /** AssetConfig.minLoan of the request's asset */
  minLoan: bigint;
  /** USD per BTC, 18 decimals; null when the oracle price is unavailable */
  price: bigint | null;
  /** unix seconds */
  now: number;
  /** decimals of the request's asset */
  decimals: number;
}

export type ExcludeReason = MatchSuggestion["excluded"][number]["reason"];

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Lowest APR, then earliest expiry, then lowest id. */
export function compareOffers(a: MatchableOffer, b: MatchableOffer): number {
  return a.aprBps - b.aprBps || a.expiry - b.expiry || cmpBig(a.id, b.id);
}

/** Highest max APR, then earliest expiry, then lowest id. */
export function compareRequestsForOffer(a: MatchableRequest, b: MatchableRequest): number {
  return b.maxAprBps - a.maxAprBps || a.expiry - b.expiry || cmpBig(a.id, b.id);
}

function staticExclusion(request: MatchableRequest, offer: MatchableOffer, now: number): ExcludeReason | null {
  if (!offer.open) return "not_open";
  if (now > offer.expiry) return "expired";
  if (!sameAddr(offer.asset, request.asset)) return "asset";
  if (sameAddr(offer.lender, request.borrower)) return "self";
  if (offer.aprBps > request.maxAprBps) return "apr";
  if (offer.maxDuration < request.duration) return "duration";
  if (offer.remaining <= 0n) return "size";
  return null;
}

export function requestIsFillable(request: MatchableRequest, now: number): boolean {
  return request.open && now <= request.expiry && request.amount > request.filled;
}

export function suggestMatches(request: MatchableRequest, offers: MatchableOffer[], ctx: MatchContext): MatchSuggestion {
  const unfilledStart = request.amount > request.filled ? request.amount - request.filled : 0n;
  const result: MatchSuggestion = {
    requestId: request.id.toString(),
    fills: [],
    fillable: "0",
    unfilled: unfilledStart.toString(),
    state: "unmatched",
    excluded: [],
  };
  if (!requestIsFillable(request, ctx.now)) return result;

  const eligible: MatchableOffer[] = [];
  for (const offer of [...offers].sort((a, b) => cmpBig(a.id, b.id))) {
    const reason = staticExclusion(request, offer, ctx.now);
    if (reason) result.excluded.push({ offerId: offer.id.toString(), reason });
    else eligible.push(offer);
  }
  eligible.sort(compareOffers);

  // Simulated request state as fills are applied (mirrors LoanMarketplace bookkeeping).
  let filled = request.filled;
  let collateralRemaining = request.collateralRemaining;
  const minInitial = BigInt(ctx.minInitialCrBps);

  for (const offer of eligible) {
    const unfilled = request.amount - filled;
    if (unfilled === 0n) break; // fully matched; the rest are simply not needed
    if (ctx.price === null) {
      result.excluded.push({ offerId: offer.id.toString(), reason: "collateral" });
      continue;
    }
    const fill = offer.remaining < unfilled ? offer.remaining : unfilled;
    const completes = fill === unfilled;
    if (!completes && fill < ctx.minLoan) {
      result.excluded.push({ offerId: offer.id.toString(), reason: "size" });
      continue;
    }
    const share = fillCollateralShare(
      { collateral: request.collateral, collateralRemaining, amount: request.amount, filled },
      fill,
    );
    const cr = collateralRatioBps(share, ctx.price, fill, ctx.decimals);
    const required = maxBig(BigInt(offer.minCrBps), minInitial);
    if (cr < required) {
      result.excluded.push({ offerId: offer.id.toString(), reason: "collateral" });
      continue;
    }
    const f: MatchFill = {
      offerId: offer.id.toString(),
      lender: offer.lender as `0x${string}`,
      amount: fill.toString(),
      aprBps: offer.aprBps,
      collateralShare: share.toString(),
      crBps: cr.toString(),
    };
    result.fills.push(f);
    filled += fill;
    collateralRemaining -= share;
  }

  result.excluded.sort((a, b) => cmpBig(BigInt(a.offerId), BigInt(b.offerId)));
  const fillable = filled - request.filled;
  result.fillable = fillable.toString();
  result.unfilled = (request.amount - filled).toString();
  result.state = fillable === 0n ? "unmatched" : filled === request.amount ? "fully_matchable" : "partially_matchable";
  return result;
}

export interface RequestForOffer {
  requestId: string;
  amount: string;
  collateralShare: string;
  crBps: string;
}

/**
 * Open requests `offer` can fill on its own, best first (highest max APR, earliest expiry, lowest id).
 * Each suggestion is independent: amount = min(request unfilled, offer.remaining).
 * `ctx.minLoan` / `ctx.decimals` are those of the offer's asset (requests for other assets are skipped).
 */
export function suggestRequestsForOffer(
  offer: MatchableOffer,
  requests: MatchableRequest[],
  ctx: MatchContext,
): RequestForOffer[] {
  if (!offer.open || ctx.now > offer.expiry || offer.remaining <= 0n || ctx.price === null) return [];
  const minInitial = BigInt(ctx.minInitialCrBps);
  const required = maxBig(BigInt(offer.minCrBps), minInitial);
  const candidates = requests
    .filter(
      (r) =>
        requestIsFillable(r, ctx.now) &&
        sameAddr(r.asset, offer.asset) &&
        !sameAddr(r.borrower, offer.lender) &&
        offer.aprBps <= r.maxAprBps &&
        r.duration <= offer.maxDuration,
    )
    .sort(compareRequestsForOffer);
  const out: RequestForOffer[] = [];
  for (const r of candidates) {
    const unfilled = r.amount - r.filled;
    const fill = offer.remaining < unfilled ? offer.remaining : unfilled;
    if (fill !== unfilled && fill < ctx.minLoan) continue;
    const share = fillCollateralShare(r, fill);
    const cr = collateralRatioBps(share, ctx.price, fill, ctx.decimals);
    if (cr < required) continue;
    out.push({ requestId: r.id.toString(), amount: fill.toString(), collateralShare: share.toString(), crBps: cr.toString() });
  }
  return out;
}

/** Convert API DTOs (decimal strings) to matcher inputs, for client-side previews. */
export function offerFromDTO(o: OfferDTO): MatchableOffer {
  return {
    id: BigInt(o.id),
    lender: o.lender,
    asset: o.asset,
    remaining: BigInt(o.remaining),
    aprBps: o.aprBps,
    maxDuration: o.maxDuration,
    minCrBps: o.minCrBps,
    expiry: o.expiry,
    open: o.status === "open" || o.status === "expired",
  };
}

export function requestFromDTO(r: RequestDTO): MatchableRequest {
  return {
    id: BigInt(r.id),
    borrower: r.borrower,
    asset: r.asset,
    amount: BigInt(r.amount),
    filled: BigInt(r.filled),
    maxAprBps: r.maxAprBps,
    duration: r.duration,
    collateral: BigInt(r.collateral),
    collateralRemaining: BigInt(r.collateralRemaining),
    expiry: r.expiry,
    open: r.status === "open" || r.status === "partially_filled" || r.status === "expired",
  };
}
