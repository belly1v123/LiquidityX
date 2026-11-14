import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@/lib/server/db";
import { getSyncState, maybeSync, processLogs, syncIndexer, CHUNK_BLOCKS } from "@/lib/server/indexer";
import { readMany, withRetry } from "@/lib/server/rpc";
import { ALICE, BOB, E18, START_BLOCK, makeLoan, makeOffer, makeRequest, ADDR } from "./helpers/fake-chain";
import { setupEnv, type TestEnv } from "./helpers/setup";
import { MUSD } from "@/lib/chain";

let env: TestEnv;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});

const count = async (table: Parameters<TestEnv["db"]["select"]>[0] extends never ? never : any) => // eslint-disable-line @typescript-eslint/no-explicit-any
  (await env.db.select({ n: sql<number>`count(*)::int` }).from(table))[0].n;

function seedOfferCreated(block: bigint) {
  const o = makeOffer(1n);
  env.chain.offers.set(1n, o);
  return env.chain.emit("marketplace", "OfferCreated", {
    offerId: 1n, lender: ALICE, asset: MUSD.address, amount: o.amount, aprBps: o.aprBps, maxDuration: o.maxDuration,
    minCrBps: o.minCrBps, expiry: o.expiry,
  }, block);
}

describe("event processing", () => {
  it("same log twice => one row (idempotent)", async () => {
    const log = seedOfferCreated(150n);
    const ts = new Map([[150n, 1]]);
    const a = await processLogs(env.db, 31611, [log], ts);
    const b = await processLogs(env.db, 31611, [log, log], ts);
    expect(a.inserted).toBe(1);
    expect(b.inserted).toBe(0);
    expect(await count(schema.indexedEvents)).toBe(1);
  });

  it("sync indexes events, reconciles entities from chain and fills activity fields", async () => {
    seedOfferCreated(150n);
    env.chain.requests.set(1n, makeRequest(1n));
    env.chain.emit("marketplace", "RequestCreated", {
      requestId: 1n, borrower: BOB, asset: MUSD.address, amount: 1000n * E18, maxAprBps: 800, duration: 7 * 86400,
      collateral: E18 / 50n, expiry: 4_000_000_000n,
    }, 160n);
    env.chain.loans.set(1n, makeLoan(1n));
    env.chain.offers.set(1n, makeOffer(1n, { remaining: 600n * E18, fills: 1 }));
    env.chain.requests.set(1n, makeRequest(1n, { filled: 400n * E18, fills: 1 }));
    env.chain.emit("loans", "LoanActivated", {
      loanId: 1n, lender: ALICE, borrower: BOB, asset: MUSD.address, principal: 400n * E18, aprBps: 500,
      start: 1n, maturity: 2n, collateral: E18 / 125n, offerId: 1n, requestId: 1n,
    }, 170n);
    env.chain.emit("loans", "LoanRepayment", { loanId: 1n, payer: BOB, interestPaid: 1n, principalPaid: 2n, outstandingPrincipal: 3n }, 180n);
    env.chain.emit("loans", "LoanRepaid", { loanId: 1n, totalInterestPaid: 1n }, 181n);

    const r = await syncIndexer();
    expect(r.events).toBe(5);
    expect(r.toBlock).toBe((env.chain.head - 2n).toString()); // CONFIRMATIONS = 2
    expect(r.fromBlock).toBe(START_BLOCK.toString());

    const offers = await env.db.select().from(schema.lendingOffers);
    expect(offers).toHaveLength(1);
    expect(offers[0].remaining).toBe((600n * E18).toString());
    expect(offers[0].txHash).toMatch(/^0x/);
    const [req] = await env.db.select().from(schema.borrowingRequests);
    expect(req.filled).toBe((400n * E18).toString());
    expect(await count(schema.loans)).toBe(1);
    expect(await count(schema.repayments)).toBe(1);
    const repaid = await env.db.select().from(schema.indexedEvents).where(eq(schema.indexedEvents.eventName, "LoanRepaid"));
    expect(repaid[0].account).toBe(BOB); // filled from the loan
    expect(repaid[0].counterparty).toBe(ALICE);
    expect(repaid[0].asset).toBe(MUSD.address);
    const analytics = await env.db.select().from(schema.marketplaceAnalytics);
    expect(analytics.find((a) => a.asset === MUSD.address)?.loansOpened).toBe(1);
    expect(await count(schema.users)).toBe(2);

    // second run: nothing new
    const r2 = await syncIndexer();
    expect(r2.events).toBe(0);
    expect(r2.fromBlock).toBeNull();
  });

  it("pages getLogs in <= 9,000-block chunks", async () => {
    env.chain.head = START_BLOCK + 20_000n;
    const ranges: [bigint, bigint][] = [];
    const client = env.chain.client();
    const orig = client.getLogs.bind(client);
    (client as { getLogs: unknown }).getLogs = async (a: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([a.fromBlock, a.toBlock]);
      return orig(a as never);
    };
    const { setTestContext } = await import("@/lib/server/context");
    setTestContext({ client });
    await syncIndexer({ budgetMs: 60_000 });
    expect(ranges.length).toBe(3);
    for (const [f, t] of ranges) expect(t - f + 1n).toBeLessThanOrEqual(CHUNK_BLOCKS);
    expect(ranges[0][0]).toBe(START_BLOCK);
    expect(ranges.at(-1)![1]).toBe(env.chain.head - 2n);
  });
});

describe("reconciliation", () => {
  it("chain wins: a stale DB status is overwritten", async () => {
    seedOfferCreated(150n);
    await syncIndexer();
    let [o] = await env.db.select().from(schema.lendingOffers);
    expect(o.status).toBe("open");

    // cancelled on chain; the event arrives later
    env.chain.offers.set(1n, makeOffer(1n, { status: 3, remaining: 0n }));
    env.chain.head += 10n;
    env.chain.emit("marketplace", "OfferCancelled", { offerId: 1n, lender: ALICE, released: 1000n * E18 }, env.chain.head - 5n);
    await syncIndexer();
    [o] = await env.db.select().from(schema.lendingOffers);
    expect(o.status).toBe("cancelled");
    expect(o.remaining).toBe("0");
  });

  it("list reads refresh stale rows from chain", async () => {
    seedOfferCreated(150n);
    await syncIndexer();
    env.chain.offers.set(1n, makeOffer(1n, { status: 2, remaining: 0n, fills: 1 })); // filled on chain, not indexed yet
    const { listOffers } = await import("@/lib/server/queries");
    const page = await listOffers({ sort: "created", page: 1, pageSize: 20 });
    expect(page.items[0].status).toBe("filled");
    const [o] = await env.db.select().from(schema.lendingOffers);
    expect(o.status).toBe("filled"); // persisted
  });
});

describe("reorgs", () => {
  it("detects a changed block hash, rolls back 50 blocks and re-indexes", async () => {
    env.chain.head = 400n;
    seedOfferCreated(390n);
    await syncIndexer();
    expect(await count(schema.indexedEvents)).toBe(1);
    const before = await getSyncState(env.db, 31611);
    expect(before?.lastBlock).toBe("398");

    // reorg: all hashes change and the offer's log moves to another tx in a later block
    env.chain.blockHashSalt = "b";
    env.chain.logs = [];
    env.chain.emit("marketplace", "OfferCreated", {
      offerId: 1n, lender: ALICE, asset: MUSD.address, amount: 1000n * E18, aprBps: 500, maxDuration: 30 * 86400,
      minCrBps: 15000, expiry: 4_000_000_000n,
    }, 395n);
    const r = await syncIndexer();
    expect(r.reorg).toBe(true);
    expect(r.fromBlock).toBe("349"); // 398 - 50 + 1
    const evs = await env.db.select().from(schema.indexedEvents);
    expect(evs).toHaveLength(1);
    expect(evs[0].blockNumber).toBe("395");
    const after = await getSyncState(env.db, 31611);
    expect(after?.lastBlockHash).toBe(env.chain.blockHash(398n));
  });

  it("an entity that disappeared in the reorg is removed", async () => {
    env.chain.head = 400n;
    seedOfferCreated(390n);
    await syncIndexer();
    env.chain.blockHashSalt = "c";
    env.chain.logs = [];
    env.chain.offers.clear();
    await syncIndexer();
    expect(await count(schema.lendingOffers)).toBe(0);
    expect(await count(schema.indexedEvents)).toBe(0);
  });
});

describe("RPC failures", () => {
  it("retries transient errors (3 tries) then succeeds", async () => {
    env.chain.failNext = 2;
    const n = await withRetry(() => env.chain.client().getBlockNumber());
    expect(n).toBe(env.chain.head);
    expect(env.chain.calls.getBlockNumber).toBe(3);
  });

  it("gives up after 3 tries", async () => {
    env.chain.failNext = 3;
    await expect(withRetry(() => env.chain.client().getBlockNumber())).rejects.toThrow(/transient/);
    expect(env.chain.calls.getBlockNumber).toBe(3);
  });

  it("sync failure keeps the cursor, records the error; maybeSync never throws", async () => {
    seedOfferCreated(150n);
    await syncIndexer();
    const s1 = await getSyncState(env.db, 31611);
    env.chain.down = true;
    env.chain.head += 100n;
    await expect(syncIndexer()).rejects.toThrow(/rpc down/);
    const s2 = await getSyncState(env.db, 31611);
    expect(s2?.lastBlock).toBe(s1?.lastBlock);
    expect(s2?.lastError).toMatch(/rpc down/);
    await expect(maybeSync(2_000)).resolves.toBeUndefined();
    // data indexed earlier is still served
    const { listOffers } = await import("@/lib/server/queries");
    const page = await listOffers({ sort: "created", page: 1, pageSize: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0].status).toBe("open");
  });

  it("reconcile failure does not advance the cursor; next sync redoes the batch", async () => {
    seedOfferCreated(150n);
    const client = env.chain.client();
    let fail = true;
    const orig = client.multicall.bind(client);
    (client as { multicall: unknown }).multicall = async (a: unknown) => {
      if (fail) throw new Error("multicall boom");
      return orig(a as never);
    };
    const { setTestContext } = await import("@/lib/server/context");
    setTestContext({ client });
    await expect(syncIndexer()).rejects.toThrow(/boom/);
    expect(await count(schema.lendingOffers)).toBe(0);
    expect((await getSyncState(env.db, 31611))?.lastBlock).toBe((START_BLOCK - 1n).toString());
    fail = false;
    await syncIndexer();
    expect(await count(schema.lendingOffers)).toBe(1);
    expect(await count(schema.indexedEvents)).toBe(1);
  });

  it("readMany without multicall3 falls back to parallel eth_call with per-call failures", async () => {
    await env.close();
    env = await setupEnv({ multicall: false });
    env.chain.offers.set(1n, makeOffer(1n));
    const res = await readMany([
      { address: ADDR.marketplace, abi: [], functionName: "getOffer", args: [1n] },
      { address: ADDR.marketplace, abi: [], functionName: "nope", args: [] },
    ]);
    expect(res[0].ok).toBe(true);
    expect(res[1].ok).toBe(false);
    expect(env.chain.calls.multicall).toBeUndefined();
  });
});

describe("not deployed", () => {
  it("sync is a no-op and maybeSync returns", async () => {
    await env.close();
    env = await setupEnv({ deployed: false });
    const r = await syncIndexer();
    expect(r.skipped).toBe("not_deployed");
    await expect(maybeSync()).resolves.toBeUndefined();
  });
});
