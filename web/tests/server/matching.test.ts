import { describe, expect, it } from "vitest";
import {
  suggestMatches,
  suggestRequestsForOffer,
  offerFromDTO,
  requestFromDTO,
  type MatchableOffer,
  type MatchableRequest,
  type MatchContext,
} from "@/lib/matching";
import { collateralRatioBps } from "@/lib/finance";

const E18 = 10n ** 18n;
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
const OTHER = "0xe1a26db653708A2AD8F824E92Db9852410e33A59";
const BOB = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;
const PRICE = 100_000n * E18;

function req(p: Partial<MatchableRequest> = {}): MatchableRequest {
  return {
    id: 1n, borrower: BOB, asset: MUSD, amount: 1000n * E18, filled: 0n, maxAprBps: 800, duration: 7 * 86400,
    collateral: E18 / 50n, collateralRemaining: E18 / 50n, // $2,000 of BTC => 200% CR on 1,000
    expiry: NOW + 86400, open: true, ...p,
  };
}
let lenderN = 0;
function offer(id: bigint, amount: bigint, aprBps: number, p: Partial<MatchableOffer> = {}): MatchableOffer {
  lenderN++;
  return {
    id, lender: `0x${(0xa0 + lenderN).toString(16).padStart(40, "0")}`, asset: MUSD, remaining: amount * E18, aprBps,
    maxDuration: 30 * 86400, minCrBps: 15_000, expiry: NOW + 86400, open: true, ...p,
  };
}
const ctx = (p: Partial<MatchContext> = {}): MatchContext => ({ minInitialCrBps: 15_000, minLoan: E18, price: PRICE, now: NOW, decimals: 18, ...p });

describe("suggestMatches", () => {
  it("docs/CONTRACTS.md example: A(400@5%) + B(300@6%) fill 700, C(9%) excluded for apr", () => {
    const A = offer(1n, 400n, 500), B = offer(2n, 300n, 600), C = offer(3n, 500n, 900);
    const m = suggestMatches(req(), [C, B, A], ctx());
    expect(m.fills.map((f) => [f.offerId, f.amount, f.aprBps])).toEqual([
      ["1", (400n * E18).toString(), 500],
      ["2", (300n * E18).toString(), 600],
    ]);
    expect(m.fillable).toBe((700n * E18).toString());
    expect(m.unfilled).toBe((300n * E18).toString());
    expect(m.state).toBe("partially_matchable");
    expect(m.excluded).toEqual([{ offerId: "3", reason: "apr" }]);
    // collateral shares are pro-rata (40% and 30%), like LoanMarketplace
    expect(m.fills[0].collateralShare).toBe(((E18 / 50n) * 400n / 1000n).toString());
    expect(m.fills[1].collateralShare).toBe(((E18 / 50n) * 300n / 1000n).toString());
    expect(m.fills[0].crBps).toBe("20000");
  });

  it("fully matchable; completing fill takes collateralRemaining", () => {
    const r = req({ amount: 1000n * E18, collateral: E18 / 50n + 7n, collateralRemaining: E18 / 50n + 7n });
    const m = suggestMatches(r, [offer(1n, 400n, 500), offer(2n, 900n, 600)], ctx());
    expect(m.state).toBe("fully_matchable");
    expect(m.fills.map((f) => f.amount)).toEqual([(400n * E18).toString(), (600n * E18).toString()]);
    const first = (r.collateral * 400n + 999n) / 1000n; // partial shares round up (audit 2026-11-12)
    expect(m.fills[1].collateralShare).toBe((r.collateralRemaining - first).toString());
    expect(m.unfilled).toBe("0");
  });

  it("respects already-filled state of the request", () => {
    const r = req({ filled: 600n * E18, collateralRemaining: (E18 / 50n) * 4n / 10n });
    const m = suggestMatches(r, [offer(1n, 1000n, 500)], ctx());
    expect(m.fills).toHaveLength(1);
    expect(m.fills[0].amount).toBe((400n * E18).toString());
    expect(m.fills[0].collateralShare).toBe(r.collateralRemaining.toString());
    expect(m.state).toBe("fully_matchable");
  });

  it("tie-breakers: APR asc, then expiry asc, then id asc", () => {
    const o5 = offer(5n, 100n, 500, { expiry: NOW + 100 });
    const o4 = offer(4n, 100n, 500, { expiry: NOW + 200 });
    const o3 = offer(3n, 100n, 500, { expiry: NOW + 100 });
    const o9 = offer(9n, 100n, 400, { expiry: NOW + 999 });
    const m = suggestMatches(req(), [o5, o4, o3, o9], ctx());
    expect(m.fills.map((f) => f.offerId)).toEqual(["9", "3", "5", "4"]);
    // deterministic regardless of input order
    const m2 = suggestMatches(req(), [o9, o3, o4, o5], ctx());
    expect(m2).toEqual(m);
  });

  it("excludes expired, not open, other asset, self, duration", () => {
    const m = suggestMatches(
      req(),
      [
        offer(1n, 100n, 500, { expiry: NOW - 1 }),
        offer(2n, 100n, 500, { open: false }),
        offer(3n, 100n, 500, { asset: OTHER }),
        offer(4n, 100n, 500, { lender: BOB.toLowerCase() }),
        offer(5n, 100n, 500, { maxDuration: 86400 }),
      ],
      ctx(),
    );
    expect(m.fills).toEqual([]);
    expect(m.state).toBe("unmatched");
    expect(m.excluded).toEqual([
      { offerId: "1", reason: "expired" },
      { offerId: "2", reason: "not_open" },
      { offerId: "3", reason: "asset" },
      { offerId: "4", reason: "self" },
      { offerId: "5", reason: "duration" },
    ]);
  });

  it("expiry boundary: now == expiry is still fillable", () => {
    const m = suggestMatches(req(), [offer(1n, 100n, 500, { expiry: NOW })], ctx());
    expect(m.fills).toHaveLength(1);
  });

  it("collateral: lender minCr above the request's CR excludes the offer", () => {
    // request CR is 200%; offer wants 250%
    const m = suggestMatches(req(), [offer(1n, 400n, 500, { minCrBps: 25_000 }), offer(2n, 400n, 600)], ctx());
    expect(m.fills.map((f) => f.offerId)).toEqual(["2"]);
    expect(m.excluded).toEqual([{ offerId: "1", reason: "collateral" }]);
  });

  it("collateral: price drop below config min initial CR excludes everything", () => {
    const m = suggestMatches(req(), [offer(1n, 400n, 500)], ctx({ price: 70_000n * E18 })); // CR 140% < 150%
    expect(m.state).toBe("unmatched");
    expect(m.excluded).toEqual([{ offerId: "1", reason: "collateral" }]);
  });

  it("no price => nothing matchable, reason collateral", () => {
    const m = suggestMatches(req(), [offer(1n, 400n, 500), offer(2n, 400n, 900)], ctx({ price: null }));
    expect(m.fills).toEqual([]);
    expect(m.state).toBe("unmatched");
    expect(m.excluded).toEqual([
      { offerId: "1", reason: "collateral" },
      { offerId: "2", reason: "apr" },
    ]);
  });

  it("min size: partial fill below minLoan is skipped, completing fill below minLoan is allowed", () => {
    const tiny = offer(1n, 0n, 100, { remaining: E18 / 2n }); // 0.5 MUSD, doesn't complete
    const big = offer(2n, 999n, 500);
    const m = suggestMatches(req(), [tiny, big], ctx());
    expect(m.excluded).toEqual([{ offerId: "1", reason: "size" }]);
    expect(m.fills.map((f) => f.offerId)).toEqual(["2"]);
    // completing remainder smaller than minLoan
    const r2 = req({ filled: 1000n * E18 - E18 / 2n, collateralRemaining: E18 / 10_000n });
    const m2 = suggestMatches(r2, [offer(3n, 0n, 500, { remaining: E18 / 2n })], ctx());
    expect(m2.state).toBe("fully_matchable");
    expect(m2.fills[0].amount).toBe((E18 / 2n).toString());
  });

  it("closed or expired request => no fills, no exclusions", () => {
    expect(suggestMatches(req({ open: false }), [offer(1n, 400n, 500)], ctx()).fills).toEqual([]);
    const m = suggestMatches(req({ expiry: NOW - 1 }), [offer(1n, 400n, 500)], ctx());
    expect(m.state).toBe("unmatched");
    expect(m.excluded).toEqual([]);
  });

  it("CR matches finance.collateralRatioBps for 6-decimal assets", () => {
    const r = req({ asset: OTHER, amount: 1000n * 10n ** 6n, collateral: E18 / 50n, collateralRemaining: E18 / 50n });
    const m = suggestMatches(r, [offer(1n, 0n, 500, { asset: OTHER, remaining: 500n * 10n ** 6n })], ctx({ decimals: 6, minLoan: 10n ** 6n }));
    expect(m.fills[0].crBps).toBe(collateralRatioBps(E18 / 100n, PRICE, 500n * 10n ** 6n, 6).toString());
  });
});

describe("suggestRequestsForOffer", () => {
  it("orders by highest max APR, then earliest expiry, then id; filters ineligible", () => {
    const o = offer(1n, 500n, 500);
    const rs = [
      req({ id: 1n, maxAprBps: 600, expiry: NOW + 500 }),
      req({ id: 2n, maxAprBps: 900, expiry: NOW + 500 }),
      req({ id: 3n, maxAprBps: 600, expiry: NOW + 100 }),
      req({ id: 4n, maxAprBps: 400 }), // apr too low
      req({ id: 5n, duration: 60 * 86400 }), // too long
      req({ id: 6n, borrower: o.lender }), // self
      req({ id: 7n, asset: OTHER }),
      req({ id: 8n, expiry: NOW - 1 }),
    ];
    const out = suggestRequestsForOffer(o, rs, ctx());
    expect(out.map((x) => x.requestId)).toEqual(["2", "3", "1"]);
    expect(out[0].amount).toBe((500n * E18).toString());
    expect(out[0].crBps).toBe("20000");
  });

  it("returns [] without a price or for an expired offer", () => {
    expect(suggestRequestsForOffer(offer(1n, 100n, 500), [req()], ctx({ price: null }))).toEqual([]);
    expect(suggestRequestsForOffer(offer(1n, 100n, 500, { expiry: NOW - 1 }), [req()], ctx())).toEqual([]);
  });
});

describe("DTO adapters", () => {
  it("offerFromDTO / requestFromDTO map statuses and strings", () => {
    const o = offerFromDTO({
      id: "7", lender: BOB as `0x${string}`, asset: MUSD as `0x${string}`, amount: "10", remaining: "5", aprBps: 1, maxDuration: 2,
      minCrBps: 3, expiry: 4, createdAt: 5, fills: 0, status: "expired", txHash: null,
    });
    expect(o).toMatchObject({ id: 7n, remaining: 5n, open: true });
    const r = requestFromDTO({
      id: "8", borrower: BOB as `0x${string}`, asset: MUSD as `0x${string}`, amount: "10", filled: "1", maxAprBps: 1, duration: 2,
      collateral: "3", collateralRemaining: "2", expiry: 4, createdAt: 5, fills: 1, status: "filled", crBps: null, txHash: null,
    });
    expect(r).toMatchObject({ id: 8n, filled: 1n, open: false });
  });
});
