# LiquidityX

Put idle stablecoin liquidity to work. Borrow against Bitcoin. Set the terms yourself.

LiquidityX is a peer-to-peer, fixed-rate lending marketplace on Mezo testnet. Lenders post funded MUSD offers at the rate they want. Borrowers lock native BTC and post requests with the highest rate they'll pay. The contracts match the two, open a loan with fixed terms, and enforce repayment and collateral release.

## Problem and solution

Holders of MUSD have few ways to lend it at terms they choose, and borrowers get a protocol-set rate or nothing. LiquidityX lets both sides post terms, and lets the market find the rate. Each loan has one lender, one borrower, one fixed APR and its own collateral, all visible on-chain.

## Why Mezo

MUSD and native BTC live on the same chain, BTC is the gas token (so a contract can hold it with no wrapper), and Mezo exposes a BTC/USD oracle as a precompile. That is everything a BTC-backed stablecoin credit market needs.

## How it works

1. A lender deposits MUSD into the vault and creates an offer (amount, APR, max term, min collateral ratio, expiry). The offer reserves the deposit, so it's always funded.
2. A borrower creates a request (amount, max APR, term, expiry) and sends BTC with it. The BTC is locked.
3. Matching: the backend suggests the cheapest offers that fit (lowest APR, then earliest expiry). Either party submits the match; the contract re-checks every term. A request can be filled by several lenders, each becoming its own loan with a pro-rata share of the collateral. Lenders can also fund a request directly at an APR they choose (up to the borrower's maximum), and borrowers can take an offer directly.
4. Interest is simple and fixed: `ceil(principal × APR × time / (365 days × 10,000))`, the same in Solidity and TypeScript.
5. Repay any time (interest first). Repayments land in the lender's vault balance immediately; full repayment frees the collateral.
6. If the collateral ratio falls under 120% or the loan is a day past due, the lender can liquidate: they receive BTC worth the debt plus 5% (capped at the collateral) and the rest goes back to the borrower.

LiquidityX does not fund Mezo troves. Mezo's own MUSD borrowing has no interface for third-party lenders, so LiquidityX is a separate system with its own contracts (see `docs/TECHNICAL_DISCOVERY.md`).

## Architecture

- `contracts/`: Foundry. PriceOracleAdapter, ProtocolConfig, LiquidityXVault, CollateralManager, LoanManager, LoanMarketplace, LiquidationEngine. OpenZeppelin AccessControl, ReentrancyGuard, Pausable, SafeERC20. 135 tests including fuzz and stateful invariants.
- `web/`: Next.js 16, wagmi/viem, TanStack Query. API routes index contract events into Postgres (PGlite locally); the chain stays the source of truth.

Wallets connect through **Mezo Passport**: Bitcoin wallets (Unisat, OKX, Xverse) through Mezo smart accounts, or any EVM wallet.

Docs: [audit](docs/AUDIT_2026-11-12.md) · [technical discovery](docs/TECHNICAL_DISCOVERY.md) · [architecture](docs/ARCHITECTURE.md) · [contracts](docs/CONTRACTS.md) · [API](docs/API.md) · [security](docs/SECURITY.md) · [testing](docs/TESTING.md) · [backend testing](docs/TESTING_BACKEND.md) · [deployment](docs/DEPLOYMENT.md) · [demo script](docs/DEMO_SCRIPT.md) · [design](docs/DESIGN.md)

## Run locally

```bash
# 1. chain + contracts
anvil --port 8545 --block-time 1 &
cd contracts
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
# 2. app
cd ../web && pnpm install && pnpm abi
NEXT_PUBLIC_CHAIN=local pnpm dev
```

Import anvil accounts 1–3 into a wallet (each has 100,000 mock MUSD and 10,000 BTC). Locally the price feed is a mock fixed at $100,000.

Tests: `cd contracts && forge test` · `cd web && pnpm test`.

## Testnet deployment

Live on Mezo testnet (chain 31611), all contracts source-verified. App: https://liquidityx-taupe.vercel.app. Addresses, deploy transactions and a full two-wallet loan on testnet (deposit → offer → request → match → repay → collateral back → withdraw) are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Known limits

- Testnet only. The BTC/USD feed is Mezo's testnet oracle; liquidations follow it.
- Lenders are repaid in BTC on liquidation; there is no automatic sale to MUSD.
- A stale oracle blocks new loans and liquidations (repayment still works).
- mUSDC is supported by the contracts but disabled: it isn't in Mezo's official contract list and is upgradeable.
- The deployer holds admin roles. Production would need a multisig and timelock.
- Not independently audited. An AI-assisted review (Pashov solidity-auditor, 2 passes) found 6 issues, all fixed: [docs/AUDIT_2026-11-12.md](docs/AUDIT_2026-11-12.md).

## Roadmap

Rate discovery from utilisation, BTC→MUSD liquidation through a DEX, offer/request order-book signatures (gasless listings), loan transfer (secondary market for lender positions), multisig governance.
