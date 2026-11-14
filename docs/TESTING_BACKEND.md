# Testing: backend (indexer, API, matcher)

Run from `web/`:

```
pnpm test:server        # backend only (vitest project "server", node env)
pnpm test               # all vitest projects (server + ui)
pnpm exec tsc --noEmit  # types
```

No network, no Postgres and no deployed contracts are needed. Each test file opens one in-memory PGlite
(`openPglite()` with no data dir) and truncates every table between tests. The chain is a fake
(`tests/server/helpers/fake-chain.ts`): it holds offers/requests/loans, answers `readContract`/`multicall`,
serves `getLogs` from a list of logs ABI-encoded with the real event ABIs from `web/lib/abi`, and can fail
the next N RPC calls (`failNext`) or every call (`down`). `setTestContext` swaps in the fake client, a test
deployment (or `null` for "not deployed") and a chain with or without multicall3.

## What is covered

| File | Cases |
|---|---|
| `tests/server/matching.test.ts` | CONTRACTS.md example (1,000 MUSD @ max 8%; A 400@5% + B 300@6% = 700, `partially_matchable`, C excluded `apr`), pro-rata collateral shares, completing fill takes `collateralRemaining`, already-partially-filled request, tie-breakers (APR, expiry, id) independent of input order, exclusions (`expired`, `not_open`, `asset`, `self`, `duration`), expiry boundary, `collateral` (lender minCr and price drop), no price => nothing matchable, min size (skip partial fill < minLoan, allow completing fill < minLoan), closed/expired request, 6-decimal asset CR, `suggestRequestsForOffer` ordering and filters, DTO adapters |
| `tests/server/indexer.test.ts` | same log twice => one row; full sync of 5 events (entities reconciled from chain, creation tx hashes, account/asset filled for `LoanRepaid`, repayments, users, daily analytics); second sync is a no-op; getLogs ranges <= 9,000 blocks and stops at head - 2; reconciliation overwrites a stale DB status; list reads refresh stale rows and persist them; reorg (changed block hash) rolls back 50 blocks and re-indexes; entity that vanished in a reorg is deleted; retry 3 tries then success / give up; sync failure keeps the cursor and records `lastError`, `maybeSync` never throws, lists still served; reconcile failure doesn't advance the cursor and the next sync redoes the batch; no-multicall3 fallback with per-call failures; not-deployed sync is a no-op |
| `tests/server/routes.test.ts` | route handlers called directly (`connection()` mocked): 13 bad-param cases => 400 `bad_request` plus bad path params; pagination (`total`, last page, past-the-end page), sort/order, APR and amount filters; `expired` derived from expiry; requests `partially_filled`, live `crBps`, `minCr`, `sort=cr`, stale price => `crBps: null`; `/api/matches` A/B/C example and `/api/matches/for-offer`; unknown request 404; loan detail (live read, `overdue`, owed interest, health CR) and 404; loans by address/role/status; stats (chain totals, index counts, weighted APR); portfolio; config; price; health; RPC down => lists/stats still 200, price `ok:false`, health `rpcOk:false`, matches 503; not deployed => every route 200/404, never 500; sync route bearer auth |

## Manual checks against a running app

With `pnpm dev` running:

```
curl -s localhost:3000/api/health          # rpcOk, deployed, indexedToBlock, lagBlocks, lastError
curl -s localhost:3000/api/config          # addresses + live risk params
curl -s -X POST localhost:3000/api/indexer/sync -H "authorization: Bearer $INDEXER_SECRET"
```

Checked on 2026-11-07 against the dev server before the contracts were deployed: every route returned 200
(empty lists, `deployed:false`) or 404 for id lookups, a bad `pageSize` returned 400, and the sync route
returned 401 without the token. PGlite created `web/.data/pglite` on first use.

After deployment, `lagBlocks` in `/api/health` should stay small (a few blocks) while the app is in use: read
routes run a throttled catch-up sync (at most once per 10 s per instance, waiting at most about 8 s).
