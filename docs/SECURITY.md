# Security

> **LiquidityX has NOT been independently audited.** It is a testnet product on Mezo testnet (chain 31611). What follows is the development team's own threat model and self-review, backed by tests. It is not a third-party audit.

Scope: `contracts/src/*.sol` (seven contracts) against the frozen interfaces in `contracts/src/interfaces/`. Solidity 0.8.28, EVM london, OpenZeppelin 5.4.

## Threat model

**Assets at risk**
- Lender stablecoins (MUSD; mUSDC if enabled) held by `LiquidityXVault`.
- Borrower BTC (native, `msg.value`) held by `CollateralManager`.
- Correctness of loan accounting (principal, interest, collateral) in `LoanManager`.

**Actors**
| Actor | Trust | Can do |
|---|---|---|
| Lender | untrusted | deposit, withdraw available, create/cancel offers, match own offers, fund requests, liquidate own eligible loans |
| Borrower | untrusted | deposit/withdraw free BTC, create/cancel requests, match own requests, borrow from offers, repay |
| Anyone | untrusted | repay any loan (pays with own tokens; collateral still goes to the borrower) |
| Keeper (`KEEPER_ROLE`) | semi-trusted | liquidate any *eligible* loan (proceeds go to lender/borrower, never to the keeper) |
| Admin roles | trusted | see "Privileged roles" |
| Oracle feed | trusted input | sets the BTC/USD price used for CR checks and liquidation |

**Trust boundaries**
- Only `LoanMarketplace` (`MARKET_ROLE`) can reserve/release vault liquidity, lock/unlock request collateral and open loans.
- Only `LoanManager` (`LOAN_ROLE`) can move funds out of the vault to borrowers, pull repayments, write off principal, and assign/release/seize collateral.
- Only `LiquidationEngine` (`LIQUIDATOR_ROLE`) can settle a liquidation in `LoanManager`.
- Users never receive pushed native BTC except from their own `withdrawCollateral` call. Repayment and liquidation proceeds are credited to internal balances (pull model), so a hostile lender or borrower contract cannot block another party's action.

## Privileged roles

| Contract | Role | Holder after deploy | Power |
|---|---|---|---|
| all | `DEFAULT_ADMIN_ROLE` | deployer EOA | grant/revoke every role on that contract. **On the vault and collateral manager this is effectively custody**: granting `LOAN_ROLE` to an arbitrary address would let it move funds. |
| ProtocolConfig | `RISK_ADMIN_ROLE` | deployer | change risk params within hard bounds; enable/disable assets; set min/max loan sizes |
| ProtocolConfig | `PAUSER_ROLE` | deployer | pause/unpause new deposits, listings and matches (never exits) |
| PriceOracleAdapter | `DEFAULT_ADMIN_ROLE` | deployer | change the feed address and the staleness window (30 s to 1 day). A malicious feed can trigger liquidations. |
| Vault / CollateralManager | `MARKET_ROLE` | LoanMarketplace | reserve/release liquidity, lock/unlock request collateral, credit `msg.value` |
| Vault / CollateralManager | `LOAN_ROLE` | LoanManager | fund loans, collect repayments, write off principal, assign/release/seize loan collateral |
| LoanManager | `MARKET_ROLE` | LoanMarketplace | open loans |
| LoanManager | `LIQUIDATOR_ROLE` | LiquidationEngine | settle liquidations |
| LiquidationEngine | `KEEPER_ROLE` | nobody (optional) | liquidate eligible loans on any lender's behalf |

Mitigation for production (not done on testnet): move `DEFAULT_ADMIN_ROLE` to a multisig behind a timelock, or renounce it on the custody contracts once wiring is final.

Hard bounds on risk params (`setRiskParams` reverts `InvalidRiskParams` otherwise): `10_500 <= liquidationCr < minInitialCr <= 50_000`, `bonus <= 2_000`, `10_000 + bonus <= liquidationCr`, `1 <= minApr <= maxApr <= 50_000`, `60 <= minDuration <= maxDuration <= 730 days`, `grace <= 30 days`, `1 hours <= maxListingLifetime <= 365 days`, `maxCollateralPerLoan > 0`.

## Financial invariants and the tests that cover them

Stateful invariants run in `test/invariant/Invariant.t.sol` (128 runs x 64 calls over 14 random actions, including price moves and time jumps). `test_handler_reaches_deep_paths` confirms the action mix reaches matches, repayments and liquidations.

| # | Invariant | Covered by |
|---|---|---|
| 1 | `token.balanceOf(vault) >= totalAvailable + totalReserved` for every asset | `invariant_vaultBalanceCoversAvailableAndReserved` |
| 2 | `CollateralManager.balance == totalFree + totalLockedInRequests + totalLockedInLoans` | `invariant_collateralBalanceExact`, `CollateralTest.test_internal_paths` |
| 3 | Per-lender `available` / `reserved` / `lent` sum to the asset totals | `invariant_lentAccounting` |
| 4 | `totalLent` == sum of outstanding principal of Active loans | `invariant_lentAccounting` |
| 5 | `offer.remaining <= offer.amount`; closed offers have `remaining == 0`; `totalReserved` == sum of Open offers' `remaining` | `invariant_offers` |
| 6 | `request.filled <= request.amount`; `Filled` iff `filled == amount`; the request lock equals `collateralRemaining` | `invariant_requests`, `MarketplaceTest.test_partial_match_ABC_example` |
| 7 | A Repaid loan has no outstanding principal or interest | `invariant_loans`, `LoanManagerTest.test_full_repay_releases_collateral_and_withdraw` |
| 8 | A closed (Repaid/Liquidated) loan holds no collateral; an Active loan holds exactly `loan.collateral` | `invariant_loans`, `CollateralTest.test_internal_paths` (double release/seize revert) |
| 9 | Interest is exactly `ceil(p * apr * dt / (YEAR * BPS))` and never below the exact value | `FuzzTest.testFuzz_accrueInterest_reference`, `testFuzz_loan_interest_and_full_repay`, `testFuzz_partial_repay_split` |
| 10 | Liquidation split: `lender + borrower == collateral`, `lender == min(collateral, ceil(debtUsd*1e18/price) * (BPS+bonus)/BPS)` | `FuzzTest.testFuzz_liquidation_split`, `LiquidationTest.*` |

The safety rules in `docs/CONTRACTS.md` map to: rule 1 `VaultTest.test_cannot_withdraw_reserved_or_lent`; rule 2 `CollateralTest.test_locked_collateral_not_withdrawable`; rule 3 match/CR tests in `MarketplaceTest`; rule 4 `test_match_filled_and_double_match`, `test_match_overfill_reverts`; rule 5 `test_repay_capped_at_owed`, `test_double_repay_reverts`; rule 6 `test_internal_paths`, `test_double_liquidation_and_closed_loans`; rule 7 `LiquidationTest`; rule 8 `test_stale_oracle_blocks_request_and_match`, `test_invalid_oracle_blocks_request_and_match`; rule 9 `test_match_expired`, `test_match_cancelled`; rule 10 `test_fee_on_transfer_rejected_on_deposit`, `test_fee_on_transfer_rejected_on_repayment`; rule 11 `PauseTest`; rule 12 by construction (only paginated views loop).

## Self-review (development team, not an audit)

| Area | What we checked | Result |
|---|---|---|
| Reentrancy | Every state-changing external function is `nonReentrant`; state is written before external calls (CEI). `withdrawCollateral` debits before the native call. Hook-token re-entry into `repay` and `Vault.withdraw` is tested. | `test_reentrancy_on_withdrawCollateral_blocked`, `test_reentry_error_is_reentrancy_guard`, `test_reentrancy_on_repay_blocked` pass. No finding. |
| Rounding | Interest up; collateral share down (floor); required collateral up (ceil); CR down (floor); liquidation `debtBtc` up, bonus floor. All match `web/lib/finance.ts`. | Fuzzed against reference formulas. No finding. |
| Access control | Every privileged function is role-gated; each is tested with an unauthorized caller. | No finding. |
| Double spend | Offer/request status and `remaining`/`filled` are checked and updated in the same transaction; collateral release/seize zero the lock; loans must be Active to repay or liquidate. | Covered by double-match / double-repay / double-liquidation tests and invariants. No finding. |
| DoS | No push payments to counterparties; no unbounded loops in state-changing code; repayment pulls from `msg.sender` only. | No finding. See "Known risks" for token-level DoS. |
| Oracle | Answer must be > 0; stale if `now - updatedAt > maxStaleness`; future `updatedAt` treated as fresh; `answeredInRound` ignored (Mezo returns 0); `tryGetPrice` uses a low-level staticcall so it never reverts. | Tested with a mock aggregator. No finding. |
| Arithmetic | Max values (loan <= 1e24 wei-units, APR <= 5e4, dt <~ 1e10, price ~1e23, collateral <= cap) keep every product far below 2^256; 0.8 checked math on everything. | No finding. |

## Oracle risks

- The Mezo BTC/USD feed (`0x7b7c…0015`) is a native precompile. On testnet its price is not the market price. Liquidations follow it.
- If the feed is stale (> 1 hour by default) or invalid: new requests, all matches and all liquidations revert. Repayment, cancellation and withdrawals keep working. A long outage means overdue loans can't be liquidated until the feed recovers. Interest keeps accruing in the meantime.
- The admin can switch the feed. A wrong or malicious feed can force liquidations or block new loans.
- Forge cannot run the precompile locally. Scripts mock it **during simulation only** (`script/MezoFeedSim.sol`) with the live values from `eth_call`. Broadcast transactions use the real precompile.

## Liquidation model limits

- No on-chain BTC/stablecoin market is assumed. The lender is paid in BTC (debt value + 5% bonus, capped at the collateral) and has to sell it themselves.
- If the collateral is worth less than the debt (a gap move or late liquidation), the lender takes all the collateral and absorbs the shortfall. There is no insurance fund and no bad-debt socialisation.
- Only the lender or a keeper can liquidate. With no keeper running, an unattended loan can go deeper underwater.
- Overdue liquidation still needs a fresh price. It's settled at the oracle price.
- Liquidation is all-or-nothing. There are no partial liquidations.

## Known risks and limitations

1. **Not audited.** Testnet only.
2. **Centralised admin.** The deployer EOA holds every admin role (see above).
3. **Stablecoin peg assumption.** Every borrow asset is valued at exactly $1.
4. **Token-level DoS.** mUSDC is an upgradeable proxy that its issuer may pause or blacklist. A blacklisted lender or borrower could be unable to withdraw or repay. That's why mUSDC is disabled by default. Fee-on-transfer and rebasing-on-transfer tokens are rejected by balance-delta checks, but the allowlist is the main control.
5. **Request fragmentation.** Anyone can `fundRequest` a borrower's request at the borrower's max APR in fills of at least `minLoan`. This can split a request into many loans that each need their own repayment. This is by design: the borrower set the max APR, and `minLoan` bounds the fragmentation.
6. **Rounding dust.** Interest rounds up on every checkpoint, so many tiny repayments cost the payer at most 1 wei of extra interest per repayment.
7. **Expiry boundary.** A listing is expired when `block.timestamp >= expiry`. That matches the creation rule, which requires `now < expiry`.
8. **Simulation-only oracle mock.** The testnet deploy/demo must be broadcast with `--skip-simulation`, so forge skips its second on-fork simulation, which would hit the real precompile stub and fail. Gas limits are then estimated at broadcast time instead of from that simulation.
