/**
 * FROZEN response shapes for the LiquidityX HTTP API (web/app/api/**). Backend implements, frontend consumes.
 * All token amounts, wei values and prices are base-unit integers encoded as decimal STRINGS (parse with BigInt).
 * Timestamps are unix seconds (number). Addresses are checksummed. Ids are decimal strings.
 * Errors: HTTP 4xx/5xx with body { error: { code: string, message: string } }.
 */

export type OfferStatus = "open" | "filled" | "cancelled" | "expired"; // expired = on-chain Open but now > expiry
export type RequestStatus = "open" | "partially_filled" | "filled" | "cancelled" | "expired";
export type LoanStatus = "active" | "overdue" | "repaid" | "liquidated"; // overdue = Active && now > maturity

export interface AssetInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  enabled: boolean;
  minLoan: string;
  maxLoan: string;
  officiallyListed: boolean; // true only for addresses in Mezo's official contracts reference
}

export interface ConfigResponse {
  chainId: number;
  deployed: boolean; // false => contracts not deployed; UI shows a "not deployed yet" state
  contracts: Record<"oracle" | "config" | "vault" | "collateral" | "loans" | "marketplace" | "liquidation", `0x${string}` | null>;
  startBlock: string | null;
  assets: AssetInfo[];
  risk: {
    minInitialCrBps: number; liquidationCrBps: number; liquidationBonusBps: number;
    minAprBps: number; maxAprBps: number; minDuration: number; maxDuration: number;
    gracePeriod: number; maxListingLifetime: number; maxCollateralPerLoan: string;
  } | null;
  paused: boolean;
  explorerUrl: string;
}

export interface PriceResponse { ok: boolean; price: string | null; updatedAt: number | null; source: `0x${string}`; maxStaleness: number | null }

export interface OfferDTO {
  id: string; lender: `0x${string}`; asset: `0x${string}`; amount: string; remaining: string;
  aprBps: number; maxDuration: number; minCrBps: number; expiry: number; createdAt: number; fills: number;
  status: OfferStatus; txHash: `0x${string}` | null;
}

export interface RequestDTO {
  id: string; borrower: `0x${string}`; asset: `0x${string}`; amount: string; filled: string;
  maxAprBps: number; duration: number; collateral: string; collateralRemaining: string;
  expiry: number; createdAt: number; fills: number; status: RequestStatus;
  crBps: string | null; // current CR of the unfilled part at the live price, null if price unavailable
  txHash: `0x${string}` | null;
}

export interface LoanDTO {
  id: string; offerId: string; requestId: string; lender: `0x${string}`; borrower: `0x${string}`; asset: `0x${string}`;
  principal: string; outstandingPrincipal: string; accruedInterest: string; interestPaid: string; principalRepaid: string;
  collateral: string; aprBps: number; start: number; maturity: number; lastAccrual: number; closedAt: number;
  status: LoanStatus;
  owed: { principal: string; interest: string; total: string }; // as of server "now"
  crBps: string | null; liquidatable: "none" | "undercollateralized" | "overdue"; priceOk: boolean;
  txHash: `0x${string}` | null;
}

export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number }

export type ActivityKind =
  | "deposit" | "withdraw" | "offer_created" | "offer_cancelled" | "request_created" | "request_cancelled"
  | "matched" | "loan_activated" | "repayment" | "loan_repaid" | "collateral_deposited" | "collateral_withdrawn"
  | "collateral_released" | "liquidated";

export interface ActivityDTO {
  id: string; // `${txHash}:${logIndex}`
  kind: ActivityKind; txHash: `0x${string}`; blockNumber: string; logIndex: number; timestamp: number;
  account: `0x${string}`; // primary actor
  counterparty: `0x${string}` | null;
  asset: `0x${string}` | null; amount: string | null; // stablecoin amount if relevant
  btcAmount: string | null; // BTC wei if relevant
  offerId: string | null; requestId: string | null; loanId: string | null;
}

export interface MatchFill { offerId: string; lender: `0x${string}`; amount: string; aprBps: number; collateralShare: string; crBps: string }
export interface MatchSuggestion {
  requestId: string;
  fills: MatchFill[]; // ordered: lowest APR, earliest expiry, lowest id
  fillable: string; // sum of fill amounts
  unfilled: string;
  state: "unmatched" | "partially_matchable" | "fully_matchable";
  excluded: { offerId: string; reason: "asset" | "apr" | "duration" | "collateral" | "expired" | "self" | "size" | "not_open" }[];
}

export interface StatsResponse {
  perAsset: { asset: `0x${string}`; totalAvailable: string; totalReserved: string; totalLent: string; totalInterestPaid: string }[];
  activeLoans: number; totalLoans: number; openOffers: number; openRequests: number;
  avgOfferAprBps: number | null; // liquidity-weighted over open, unexpired offers
  btcLocked: string; // CollateralManager locked in requests + loans
  source: "chain"; // totals are read from contract views, counts from the index reconciled against chain
  indexedToBlock: string | null;
}

export interface PortfolioResponse {
  address: `0x${string}`;
  lender: { asset: `0x${string}`; available: string; reserved: string; lent: string; interestEarned: string }[];
  freeCollateral: string;
  loansAsLender: LoanDTO[]; loansAsBorrower: LoanDTO[];
  offers: OfferDTO[]; requests: RequestDTO[];
}
