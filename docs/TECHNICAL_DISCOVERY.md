# Technical discovery

Checked on 2026-11-07 against the live Mezo testnet RPC, the Blockscout explorer API and the official docs. Every address below was read from chain, not copied from memory.

## Network

| Item | Value | How verified |
|---|---|---|
| Chain ID | `31611` (`0x7b7b`) | `eth_chainId` on the RPC |
| RPC | `https://rpc.test.mezo.org` | live calls |
| Explorer | `https://explorer.test.mezo.org` (API: `https://api.explorer.test.mezo.org/api/v2`) | API queries |
| Gas token | BTC, 18 decimals | `eth_getBalance` |
| Block gas limit | 10,000,000 (`0x989680`) | `eth_getBlockByNumber` |
| `eth_getLogs` range | about 10,000 blocks per call | known limit (from earlier Mezo work); the indexer pages in 9,000-block chunks |
| Wallets | any EVM wallet (MetaMask etc.) via `wallet_addEthereumChain` | standard EVM chain |
| Faucet | `faucet.test.mezo.org`, Turnstile-gated (a person has to use it) | manual |

## Assets

| Asset | Address | Decimals | Status |
|---|---|---|---|
| MUSD (Mezo USD) | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | 18 | **Listed in the official contracts reference as "Testnet MUSD".** Standard ERC-20. Enabled at launch. |
| mUSDC (Mezo Circle USDC) | `0xe1a26db653708A2AD8F824E92Db9852410e33A59` | 6 | Exists on testnet: verified `TransparentUpgradeableProxy` (impl `0xc47dCF3D…856A`), 145 holders, ~10.2M supply, has an MUSD/mUSDC stable pool. **Not listed in the official contracts reference.** Supported by the contracts (per-asset decimals) but **disabled by default** and shown as "not verified by Mezo" if enabled. |

The explorer lists more than 25 contracts named "Mezo USD / MUSD". Only `0x1189…c503` is the one in Mezo's contracts reference, so it is the only MUSD we accept. The chain config has one place for asset addresses (`web/lib/chain.ts` + deployment JSON).

How users get testnet MUSD: borrow it against BTC at `testnet.mezo.org` (minimum MUSD debt there is 1,800). There is no MUSD faucet.

## Collateral

**Chosen: native testnet BTC, sent as `msg.value` and held by `CollateralManager`.**

- BTC is Mezo's gas token, so a contract can hold it and send it back with a plain call. No approvals, nothing to bridge, no wrapper.
- Mezo also exposes BTC as an ERC-20 precompile at `0x7b7C000000000000000000000000000000000000` (listed as "BTC" in the reference; `balanceOf` equals the native balance). We do not use its `transferFrom` path: it can't be simulated in local tests, and native `msg.value` does the same job with less to go wrong.
- What the app calls it: "BTC (Mezo testnet)". It is the chain's native BTC, not tBTC or WBTC, and we say so.

## Oracle

**BTC/USD precompile `0x7b7c000000000000000000000000000000000015`.**

- Implements Chainlink `AggregatorV3Interface`: `decimals()` returns 18, `latestRoundData()` works.
- Read on 2026-11-07 with `cast call`: `answer = 75,838.77` USD/BTC, `updatedAt` a few seconds old, `answeredInRound = 0`. The UI shows the live value and when it was last updated.
- `answeredInRound` is always 0, so the usual `answeredInRound >= roundId` check can't be used. We check `answer > 0` and `block.timestamp - updatedAt <= maxStaleness` (default 1 hour, admin-tunable between 30 s and 1 day).
- Mezo's own `PriceFeed` (`0x86bCF0841622a5dAC14A313a15f96A95421b9366`, `fetchPrice()`, 60 s staleness) wraps the same source. We read the aggregator directly so the staleness rule is our own and visible.
- No manual or mock price is used on testnet. Local tests use a mock aggregator under `contracts/test/` only.

## Existing lending on Mezo

- MUSD is minted by Mezo's Liquity-style trove system (BorrowerOperations / TroveManager). A trove is opened by the borrower against their own BTC. MUSD is minted by the protocol; no outside lender supplies it.
- Those contracts have no way for a third party to fund someone else's trove, set a rate, or receive the repayment. Rates and fees are set by governance, not negotiated.
- **So LiquidityX does not integrate with troves.** It is a separate P2P system: lenders lend MUSD they already hold to borrowers who lock BTC in LiquidityX's own contracts. We never say lenders are funding Mezo troves.
- Other lending markets exist on testnet (ZeroLend, Blend, Morpho vault tokens show in the explorer), but they are pooled-rate markets and add nothing to a P2P fixed-rate design. We don't integrate them.

## Design decisions

| Decision | Choice |
|---|---|
| Lending model | One lender per loan. A request can be filled by several lenders, which creates several loans with pro-rata collateral. |
| Rates | Fixed APR per loan. In matches it is the lender's APR, which must be <= the borrower's max APR. |
| Liquidity | Lenders deposit into the vault first. Creating an offer reserves that deposit, so an open offer is always fully funded. |
| Collateral | Native BTC, locked when the request is created, moved to the loan when it is filled. |
| Settlement | Repayments go to the lender's vault balance straight away. Collateral returns to the borrower's free balance on full repayment and is withdrawn from there. |
| Liquidation | Uses the real oracle. The lender is paid in BTC from the collateral (debt value + 5% bonus, capped at the collateral) and the rest goes back to the borrower. There is no BTC/MUSD market sale. Triggered by the lender or a keeper. |
| Matching | The backend suggests matches (lowest APR, then earliest expiry, then lowest id). The contract re-checks every term. |
| Tooling | Foundry (Solidity 0.8.28, EVM london, OZ 5.4), Next.js 16 + wagmi 2 + viem, Postgres (PGlite locally) for the index. |

## Known limits

1. The BTC/USD feed is a testnet feed. Its value is not the market price, and on testnet liquidations follow it.
2. On liquidation the lender gets BTC, not MUSD. Selling it is up to them.
3. If the oracle is stale, no new loans can be opened and no liquidations can run. Repayment still works.
4. mUSDC is upgradeable and may be pausable or blacklistable by its issuer. That could block a repayment. It is off by default for this reason.
5. Stablecoins are valued at exactly $1.
6. The deployer key is a fresh testnet key (`0x192eDF96EA6D7dCA78429fF567e066a3Bda46349`) that needs testnet BTC before it can deploy.
