# Architecture

```
            ┌────────────── Browser (Next.js app, wagmi/viem) ──────────────┐
            │ reads: contract views (truth) + /api (index, matches, stats)  │
            │ writes: wallet-signed txs straight to the contracts           │
            └───────────────┬───────────────────────────┬───────────────────┘
                            │ JSON                       │ RPC
               ┌────────────▼──────────┐       ┌─────────▼──────────────────────────────┐
               │ Next.js API routes    │ RPC   │ Mezo testnet (31611)                   │
               │ indexer + matcher     ├──────►│ Marketplace ─► LoanManager ─► Vault    │
               │ Postgres / PGlite     │       │      │             │       └► CollateralMgr
               └───────────────────────┘       │      └─► Oracle adapter ─► BTC/USD precompile
                                               │ LiquidationEngine ─► LoanManager       │
                                               └────────────────────────────────────────┘
```

**Source of truth.** Funds, listings, loans and collateral live only in the contracts. The database is a rebuildable index of events. If you drop it and re-sync from `startBlock` you get the same state. API responses that show balances or loan figures read contract views at request time. Lists come from the index, and each item's status is reconciled against chain.

## Repo layout

```
contracts/            Foundry project
  src/interfaces/     FROZEN interfaces and types
  src/                implementations
  test/               unit, fuzz, invariant, reentrancy tests (mocks live here only)
  script/             Deploy.s.sol, Demo.s.sol (two-wallet lifecycle on a live chain)
  deployments/31611.json
web/                  Next.js 16 app (Vercel root)
  lib/finance.ts      FROZEN math mirror
  lib/api-types.ts    FROZEN API shapes
  lib/chain.ts        chain + addresses (single place)
  lib/abi/            ABIs generated from contracts/out (scripts/export-abi.mjs)
  lib/server/         indexer, db, matcher, chain reads (server-only)
  app/api/            HTTP API (docs/API.md)
  app/(pages)         landing, marketplace, lend, borrow, loans/[id], portfolio, activity
docs/
```

## Who owns what (one owner per path)

| Owner | Paths |
|---|---|
| Architect (lead) | `contracts/src/interfaces/**`, `web/lib/finance.ts`, `web/lib/api-types.ts`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/API.md`, `docs/TECHNICAL_DISCOVERY.md`, integration, deployment |
| Contracts | `contracts/src/*.sol` (not interfaces), `contracts/test/**`, `contracts/script/**`, `docs/SECURITY.md` (first draft), `docs/TESTING.md` contract section |
| Backend | `web/lib/server/**`, `web/lib/matching.ts`, `web/app/api/**`, `web/tests/server/**`, `web/drizzle/**` |
| Frontend | `web/app/**` except `app/api`, `web/components/**`, `web/hooks/**`, `web/lib/wagmi.ts`, `web/lib/format.ts`, `web/public/**`, `web/tests/ui/**` |
| Shared, frontend creates | `web/lib/chain.ts`, `web/lib/abi/**`, `web/scripts/export-abi.mjs` (backend imports them read-only) |

Changes to frozen files go through the architect.

## Matching

`web/lib/matching.ts` is a pure, deterministic function, `suggestMatches(request, offers, config, price, now)`:
1. Exclude offers that are not open, expired, for a different asset, have APR > request max APR, have maxDuration < request duration, belong to the same wallet, or whose required CR (max(offer.minCr, config.minInitialCr)) isn't met by the fill's collateral share at the current price.
2. Sort by APR ascending, then expiry ascending, then id ascending.
3. Fill greedily: `fill = min(unfilled, offer.remaining)`. Skip fills below `minLoan` unless they complete the request.
4. Return fills and a state (`unmatched` / `partially_matchable` / `fully_matchable`) with reasons for every excluded offer.

The UI runs each suggested fill as its own `matchOfferAndRequest` transaction. The contract checks every term again. The server never executes anything.
