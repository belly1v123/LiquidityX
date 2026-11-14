# Contracts

Source of truth for signatures, events and errors: `contracts/src/interfaces/ILiquidityX.sol` and `ILiquidityXTypes.sol` (**frozen**). This file covers behaviour, math and wiring.

## Contracts

| Contract | Holds | Role grants it receives |
|---|---|---|
| `PriceOracleAdapter` | nothing | — |
| `ProtocolConfig` | risk params, asset allowlist, global pause | — |
| `LiquidityXVault` | lender stablecoins | `MARKET_ROLE` → Marketplace, `LOAN_ROLE` → LoanManager |
| `CollateralManager` | native BTC | `MARKET_ROLE` → Marketplace, `LOAN_ROLE` → LoanManager |
| `LoanManager` | loan records | `MARKET_ROLE` → Marketplace, `LIQUIDATOR_ROLE` → LiquidationEngine |
| `LoanMarketplace` | offers, requests | — |
| `LiquidationEngine` | nothing | (`KEEPER_ROLE` optional) |

Constructors (all take `admin` = initial `DEFAULT_ADMIN_ROLE` holder; ProtocolConfig also gives `admin` RISK_ADMIN_ROLE and PAUSER_ROLE):

```
PriceOracleAdapter(address feed, uint256 maxStaleness, address admin)
ProtocolConfig(LXTypes.RiskParams params, address admin)
LiquidityXVault(IProtocolConfig config, address admin)
CollateralManager(IProtocolConfig config, address admin)
LoanManager(IProtocolConfig config, ILiquidityXVault vault, ICollateralManager collateral, address admin)
LoanMarketplace(IProtocolConfig config, IPriceOracleAdapter oracle, ILiquidityXVault vault, ICollateralManager collateral, ILoanManager loans, address admin)
LiquidationEngine(IProtocolConfig config, IPriceOracleAdapter oracle, ILoanManager loans, address admin)
```

Every contract uses OZ `AccessControl`, `ReentrancyGuard` on every state-changing external function, `SafeERC20`, custom errors, and checks-effects-interactions. The pause check calls `config.paused()`.

## Math (identical in `web/lib/finance.ts`)

```
BPS = 10_000, YEAR = 365 days, WAD = 1e18
usd(amount, d)          = amount * 10**(18-d)
collateralUsd           = collateral * price / WAD                        (floor)
CR (bps)                = collateralUsd * BPS / usd(debt, d)              (floor; max uint if debt 0)
maxBorrow               = (collateralUsd * BPS / crBps) / 10**(18-d)     (floor)
minCollateral           = ceil(usd(amount,d) * crBps * WAD / (BPS * price))
accrue(dt)              = ceil(outstanding * aprBps * dt / (YEAR * BPS))
fill share              = collateralRemaining if the fill completes the request, else floor(collateral * fill / amount)
liquidation debtBtc     = ceil(usd(debt,d) * WAD / price)
lenderCollateral        = min(collateral, debtBtc * (BPS + bonus) / BPS)
```

Interest accrues on outstanding principal from `start`, is checkpointed on every repayment, and keeps running after maturity. Repayments pay interest first, then principal. Rounding always favours the lender (interest up) and the protocol's solvency (collateral share down, required collateral up).

## Lifecycles

**Offer**: `createOffer` (vault available → reserved) → fills reduce `remaining` (reserved → lent) → `remaining == 0` ⇒ `Filled`; `cancelOffer` releases `remaining` ⇒ `Cancelled`. An Open offer past `expiry` can't be filled. The UI shows it as "Expired", and the lender cancels it to get the liquidity back.

**Request**: `createRequest` (msg.value → free → locked in the request; CR checked at the current price) → fills move each collateral share request → loan and add to `filled` → `filled == amount` ⇒ `Filled`; `cancelRequest` returns `collateralRemaining` to free ⇒ `Cancelled`.

**Loan**: `Active` → `repay` (partial: interest first, then principal; full: `Repaid`, collateral → borrower free balance) or `liquidate` (`Liquidated`; the vault writes off the principal, collateral is split lender/borrower into free balances). Free BTC is withdrawn with `CollateralManager.withdrawCollateral`. Stablecoins are withdrawn with `Vault.withdraw`.

**Partial matching**: a 1,000 MUSD request at 8% max can be filled by offer A (400 @ 5%) and offer B (300 @ 6%) as two calls to `matchOfferAndRequest`. That opens loan 1 (400 @ 5%, 40% of the collateral) and loan 2 (300 @ 6%, 30%). The request stays Open with 300 unfilled. Offer C (9%) reverts with `AprTooHigh`.

## Safety rules the implementation must enforce

1. A lender can't withdraw reserved or lent funds (vault keeps separate buckets).
2. Locked collateral can't be withdrawn (only free balances are withdrawable).
3. A loan opens only with reserved/available lender funds and enough collateral at a fresh price.
4. Listings track `remaining`/`filled`, so they can't be overfilled. Status is checked in the same transaction, so a double match reverts.
5. `repay` caps at what is owed. A loan that is not Active can't be repaid or liquidated.
6. Collateral release and seizure empty the loan's lock, so neither can happen twice.
7. Liquidation needs CR < liquidationCr or now > maturity + grace, and a fresh price.
8. Stale or invalid oracle data blocks new requests and matches.
9. Cancelled, filled or expired listings can't be matched.
10. Fee-on-transfer tokens are rejected (balance-delta check on deposit and repayment).
11. Withdraw, cancel, repay and liquidate all work while paused. Deposits, listings and matches don't.
12. No unbounded loops in state-changing code. Paginated views only.

## Deployment wiring (script/Deploy.s.sol)

1. Deploy the adapter (feed = `0x7b7c…0015`, maxStaleness 3600), then config with these default params:
   minInitialCr 15000, liquidationCr 12000, bonus 500, minApr 1, maxApr 10000, minDuration 1 hours, maxDuration 365 days, grace 1 days, maxListingLifetime 30 days, maxCollateralPerLoan 10 BTC.
2. Deploy the vault, collateral manager, loan manager, marketplace and engine.
3. Grant roles as in the table above.
4. `configureAsset(MUSD, true, 1e18 /*1 MUSD*/, 1_000_000e18)`. mUSDC is optionally configured disabled.
5. Write `contracts/deployments/31611.json` with `{chainId, deployer, startBlock, contracts:{...}, assets:{...}, txs:{...}}`.
