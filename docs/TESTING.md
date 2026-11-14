# Testing

## Contracts

Foundry project in `contracts/` (Solidity 0.8.28, EVM london, optimizer 200 runs, OZ 5.4, forge-std vendored).

### How to run

```bash
cd contracts
forge build --sizes                          # compile + EIP-170 size table
forge test                                   # all suites (unit, fuzz 512 runs, invariant 128x64)
forge test --match-contract MarketplaceTest  # one suite
forge test --match-test test_partial_match_ABC_example -vvvv   # one test with traces
forge coverage --report summary --ir-minimum # coverage (~40 s; --ir-minimum avoids stack-too-deep with the optimizer off)
```

Local end-to-end on anvil (Deploy + two-wallet Demo):

```bash
anvil --port 8547 &
cd contracts
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8547 --broadcast
LENDER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
BORROWER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
  forge script script/Demo.s.sol --rpc-url http://127.0.0.1:8547 --broadcast --slow --gas-estimate-multiplier 200
```

These are anvil's public default keys (accounts 0, 1, 2), so they're safe to print. Set `DEPLOYER_PRIVATE_KEY` in the shell to override `contracts/.env`. On 31337, Deploy deploys a mock MUSD and a mock BTC/USD feed ($100,000, always fresh). It mints 100,000 MUSD to accounts 0..3 and writes `deployments/31337.json`.

### Suites

| File | Suite | Tests | Covers |
|---|---|---|---|
| `test/Oracle.t.sol` | OracleTest | 14 | 18/8/24-decimal scaling, answer <= 0, stale bound, future `updatedAt`, `answeredInRound = 0`, feed revert, code-less feed (tryGetPrice never reverts), setFeed/setMaxStaleness bounds, admin-only |
| `test/Config.t.sol` | ConfigTest | 8 | every risk-param hard bound, asset configuration (decimals 1..18, min/max), pause/unpause, role checks |
| `test/Vault.t.sol` | VaultTest | 10 | deposit/withdraw, reserved/lent not withdrawable, fee-on-transfer rejected on deposit, every MARKET/LOAN function unauthorized + insufficient-balance paths |
| `test/Collateral.t.sol` | CollateralTest | 11 | deposit/withdraw, direct transfer reverts (receive + fallback), locked not withdrawable, re-entrant receiver blocked (inner error = `ReentrancyGuardReentrantCall`), rejecting receiver, double release/seize, role checks |
| `test/Marketplace.t.sol` | MarketplaceTest | 40 | offers and requests create/cancel with full validation, full match, docs A/B/C partial-match example, rounding of shares, every match revert (expired, cancelled, filled, double match, overfill, APR too high, duration too long, insufficient CR, self-match, asset mismatch, not party, fill too small, collateral cap, asset disabled), stale/invalid oracle blocks request + all three match paths, fundRequest, borrowFromOffer, views, pagination |
| `test/LoanManager.t.sol` | LoanManagerTest | 21 | interest vs reference (incl. round-up, after maturity), owedAt, partial repayments interest-first, full repay + collateral release + both withdrawals, cap at owed, double repay, third-party repay, fee-on-transfer rejected on repayment, hook-token re-entry into `repay` and `Vault.withdraw`, 6-decimal (mUSDC-like) math, access control, getLoans |
| `test/Liquidation.t.sol` | LiquidationTest | 13 | undercollateralized + overdue (boundary at maturity+grace), split math vs reference, bonus capped at collateral, interest counted in debt, healthy loan reverts, unauthorized caller, stale price blocks liquidation (repay still works), double liquidation, repaid loan, 6-decimal split, works while paused |
| `test/Pause.t.sol` | PauseTest | 2 | deposits, collateral deposits, listings and all matches blocked; withdraw, cancel, repay, collateral withdraw allowed |
| `test/Fuzz.t.sol` | FuzzTest | 8 | interest formula, loan interest + full repay, partial repay split, quoteCollateralRatio, minCollateral exact boundary, maxBorrow respects CR (18 and 6 dec), partial-fill shares sum to collateral, liquidation split (512 runs each) |
| `test/invariant/Invariant.t.sol` | InvariantTest | 8 | 7 stateful invariants (see docs/SECURITY.md) over a 14-action handler (`test/invariant/Handler.sol`), plus a deterministic depth check |

Mocks (test-only, `test/mocks/`): `MockERC20` (configurable decimals), `MockFeeOnTransferToken`, `MockAggregator` (settable answer/updatedAt/revert/decimals, `live` mode returns `block.timestamp`), `Attackers.sol` (re-entrant collateral receiver, rejecting receiver, hook token `ReentrantToken`).

### Results (2026-11-07)

```
Ran 10 test suites: 135 tests passed, 0 failed, 0 skipped (135 total tests)
  OracleTest 14 | ConfigTest 8 | CollateralTest 11 | VaultTest 10 | MarketplaceTest 40
  LoanManagerTest 21 | LiquidationTest 13 | PauseTest 2 | FuzzTest 8 (512 runs) | InvariantTest 8 (128 runs x 64 depth)
```

Invariant handler: 0 reverts across ~8,200 calls per invariant. The deterministic depth run reached 11 matches, 8 repayments and 3 liquidations in 600 steps.

`forge coverage --report summary --ir-minimum` (src only):

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| CollateralManager.sol | 100.00% (79/79) | 94.32% (83/88) | 72.22% (13/18) | 100.00% (15/15) |
| LiquidationEngine.sol | 100.00% (56/56) | 98.80% (82/83) | 80.00% (8/10) | 100.00% (7/7) |
| LiquidityXVault.sol | 100.00% (78/78) | 97.83% (90/92) | 89.47% (17/19) | 100.00% (9/9) |
| LoanManager.sol | 100.00% (112/112) | 100.00% (145/145) | 93.75% (15/16) | 100.00% (13/13) |
| LoanMarketplace.sol | 100.00% (189/189) | 99.33% (297/299) | 96.23% (51/53) | 100.00% (26/26) |
| PriceOracleAdapter.sol | 100.00% (53/53) | 94.05% (79/84) | 68.75% (11/16) | 100.00% (10/10) |
| ProtocolConfig.sol | 95.56% (43/45) | 95.65% (66/69) | 87.50% (7/8) | 100.00% (11/11) |

Contract sizes (`forge build --sizes`, runtime / EIP-170 limit 24,576 B): LoanMarketplace 16,846; LoanManager 7,358; LiquidationEngine 6,264; LiquidityXVault 6,263; CollateralManager 4,983; ProtocolConfig 4,594; PriceOracleAdapter 3,333.

Local E2E (anvil, 2026-11-07): Deploy wrote `deployments/31337.json`. Demo ran deposit → offer → request (200% CR) → match → repay max → withdraw collateral → withdraw MUSD. Loan 1 ended `Repaid`, and the vault and CollateralManager ended empty.
