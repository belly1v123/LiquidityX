import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// connection() needs a Next.js request scope; route handlers are called directly here.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
import { ALICE, BOB, CAROL, E18, makeLoan, makeOffer, makeRequest, PRICE } from "./helpers/fake-chain";
import { setupEnv, type TestEnv } from "./helpers/setup";
import { upsertLoans, upsertOffers, upsertRequests, offerRow, requestRow, loanRow } from "@/lib/server/store";
import { MUSD } from "@/lib/chain";
import type {
  ConfigResponse, LoanDTO, MatchSuggestion, OfferDTO, Paged, PortfolioResponse, PriceResponse, RequestDTO, StatsResponse, ActivityDTO,
} from "@/lib/api-types";

import * as healthRoute from "@/app/api/health/route";
import * as configRoute from "@/app/api/config/route";
import * as priceRoute from "@/app/api/price/route";
import * as offersRoute from "@/app/api/offers/route";
import * as requestsRoute from "@/app/api/requests/route";
import * as loansRoute from "@/app/api/loans/route";
import * as loanRoute from "@/app/api/loans/[id]/route";
import * as matchesRoute from "@/app/api/matches/route";
import * as forOfferRoute from "@/app/api/matches/for-offer/route";
import * as activityRoute from "@/app/api/activity/route";
import * as statsRoute from "@/app/api/stats/route";
import * as portfolioRoute from "@/app/api/portfolio/[address]/route";
import * as syncRoute from "@/app/api/indexer/sync/route";

let env: TestEnv;
beforeEach(async () => {
  env = await setupEnv();
  env.chain.head = 50n; // below startBlock: maybeSync has nothing to index, so tests control DB contents
});
afterEach(async () => {
  await env.close();
});

const BASE = "http://localhost";
const get = async <T>(mod: { GET: (r: Request, c?: never) => Promise<Response> }, path: string, params?: Record<string, string>) => {
  const res = await mod.GET(new Request(BASE + path), params ? ({ params: Promise.resolve(params) } as never) : (undefined as never));
  return { status: res.status, body: (await res.json()) as T };
};

const NOW = Math.floor(Date.now() / 1000);
const FUTURE = BigInt(NOW + 86400);

async function seedOffers(n: number) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const o = makeOffer(BigInt(i), { aprBps: 100 * i, remaining: BigInt(i) * 100n * E18, expiry: FUTURE, createdAt: BigInt(NOW - 1000 + i) });
    env.chain.offers.set(o.id, o);
    rows.push(offerRow(31611, o));
  }
  await upsertOffers(env.db, rows);
}

describe("validation", () => {
  it.each([
    ["/api/offers?pageSize=101", offersRoute],
    ["/api/offers?page=0", offersRoute],
    ["/api/offers?sort=bogus", offersRoute],
    ["/api/offers?lender=0x123", offersRoute],
    ["/api/offers?minAmount=-1", offersRoute],
    ["/api/requests?minCr=abc", requestsRoute],
    ["/api/requests?status=expiredd", requestsRoute],
    ["/api/loans?role=admin", loansRoute],
    ["/api/activity?kind=nope", activityRoute],
    ["/api/activity?loanId=0", activityRoute],
    ["/api/matches", matchesRoute],
    ["/api/matches?requestId=1.5", matchesRoute],
    ["/api/matches/for-offer?offerId=x", forOfferRoute],
  ])("%s => 400 bad_request", async (path, mod) => {
    const r = await get<{ error: { code: string; message: string } }>(mod as never, path);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("bad_request");
    expect(r.body.error.message.length).toBeGreaterThan(0);
  });

  it("bad path params => 400", async () => {
    expect((await get(loanRoute as never, "/api/loans/abc", { id: "abc" })).status).toBe(400);
    expect((await get(portfolioRoute as never, "/api/portfolio/0xnope", { address: "0xnope" })).status).toBe(400);
  });
});

describe("offers / requests", () => {
  it("paginates with total, sorts and filters", async () => {
    await seedOffers(25);
    const p1 = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?sort=apr&order=asc&pageSize=10");
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(25);
    expect(p1.body.items).toHaveLength(10);
    expect(p1.body.items.map((o) => o.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const p3 = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?sort=apr&order=asc&pageSize=10&page=3");
    expect(p3.body.items.map((o) => o.id)).toEqual(["21", "22", "23", "24", "25"]);
    const p4 = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?pageSize=10&page=4");
    expect(p4.body.items).toEqual([]);
    expect(p4.body.total).toBe(25);
    const f = await get<Paged<OfferDTO>>(offersRoute as never, `/api/offers?minApr=500&maxApr=700&minAmount=${600n * E18}`);
    expect(f.body.items.map((o) => o.id).sort()).toEqual(["6", "7"]);
    const desc = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?sort=amount&order=desc&pageSize=1");
    expect(desc.body.items[0].id).toBe("25");
    expect(desc.body.items[0].amount).toMatch(/^\d+$/);
  });

  it("expired status is derived from expiry", async () => {
    const o = makeOffer(1n, { expiry: BigInt(NOW - 10) });
    env.chain.offers.set(1n, o);
    await upsertOffers(env.db, [offerRow(31611, o)]);
    const open = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?status=open");
    expect(open.body.total).toBe(0);
    const exp = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers?status=expired");
    expect(exp.body.items[0].status).toBe("expired");
  });

  it("requests: partially_filled status, crBps at live price, minCr and sort=cr", async () => {
    const a = makeRequest(1n, { expiry: FUTURE }); // 200%
    const b = makeRequest(2n, { expiry: FUTURE, filled: 400n * E18, collateralRemaining: (E18 / 50n) * 6n / 10n }); // 200%
    const c = makeRequest(3n, { expiry: FUTURE, collateral: E18 / 40n, collateralRemaining: E18 / 40n }); // 250%
    for (const r of [a, b, c]) env.chain.requests.set(r.id, r);
    await upsertRequests(env.db, [a, b, c].map((r) => requestRow(31611, r)));
    const all = await get<Paged<RequestDTO>>(requestsRoute as never, "/api/requests?sort=cr&order=desc");
    expect(all.body.items.map((r) => r.id)).toEqual(["3", "2", "1"]); // ties broken by id in the same direction
    expect(all.body.items[0].crBps).toBe("25000");
    expect(all.body.items.find((r) => r.id === "2")!.status).toBe("partially_filled");
    const min = await get<Paged<RequestDTO>>(requestsRoute as never, "/api/requests?minCr=22000");
    expect(min.body.items.map((r) => r.id)).toEqual(["3"]);
    const partial = await get<Paged<RequestDTO>>(requestsRoute as never, "/api/requests?status=partially_filled");
    expect(partial.body.items.map((r) => r.id)).toEqual(["2"]);
    // price stale => crBps null
    env.chain.price = { ...env.chain.price, ok: false };
    const { resetRpcCaches } = await import("@/lib/server/rpc");
    resetRpcCaches();
    const stale = await get<Paged<RequestDTO>>(requestsRoute as never, "/api/requests");
    expect(stale.body.items.every((r) => r.crBps === null)).toBe(true);
  });
});

describe("matches", () => {
  it("A/B/C example through the API with the live price", async () => {
    const offers = [
      makeOffer(1n, { lender: ALICE, remaining: 400n * E18, aprBps: 500, expiry: FUTURE }),
      makeOffer(2n, { lender: CAROL, remaining: 300n * E18, aprBps: 600, expiry: FUTURE }),
      makeOffer(3n, { lender: ALICE, remaining: 500n * E18, aprBps: 900, expiry: FUTURE }),
    ];
    for (const o of offers) env.chain.offers.set(o.id, o);
    await upsertOffers(env.db, offers.map((o) => offerRow(31611, o)));
    env.chain.requests.set(1n, makeRequest(1n, { expiry: FUTURE }));
    const r = await get<MatchSuggestion>(matchesRoute as never, "/api/matches?requestId=1");
    expect(r.status).toBe(200);
    expect(r.body.fills.map((f) => f.offerId)).toEqual(["1", "2"]);
    expect(r.body.fillable).toBe((700n * E18).toString());
    expect(r.body.state).toBe("partially_matchable");
    expect(r.body.excluded).toEqual([{ offerId: "3", reason: "apr" }]);

    const fo = await get<{ offerId: string; requests: { requestId: string }[] }>(forOfferRoute as never, "/api/matches/for-offer?offerId=1");
    expect(fo.body.requests.map((x) => x.requestId)).toEqual(["1"]);
  });

  it("unknown request => 404", async () => {
    const r = await get<{ error: { code: string } }>(matchesRoute as never, "/api/matches?requestId=99");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });
});

describe("loans, activity, stats, portfolio, config, price", () => {
  it("loan detail reads live values and computes owed", async () => {
    const l = makeLoan(1n, { start: BigInt(NOW - 86400), lastAccrual: BigInt(NOW - 86400), maturity: BigInt(NOW - 10) });
    env.chain.loans.set(1n, l);
    const r = await get<{ loan: LoanDTO; activity: ActivityDTO[] }>(loanRoute as never, "/api/loans/1", { id: "1" });
    expect(r.status).toBe(200);
    expect(r.body.loan.status).toBe("overdue");
    expect(BigInt(r.body.loan.owed.interest)).toBeGreaterThan(0n);
    expect(r.body.loan.crBps).toBe("20000"); // from LiquidationEngine.health
    expect(r.body.activity).toEqual([]);
    const missing = await get(loanRoute as never, "/api/loans/9", { id: "9" });
    expect(missing.status).toBe(404);
  });

  it("loans list filters by address and role", async () => {
    const l1 = makeLoan(1n, { lender: ALICE, borrower: BOB, maturity: FUTURE });
    const l2 = makeLoan(2n, { lender: CAROL, borrower: ALICE, maturity: FUTURE });
    for (const l of [l1, l2]) env.chain.loans.set(l.id, l);
    await upsertLoans(env.db, [l1, l2].map((l) => loanRow(31611, l)));
    const any = await get<Paged<LoanDTO>>(loansRoute as never, `/api/loans?address=${ALICE.toLowerCase()}`);
    expect(any.body.total).toBe(2);
    const lender = await get<Paged<LoanDTO>>(loansRoute as never, `/api/loans?address=${ALICE}&role=lender`);
    expect(lender.body.items.map((l) => l.id)).toEqual(["1"]);
    const active = await get<Paged<LoanDTO>>(loansRoute as never, `/api/loans?status=active`);
    expect(active.body.total).toBe(2);
  });

  it("stats: chain totals + index counts", async () => {
    await seedOffers(2);
    const r = await get<StatsResponse>(statsRoute as never, "/api/stats");
    expect(r.body.openOffers).toBe(2);
    expect(r.body.perAsset[0]).toMatchObject({ asset: MUSD.address, totalAvailable: (10n * E18).toString() });
    expect(r.body.btcLocked).toBe((5n * E18).toString());
    expect(r.body.source).toBe("chain");
    // weighted: (100*100 + 200*200) / 300 = 166
    expect(r.body.avgOfferAprBps).toBe(166);
  });

  it("portfolio reads balances live", async () => {
    const r = await get<PortfolioResponse>(portfolioRoute as never, `/api/portfolio/${BOB}`, { address: BOB });
    expect(r.status).toBe(200);
    expect(r.body.freeCollateral).toBe((7n * E18).toString());
    expect(r.body.lender[0].available).toBe((5n * E18).toString());
  });

  it("config and price", async () => {
    const c = await get<ConfigResponse>(configRoute as never, "/api/config");
    expect(c.body.deployed).toBe(true);
    expect(c.body.risk?.minInitialCrBps).toBe(15000);
    expect(c.body.assets[0]).toMatchObject({ symbol: "MUSD", enabled: true, officiallyListed: true });
    const p = await get<PriceResponse>(priceRoute as never, "/api/price");
    expect(p.body).toMatchObject({ ok: true, price: PRICE.toString(), maxStaleness: 3600 });
  });

  it("health reports lag", async () => {
    const h = await get<{ ok: boolean; rpcOk: boolean; lagBlocks: number; db: string; deployed: boolean }>(healthRoute as never, "/api/health");
    expect(h.body).toMatchObject({ rpcOk: true, deployed: true, db: "pglite" });
  });
});

describe("RPC down => graceful", () => {
  it("lists still served from the index; price ok=false; health rpcOk=false", async () => {
    await seedOffers(3);
    env.chain.down = true;
    const o = await get<Paged<OfferDTO>>(offersRoute as never, "/api/offers");
    expect(o.status).toBe(200);
    expect(o.body.total).toBe(3);
    const p = await get<PriceResponse>(priceRoute as never, "/api/price");
    expect(p.body.ok).toBe(false);
    const h = await get<{ ok: boolean; rpcOk: boolean }>(healthRoute as never, "/api/health");
    expect(h.body.rpcOk).toBe(false);
    const s = await get<StatsResponse>(statsRoute as never, "/api/stats");
    expect(s.status).toBe(200);
    expect(s.body.openOffers).toBe(3);
    const m = await get<{ error: { code: string } }>(matchesRoute as never, "/api/matches?requestId=1");
    expect(m.status).toBe(503);
  });
});

describe("not deployed", () => {
  it("every route responds sensibly, never 500", async () => {
    await env.close();
    env = await setupEnv({ deployed: false });
    const c = await get<ConfigResponse>(configRoute as never, "/api/config");
    expect(c.status).toBe(200);
    expect(c.body.deployed).toBe(false);
    expect(c.body.contracts.vault).toBeNull();
    expect(c.body.assets.length).toBeGreaterThan(0);
    for (const [mod, path] of [
      [offersRoute, "/api/offers"], [requestsRoute, "/api/requests"], [loansRoute, "/api/loans"], [activityRoute, "/api/activity"],
    ] as const) {
      const r = await get<Paged<unknown>>(mod as never, path);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    }
    expect((await get<PriceResponse>(priceRoute as never, "/api/price")).body.ok).toBe(false);
    expect((await get<StatsResponse>(statsRoute as never, "/api/stats")).body.totalLoans).toBe(0);
    expect((await get<{ deployed: boolean }>(healthRoute as never, "/api/health")).body.deployed).toBe(false);
    expect((await get(portfolioRoute as never, `/api/portfolio/${BOB}`, { address: BOB })).status).toBe(200);
    expect((await get(matchesRoute as never, "/api/matches?requestId=1")).status).toBe(404);
    expect((await get(loanRoute as never, "/api/loans/1", { id: "1" })).status).toBe(404);
  });
});

describe("POST /api/indexer/sync", () => {
  it("requires the bearer secret", async () => {
    process.env.INDEXER_SECRET = "s3cret";
    const no = await syncRoute.POST(new Request(BASE + "/api/indexer/sync", { method: "POST" }));
    expect(no.status).toBe(401);
    const bad = await syncRoute.POST(new Request(BASE + "/api/indexer/sync", { method: "POST", headers: { authorization: "Bearer nope" } }));
    expect(bad.status).toBe(401);
    env.chain.head = 300n;
    const ok = await syncRoute.POST(new Request(BASE + "/api/indexer/sync", { method: "POST", headers: { authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ fromBlock: "100", toBlock: "298", events: 0 });
    delete process.env.INDEXER_SECRET;
  });
});
