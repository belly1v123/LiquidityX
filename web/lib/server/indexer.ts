import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Address, Log } from "viem";
import { getDb, schema, type Db } from "./db";
import { chainId as getChainId, deployment, getClient } from "./context";
import { contractMap, decodeLog, eventFields, jsonArgs } from "./events";
import { readLoans, readOffers, readPrice, readRequests, withRetry, withTimeout } from "./rpc";
import { loanRow, offerRow, requestRow, upsertLoans, upsertOffers, upsertRequests } from "./store";

const { indexedEvents, repayments, users, syncState, priceSnapshots } = schema;

export const CONFIRMATIONS = 2n;
export const CHUNK_BLOCKS = 9_000n;
export const REORG_ROLLBACK = 50n;
export const SYNC_THROTTLE_MS = 10_000;

export interface SyncResult {
  fromBlock: string | null;
  toBlock: string | null;
  events: number;
  headBlock: string | null;
  reorg: boolean;
  done: boolean; // caught up to head - CONFIRMATIONS
  skipped?: "not_deployed";
}

interface Touched {
  offers: Set<string>;
  requests: Set<string>;
  loans: Set<string>;
}
const newTouched = (): Touched => ({ offers: new Set(), requests: new Set(), loans: new Set() });

// ---------------------------------------------------------------------------------------------
// Block timestamps (cached; Mezo returns blockTimestamp=0 in logs, so we read headers)
// ---------------------------------------------------------------------------------------------

const blockCache = new Map<bigint, { timestamp: number; hash: string }>();
const BLOCK_CACHE_MAX = 5_000;

async function blockInfo(n: bigint): Promise<{ timestamp: number; hash: string }> {
  const c = blockCache.get(n);
  if (c) return c;
  const b = await withRetry(() => getClient().getBlock({ blockNumber: n }));
  const v = { timestamp: Number(b.timestamp), hash: b.hash as string };
  if (blockCache.size >= BLOCK_CACHE_MAX) blockCache.delete(blockCache.keys().next().value as bigint);
  blockCache.set(n, v);
  return v;
}

async function timestampsFor(blocks: bigint[]): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  const uniq = [...new Set(blocks)];
  const LIMIT = 8;
  for (let i = 0; i < uniq.length; i += LIMIT) {
    const slice = uniq.slice(i, i + LIMIT);
    const infos = await Promise.all(slice.map((b) => blockInfo(b)));
    slice.forEach((b, j) => out.set(b, infos[j].timestamp));
  }
  return out;
}

export function clearIndexerCaches() {
  blockCache.clear();
  lastSyncStart = 0;
  inflight = null;
  lastSyncError = null;
}

// ---------------------------------------------------------------------------------------------
// Log processing (idempotent)
// ---------------------------------------------------------------------------------------------

/**
 * Inserts decoded logs into indexed_events (+ repayments, users). Each log is keyed by (chainId, txHash, logIndex)
 * with ON CONFLICT DO NOTHING, so processing the same log twice is a no-op. Returns the ids it touched.
 */
export async function processLogs(
  db: Db,
  chainId: number,
  logs: Log[],
  timestamps: Map<bigint, number>,
): Promise<{ inserted: number; touched: Touched }> {
  const d = deployment();
  const touched = newTouched();
  if (!d || logs.length === 0) return { inserted: 0, touched };
  const map = contractMap(d);
  let inserted = 0;

  await db.transaction(async (tx) => {
    for (const log of logs) {
      if (log.transactionHash == null || log.logIndex == null || log.blockNumber == null) continue; // pending
      const dec = decodeLog(log, map);
      if (!dec) continue;
      const f = eventFields(dec);
      const ts = timestamps.get(log.blockNumber) ?? 0;
      const res = await tx
        .insert(indexedEvents)
        .values({
          chainId,
          txHash: log.transactionHash,
          logIndex: Number(log.logIndex),
          blockNumber: log.blockNumber.toString(),
          blockHash: log.blockHash ?? "",
          timestamp: ts,
          contract: dec.contract,
          address: dec.address,
          eventName: dec.eventName,
          kind: f.kind,
          account: f.account,
          counterparty: f.counterparty,
          asset: f.asset,
          amount: f.amount?.toString() ?? null,
          btcAmount: f.btcAmount?.toString() ?? null,
          offerId: f.offerId?.toString() ?? null,
          requestId: f.requestId?.toString() ?? null,
          loanId: f.loanId?.toString() ?? null,
          args: jsonArgs(dec.args),
        })
        .onConflictDoNothing()
        .returning({ txHash: indexedEvents.txHash });
      // Touch ids even for duplicates: reconciliation is cheap and keeps entities correct after partial failures.
      if (f.offerId) touched.offers.add(f.offerId.toString());
      if (f.requestId) touched.requests.add(f.requestId.toString());
      if (f.loanId) touched.loans.add(f.loanId.toString());
      if (res.length === 0) continue;
      inserted++;

      if (dec.eventName === "LoanRepayment") {
        const a = dec.args;
        await tx
          .insert(repayments)
          .values({
            chainId,
            txHash: log.transactionHash,
            logIndex: Number(log.logIndex),
            blockNumber: log.blockNumber.toString(),
            timestamp: ts,
            loanId: String(a.loanId),
            payer: String(a.payer),
            interestPaid: String(a.interestPaid),
            principalPaid: String(a.principalPaid),
            outstandingPrincipal: String(a.outstandingPrincipal),
          })
          .onConflictDoNothing();
      }
      for (const who of [f.account, f.counterparty]) {
        if (!who) continue;
        await tx
          .insert(users)
          .values({ chainId, address: who, firstSeenBlock: log.blockNumber.toString(), firstSeenAt: ts, lastActiveAt: ts })
          .onConflictDoUpdate({
            target: [users.chainId, users.address],
            set: {
              firstSeenBlock: sql`LEAST(${users.firstSeenBlock}, excluded.first_seen_block)`,
              firstSeenAt: sql`LEAST(${users.firstSeenAt}, excluded.first_seen_at)`,
              lastActiveAt: sql`GREATEST(${users.lastActiveAt}, excluded.last_active_at)`,
            },
          });
      }
    }
  });
  return { inserted, touched };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation: re-read touched entities from chain, chain wins
// ---------------------------------------------------------------------------------------------

export async function reconcile(db: Db, chainId: number, touched: Touched): Promise<void> {
  const ids = (s: Set<string>) => [...s].map((x) => BigInt(x));
  const BATCH = 200;
  const run = async <T extends { id: bigint }>(
    all: bigint[],
    read: (ids: bigint[]) => Promise<(T | null)[]>,
    save: (rows: T[]) => Promise<void>,
  ) => {
    for (let i = 0; i < all.length; i += BATCH) {
      const slice = all.slice(i, i + BATCH);
      const res = await read(slice);
      // A failed individual read leaves the DB row as is; a throw (RPC down) aborts the batch so the cursor isn't advanced.
      // A non-existent id comes back as an empty struct (id 0, status None): keep the requested id so the row is deleted.
      const rows: T[] = [];
      res.forEach((x, j) => {
        if (x) rows.push({ ...x, id: slice[j] });
      });
      await save(rows);
    }
  };
  await run(ids(touched.offers), readOffers, (rows) => upsertOffers(db, rows.map((o) => offerRow(chainId, o))));
  await run(ids(touched.requests), readRequests, (rows) => upsertRequests(db, rows.map((r) => requestRow(chainId, r))));
  await run(ids(touched.loans), readLoans, (rows) => upsertLoans(db, rows.map((l) => loanRow(chainId, l))));
  await fixups(db, chainId);
}

/** Fill creation tx hashes and missing account/asset/counterparty on loan/offer events from the entity tables. */
async function fixups(db: Db, chainId: number) {
  await db.execute(sql`
    UPDATE lending_offers o SET tx_hash = e.tx_hash FROM indexed_events e
    WHERE o.tx_hash IS NULL AND o.chain_id = ${chainId} AND e.chain_id = o.chain_id AND e.event_name = 'OfferCreated' AND e.offer_id = o.id`);
  await db.execute(sql`
    UPDATE borrowing_requests r SET tx_hash = e.tx_hash FROM indexed_events e
    WHERE r.tx_hash IS NULL AND r.chain_id = ${chainId} AND e.chain_id = r.chain_id AND e.event_name = 'RequestCreated' AND e.request_id = r.id`);
  await db.execute(sql`
    UPDATE loans l SET tx_hash = e.tx_hash FROM indexed_events e
    WHERE l.tx_hash IS NULL AND l.chain_id = ${chainId} AND e.chain_id = l.chain_id AND e.event_name = 'LoanActivated' AND e.loan_id = l.id`);
  await db.execute(sql`
    UPDATE indexed_events e SET
      account = COALESCE(e.account, l.borrower),
      asset = COALESCE(e.asset, l.asset),
      counterparty = COALESCE(e.counterparty, CASE WHEN COALESCE(e.account, l.borrower) = l.lender THEN l.borrower ELSE l.lender END)
    FROM loans l
    WHERE e.chain_id = ${chainId} AND l.chain_id = e.chain_id AND e.loan_id = l.id
      AND (e.account IS NULL OR e.asset IS NULL OR e.counterparty IS NULL)`);
  await db.execute(sql`
    UPDATE indexed_events e SET asset = o.asset FROM lending_offers o
    WHERE e.chain_id = ${chainId} AND o.chain_id = e.chain_id AND e.offer_id = o.id AND e.asset IS NULL`);
  await db.execute(sql`
    UPDATE indexed_events e SET asset = r.asset FROM borrowing_requests r
    WHERE e.chain_id = ${chainId} AND r.chain_id = e.chain_id AND e.request_id = r.id AND e.asset IS NULL`);
}

/** Daily per-asset rollup, recomputed from the event index (cheap at testnet scale, always consistent after reorgs). */
export async function recomputeAnalytics(db: Db, chainId: number) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM marketplace_analytics WHERE chain_id = ${chainId}`);
    await tx.execute(sql`
      INSERT INTO marketplace_analytics (chain_id, day, asset, loans_opened, volume, repayments, liquidations)
      SELECT chain_id,
             to_char(to_timestamp(timestamp) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
             COALESCE(asset, '') AS asset,
             count(*) FILTER (WHERE kind = 'loan_activated')::int,
             COALESCE(sum(amount) FILTER (WHERE kind = 'loan_activated'), 0),
             count(*) FILTER (WHERE kind = 'repayment')::int,
             count(*) FILTER (WHERE kind = 'liquidated')::int
      FROM indexed_events
      WHERE chain_id = ${chainId} AND kind IN ('loan_activated', 'repayment', 'liquidated')
      GROUP BY 1, 2, 3`);
  });
}

// ---------------------------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------------------------

export type SyncStateRow = typeof syncState.$inferSelect;

export async function getSyncState(db: Db, chainId: number): Promise<SyncStateRow | null> {
  const rows = await db.select().from(syncState).where(eq(syncState.chainId, chainId));
  return rows[0] ?? null;
}

async function saveCursor(db: Db, chainId: number, block: bigint, hash: string, prev: { block: bigint | null; hash: string | null }) {
  const row = {
    chainId,
    lastBlock: block.toString(),
    lastBlockHash: hash,
    prevBlock: prev.block?.toString() ?? null,
    prevBlockHash: prev.hash,
  };
  await db
    .insert(syncState)
    .values(row)
    .onConflictDoUpdate({
      target: syncState.chainId,
      set: {
        lastBlock: row.lastBlock,
        lastBlockHash: row.lastBlockHash,
        prevBlock: row.prevBlock,
        prevBlockHash: row.prevBlockHash,
      },
      // never move the cursor backwards here (concurrent instances); rollback() does that explicitly
      setWhere: sql`${syncState.lastBlock} <= ${row.lastBlock}`,
    });
}

async function recordStatus(db: Db, chainId: number, patch: Partial<SyncStateRow>) {
  const existing = await getSyncState(db, chainId);
  if (!existing) {
    const d = deployment();
    const start = d ? d.startBlock - 1n : 0n;
    await db
      .insert(syncState)
      .values({ chainId, lastBlock: (start < 0n ? 0n : start).toString(), ...patch })
      .onConflictDoNothing();
    if (Object.keys(patch).length) await db.update(syncState).set(patch).where(eq(syncState.chainId, chainId));
    return;
  }
  await db.update(syncState).set(patch).where(eq(syncState.chainId, chainId));
}

/** Delete everything indexed above `toBlock`, move the cursor back and reconcile the affected entities. */
export async function rollback(db: Db, chainId: number, toBlock: bigint): Promise<Touched> {
  const touched = newTouched();
  const affected = await db
    .select({ offerId: indexedEvents.offerId, requestId: indexedEvents.requestId, loanId: indexedEvents.loanId })
    .from(indexedEvents)
    .where(and(eq(indexedEvents.chainId, chainId), gt(indexedEvents.blockNumber, toBlock.toString())));
  for (const a of affected) {
    if (a.offerId) touched.offers.add(a.offerId);
    if (a.requestId) touched.requests.add(a.requestId);
    if (a.loanId) touched.loans.add(a.loanId);
  }
  await db.transaction(async (tx) => {
    await tx.delete(indexedEvents).where(and(eq(indexedEvents.chainId, chainId), gt(indexedEvents.blockNumber, toBlock.toString())));
    await tx.delete(repayments).where(and(eq(repayments.chainId, chainId), gt(repayments.blockNumber, toBlock.toString())));
    await tx
      .update(syncState)
      .set({ lastBlock: toBlock.toString(), lastBlockHash: null, prevBlock: null, prevBlockHash: null })
      .where(eq(syncState.chainId, chainId));
  });
  for (const n of [...blockCache.keys()]) if (n > toBlock) blockCache.delete(n);
  return touched;
}

// ---------------------------------------------------------------------------------------------
// Main sync loop
// ---------------------------------------------------------------------------------------------

export interface SyncOptions {
  /** stop starting new chunks after this many ms (default 7s) */
  budgetMs?: number;
  db?: Db;
}

let lastSyncError: string | null = null;
export function lastIndexerError(): string | null {
  return lastSyncError;
}

export async function syncIndexer(opts: SyncOptions = {}): Promise<SyncResult> {
  const d = deployment();
  if (!d) return { fromBlock: null, toBlock: null, events: 0, headBlock: null, reorg: false, done: true, skipped: "not_deployed" };
  const db = opts.db ?? (await getDb());
  const chainId = getChainId();
  const budget = opts.budgetMs ?? 7_000;
  const started = Date.now();
  const client = getClient();

  try {
    const head = await withRetry(() => client.getBlockNumber());
    const target = head - CONFIRMATIONS;
    let state = await getSyncState(db, chainId);
    if (!state) {
      await recordStatus(db, chainId, {});
      state = await getSyncState(db, chainId);
    }
    let last = BigInt(state!.lastBlock);
    let reorg = false;

    // Reorg detection: the stored hash of the last indexed block must still be canonical.
    if (state!.lastBlockHash && last > 0n) {
      blockCache.delete(last);
      const cur = await blockInfo(last);
      if (cur.hash.toLowerCase() !== state!.lastBlockHash.toLowerCase()) {
        reorg = true;
        const floor = d.startBlock > 0n ? d.startBlock - 1n : 0n;
        const back = last - REORG_ROLLBACK > floor ? last - REORG_ROLLBACK : floor;
        const touched = await rollback(db, chainId, back);
        await reconcile(db, chainId, touched);
        await recomputeAnalytics(db, chainId);
        last = back;
      }
    }

    const fromStart = last + 1n;
    let from = fromStart;
    let events = 0;
    let prev = { block: state!.lastBlockHash ? last : null, hash: reorg ? null : state!.lastBlockHash };
    const addresses = Object.values(d.contracts) as Address[];

    while (from <= target && Date.now() - started < budget) {
      const to = from + CHUNK_BLOCKS - 1n < target ? from + CHUNK_BLOCKS - 1n : target;
      const logs = (await withRetry(() => client.getLogs({ address: addresses, fromBlock: from, toBlock: to }))) as Log[];
      const live = logs.filter((l) => !l.removed);
      const tsMap = await timestampsFor(live.map((l) => l.blockNumber!).filter((b) => b != null));
      const toInfo = await blockInfo(to);
      const { inserted, touched } = await processLogs(db, chainId, live, tsMap);
      await reconcile(db, chainId, touched); // throws if RPC fails => cursor not advanced, batch redone next time
      if (inserted > 0) await recomputeAnalytics(db, chainId);
      await saveCursor(db, chainId, to, toInfo.hash, prev);
      prev = { block: to, hash: toInfo.hash };
      events += inserted;
      from = to + 1n;
    }

    await snapshotPrice(db, chainId).catch(() => {});
    await recordStatus(db, chainId, { headBlock: head.toString(), lastSyncAt: Math.floor(Date.now() / 1000), lastError: null });
    lastSyncError = null;
    const reached = from - 1n;
    return {
      fromBlock: fromStart <= reached ? fromStart.toString() : null,
      toBlock: fromStart <= reached ? reached.toString() : null,
      events,
      headBlock: head.toString(),
      reorg,
      done: reached >= target,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0].slice(0, 500) : String(e);
    lastSyncError = msg;
    await recordStatus(db, chainId, { lastError: msg, lastErrorAt: Math.floor(Date.now() / 1000) }).catch(() => {});
    throw e;
  }
}

/** One price snapshot per minute at most. */
async function snapshotPrice(db: Db, chainId: number) {
  const minute = Math.floor(Date.now() / 60_000) * 60;
  const p = await readPrice();
  await db
    .insert(priceSnapshots)
    .values({ chainId, observedAt: minute, ok: p.ok, price: p.price?.toString() ?? null, updatedAt: p.updatedAt })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------------------------
// Throttled catch-up sync for read routes
// ---------------------------------------------------------------------------------------------

let lastSyncStart = 0;
let inflight: Promise<SyncResult | null> | null = null;

/**
 * Called from read routes. Starts at most one sync per SYNC_THROTTLE_MS per instance and waits for it at most
 * `maxWaitMs` (default ~8s); never throws. If a sync is already running the caller doesn't wait.
 * On failure, routes serve the last indexed data and /api/health reports the lag and the error.
 */
export async function maybeSync(maxWaitMs = 8_000): Promise<void> {
  if (!deployment()) return;
  if (inflight) return;
  if (Date.now() - lastSyncStart < SYNC_THROTTLE_MS) return;
  lastSyncStart = Date.now();
  inflight = syncIndexer({ budgetMs: Math.max(1_000, maxWaitMs - 2_000) })
    .catch((e) => {
      console.error("[indexer] sync failed:", e instanceof Error ? e.message : e);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  await withTimeout(inflight, maxWaitMs, "sync").catch(() => {});
}
