# Demo script (about 4 minutes)

The story: idle MUSD meets a borrower who needs liquidity. They agree terms, BTC gets locked, and the loan runs on-chain from start to finish.

You need two browser profiles (or two wallets) on Mezo testnet (chain 31611):
- **Wallet A (lender)**: a little testnet BTC for gas, plus MUSD (borrow it at testnet.mezo.org; the minimum there is 1,800 MUSD).
- **Wallet B (borrower)**: testnet BTC for gas and collateral (faucet.test.mezo.org).

Every step below shows a toast with an explorer link. Open it on screen once so viewers see the transaction is real.

| # | Who | Where | Do | Point out |
|---|---|---|---|---|
| 1 | — | `/marketplace` | Show the requests and offers tabs and the summary row | The summary figures come from contract views. Nothing is seeded |
| 2 | A | `/lend` | Connect, deposit 100 MUSD (approve, then deposit) | Available balance goes up. The vault holds the funds, not the app |
| 3 | A | `/lend` | Create offer: 100 MUSD, 6% APR, up to 30 days, min CR 150%, expires in 7 days | The offer reserves the deposit, so it's always funded |
| 4 | B | `/borrow` | Connect, enter 50 MUSD, enter BTC collateral until CR is about 200%, max APR 8%, 7 days | Live oracle price, CR, max borrow, liquidation price, estimated repayment |
| 5 | B | `/borrow` | Submit the request (one transaction, BTC sent with it) | The collateral is now locked in the contract |
| 6 | B | `/marketplace` → request → Match | The match panel shows A's offer filling 50 at 6% | The agreed APR is the lender's 6%, under B's 8% cap |
| 7 | B | Match → confirm | One transaction. The contract checks every term again, opens the loan and pays B | B's MUSD balance goes up by 50 |
| 8 | both | `/loans/[id]` | Principal, APR, CR, interest accruing, maturity countdown | Same math as the contract (`owedAt`) |
| 9 | B | `/loans/[id]` | Repay in full (approve the vault, then repay) | Interest is paid first, then principal |
| 10 | B | `/loans/[id]` | Withdraw collateral | BTC comes back to the wallet |
| 11 | A | `/lend` or `/portfolio` | Available balance shows principal plus interest; withdraw | Interest earned is shown |
| 12 | both | `/activity` | Every step listed with explorer links | |

To show partial matching, add a third wallet, or have A post two offers (40 @ 5% and 30 @ 6%) and B request 100 @ 8% max. The match panel fills 70 across two loans. An offer at 9% shows as excluded for its APR.

Scripted version (no browser): `forge script script/Demo.s.sol --rpc-url mezo_testnet --broadcast --skip-simulation --slow --legacy --gas-estimate-multiplier 200` with `LENDER_PRIVATE_KEY` and `BORROWER_PRIVATE_KEY` set (see docs/DEPLOYMENT.md).
