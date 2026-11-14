/**
 * LiquidityX index schema (drizzle). The database is a rebuildable index of contract events;
 * the contracts are the source of truth. Big numbers are numeric(78,0) (returned as strings), never JS numbers.
 * The matching DDL lives in ./ddl.ts and is applied idempotently at startup (no migration step needed).
 */
import { bigint, boolean, integer, jsonb, numeric, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

const u256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const ts = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable(
  "users",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    firstSeenBlock: u256("first_seen_block").notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastActiveAt: ts("last_active_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address] })],
);

export const lendingOffers = pgTable(
  "lending_offers",
  {
    chainId: integer("chain_id").notNull(),
    id: u256("id").notNull(),
    lender: text("lender").notNull(),
    asset: text("asset").notNull(),
    amount: u256("amount").notNull(),
    remaining: u256("remaining").notNull(),
    aprBps: integer("apr_bps").notNull(),
    maxDuration: integer("max_duration").notNull(),
    minCrBps: integer("min_cr_bps").notNull(),
    expiry: ts("expiry").notNull(),
    createdAt: ts("created_at").notNull(),
    fills: integer("fills").notNull(),
    status: text("status").notNull(), // on-chain status: open | filled | cancelled
    txHash: text("tx_hash"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.id] })],
);

export const borrowingRequests = pgTable(
  "borrowing_requests",
  {
    chainId: integer("chain_id").notNull(),
    id: u256("id").notNull(),
    borrower: text("borrower").notNull(),
    asset: text("asset").notNull(),
    amount: u256("amount").notNull(),
    filled: u256("filled").notNull(),
    maxAprBps: integer("max_apr_bps").notNull(),
    duration: integer("duration").notNull(),
    collateral: u256("collateral").notNull(),
    collateralRemaining: u256("collateral_remaining").notNull(),
    expiry: ts("expiry").notNull(),
    createdAt: ts("created_at").notNull(),
    fills: integer("fills").notNull(),
    status: text("status").notNull(), // on-chain status: open | filled | cancelled
    txHash: text("tx_hash"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.id] })],
);

export const loans = pgTable(
  "loans",
  {
    chainId: integer("chain_id").notNull(),
    id: u256("id").notNull(),
    offerId: u256("offer_id").notNull(),
    requestId: u256("request_id").notNull(),
    lender: text("lender").notNull(),
    borrower: text("borrower").notNull(),
    asset: text("asset").notNull(),
    principal: u256("principal").notNull(),
    outstandingPrincipal: u256("outstanding_principal").notNull(),
    accruedInterest: u256("accrued_interest").notNull(),
    interestPaid: u256("interest_paid").notNull(),
    principalRepaid: u256("principal_repaid").notNull(),
    collateral: u256("collateral").notNull(),
    aprBps: integer("apr_bps").notNull(),
    start: ts("start").notNull(),
    maturity: ts("maturity").notNull(),
    lastAccrual: ts("last_accrual").notNull(),
    closedAt: ts("closed_at").notNull(),
    status: text("status").notNull(), // on-chain status: active | repaid | liquidated
    txHash: text("tx_hash"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.id] })],
);

export const repayments = pgTable(
  "repayments",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: u256("block_number").notNull(),
    timestamp: ts("timestamp").notNull(),
    loanId: u256("loan_id").notNull(),
    payer: text("payer").notNull(),
    interestPaid: u256("interest_paid").notNull(),
    principalPaid: u256("principal_paid").notNull(),
    outstandingPrincipal: u256("outstanding_principal").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] })],
);

export const indexedEvents = pgTable(
  "indexed_events",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: u256("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    timestamp: ts("timestamp").notNull(),
    contract: text("contract").notNull(), // ContractKey
    address: text("address").notNull(),
    eventName: text("event_name").notNull(),
    kind: text("kind"), // ActivityKind, null for non-activity events
    account: text("account"),
    counterparty: text("counterparty"),
    asset: text("asset"),
    amount: u256("amount"),
    btcAmount: u256("btc_amount"),
    offerId: u256("offer_id"),
    requestId: u256("request_id"),
    loanId: u256("loan_id"),
    args: jsonb("args").notNull(),
  },
  (t) => [uniqueIndex("indexed_events_uniq").on(t.chainId, t.txHash, t.logIndex)],
);

export const priceSnapshots = pgTable(
  "price_snapshots",
  {
    chainId: integer("chain_id").notNull(),
    observedAt: ts("observed_at").notNull(),
    ok: boolean("ok").notNull(),
    price: u256("price"),
    updatedAt: ts("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.observedAt] })],
);

/** Daily per-asset rollup, recomputed from indexed_events after each sync batch. */
export const marketplaceAnalytics = pgTable(
  "marketplace_analytics",
  {
    chainId: integer("chain_id").notNull(),
    day: text("day").notNull(), // YYYY-MM-DD (UTC)
    asset: text("asset").notNull(),
    loansOpened: integer("loans_opened").notNull(),
    volume: u256("volume").notNull(),
    repayments: integer("repayments").notNull(),
    liquidations: integer("liquidations").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.day, t.asset] })],
);

export const syncState = pgTable("sync_state", {
  chainId: integer("chain_id").primaryKey(),
  lastBlock: u256("last_block").notNull(),
  lastBlockHash: text("last_block_hash"),
  prevBlock: u256("prev_block"),
  prevBlockHash: text("prev_block_hash"),
  headBlock: u256("head_block"),
  lastSyncAt: ts("last_sync_at"),
  lastError: text("last_error"),
  lastErrorAt: ts("last_error_at"),
});
