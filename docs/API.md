# HTTP API

Shapes: `web/lib/api-types.ts` (frozen). All routes are `GET` unless noted. Query params are validated with zod. On a bad param the route returns 400 `{error:{code:"bad_request",message}}`.

| Route | Returns | Notes |
|---|---|---|
| `/api/health` | `{ok, chainId, rpcOk, indexedToBlock, headBlock, lagBlocks, db:"postgres"\|"pglite"}` | |
| `/api/config` | `ConfigResponse` | addresses from `web/lib/chain.ts`; risk/assets/paused read live from ProtocolConfig |
| `/api/price` | `PriceResponse` | `PriceOracleAdapter.tryGetPrice()` |
| `/api/offers` | `Paged<OfferDTO>` | `asset, status, lender, minApr, maxApr, minAmount, maxAmount, maxDuration, sort=apr\|amount\|duration\|expiry\|created, order=asc\|desc, page (1-based), pageSize (<=100)` |
| `/api/requests` | `Paged<RequestDTO>` | same filters, plus `borrower, minCr` (bps) and `sort=cr` |
| `/api/loans` | `Paged<LoanDTO>` | `address, role=lender\|borrower\|any, status` |
| `/api/loans/[id]` | `{loan: LoanDTO, activity: ActivityDTO[]}` | loan read live from LoanManager + LiquidationEngine.health |
| `/api/matches` | `MatchSuggestion` | `requestId` (required). Uses live listings and the live price |
| `/api/matches/for-offer` | `{offerId, requests: {requestId, amount, collateralShare, crBps}[]}` | `offerId`: open requests this offer can fill, best first (highest max APR, then earliest expiry) |
| `/api/activity` | `Paged<ActivityDTO>` | `address, loanId, offerId, requestId, kind, page, pageSize` |
| `/api/stats` | `StatsResponse` | |
| `/api/portfolio/[address]` | `PortfolioResponse` | vault and collateral balances read live |
| `POST /api/indexer/sync` | `{fromBlock, toBlock, events}` | needs header `authorization: Bearer $INDEXER_SECRET`; Vercel Cron calls it every minute. Read routes also run a throttled catch-up sync (at most once every 10 s per instance) so the app works with no cron |

Indexer rules: process logs in chunks of at most 9,000 blocks. Each log is identified by `(chainId, txHash, logIndex)` with a unique constraint, so it's processed once (idempotent). Stay `CONFIRMATIONS = 2` blocks behind head. Keep the last 2 block hashes so a reorg can be detected: on a mismatch, roll back 50 blocks and re-index. Each touched offer, request or loan is re-read from chain after a batch (reconciliation). RPC calls retry with backoff, up to 3 times.

DB: `DATABASE_URL` (Postgres) if set, else PGlite at `web/.data/pglite` (on Vercel `/tmp`). Tables are the ones in the brief: `users, lending_offers, borrowing_requests, loans, repayments, indexed_events, price_snapshots, marketplace_analytics`, plus `sync_state`.
