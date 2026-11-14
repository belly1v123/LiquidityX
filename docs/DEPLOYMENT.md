# Deployment

**Status (2026-11-12): live on Mezo testnet** (v2, redeployed after the audit fixes). All seven contracts are source-verified on the explorer. Frontend: https://liquidityx-taupe.vercel.app

## Network

| | |
|---|---|
| Chain | Mezo testnet, id 31611 |
| RPC | https://rpc.test.mezo.org |
| Explorer | https://explorer.test.mezo.org |
| MUSD | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (enabled) |
| mUSDC | `0xe1a26db653708A2AD8F824E92Db9852410e33A59` (configured, disabled) |
| BTC/USD feed | `0x7b7c000000000000000000000000000000000015`, max staleness 3600 s |

## 1. Deploy contracts

Fund the deployer with ~0.01 testnet BTC (faucet.test.mezo.org), or put a funded key in `contracts/.env` as `DEPLOYER_PRIVATE_KEY`.

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --skip-simulation --legacy
```

`--skip-simulation` is required: the oracle is a native precompile that forge's local EVM can't execute (`script/MezoFeedSim.sol` feeds the live answer into the first pass only). If `--legacy` is rejected, drop it. Output: `contracts/deployments/31611.json` (addresses, start block). Tx hashes are in `contracts/broadcast/Deploy.s.sol/31611/run-latest.json`.

## 2. Wire the frontend

```bash
cd web
pnpm abi            # regenerates lib/abi and copies deployments/*.json into lib/deployments
pnpm build
```

The app detects the 31611 deployment automatically. Until it exists every page shows "Contracts not deployed yet".

## 3. Host (Vercel)

Root directory `web`. Environment variables:

| Var | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | recommended | Postgres for the index (Neon/Supabase). Without it each instance uses PGlite in `/tmp` and re-indexes on cold start |
| `INDEXER_SECRET`, `CRON_SECRET` | yes | protect `/api/indexer/sync` |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional | enables WalletConnect + MetaMask SDK connectors |
| `NEXT_PUBLIC_MEZO_RPC_URL` | optional | RPC override |

## 4. Two-wallet demo on testnet

Lender wallet needs MUSD (borrow ≥ 1,800 at testnet.mezo.org) and gas; borrower needs BTC and ~1 MUSD for interest.

```bash
cd contracts
LENDER_PRIVATE_KEY=.. BORROWER_PRIVATE_KEY=.. \
  forge script script/Demo.s.sol --rpc-url mezo_testnet --broadcast --skip-simulation --slow --legacy --gas-estimate-multiplier 200
```

Record the hashes from `broadcast/Demo.s.sol/31611/run-latest.json` here once run.

## Deployed addresses (v2, start block 16732827)

Deployer: `0x13F4c476d246599D29c50c120379A6dEBD4D439b`

| Contract | Address | Source |
|---|---|---|
| LoanMarketplace | [`0xB142a575D1fb866faD96fBbE94804aa728285999`](https://explorer.test.mezo.org/address/0xB142a575D1fb866faD96fBbE94804aa728285999) | verified |
| LoanManager | [`0x5fbf227AD58b9f746faF5eAc8939Eaa16A46F066`](https://explorer.test.mezo.org/address/0x5fbf227AD58b9f746faF5eAc8939Eaa16A46F066) | verified |
| LiquidityXVault | [`0xF2cB14881C5df36BdcA8e5b97792C1626dD8E4D5`](https://explorer.test.mezo.org/address/0xF2cB14881C5df36BdcA8e5b97792C1626dD8E4D5) | verified |
| CollateralManager | [`0xc7DD5A0a6BEfc3a1Bd6FfDd71D067E6689032AC4`](https://explorer.test.mezo.org/address/0xc7DD5A0a6BEfc3a1Bd6FfDd71D067E6689032AC4) | verified |
| LiquidationEngine | [`0x19ba45BC2D4013Cb098bd064A36B5ADbBe136665`](https://explorer.test.mezo.org/address/0x19ba45BC2D4013Cb098bd064A36B5ADbBe136665) | verified |
| PriceOracleAdapter | [`0x2f73373a28130f03B4764eCa86666D4174B1139b`](https://explorer.test.mezo.org/address/0x2f73373a28130f03B4764eCa86666D4174B1139b) | verified |
| ProtocolConfig | [`0x10dAAB164EBd33b78A28b4Ef62F23Fdb77Abce79`](https://explorer.test.mezo.org/address/0x10dAAB164EBd33b78A28b4Ef62F23Fdb77Abce79) | verified |
| MUSD (Mezo) | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) | Mezo official |
| BTC/USD feed (Mezo precompile) | `0x7b7c000000000000000000000000000000000015` | Mezo |

v1 (2026-11-12, before audit fixes, retired): marketplace `0xd8CC104e961C5793373418367DAc1ED55C6cc84e`. Its demo loan #1 was repaid in full.

### Deploy transactions

| # | Call | Tx |
|---|---|---|
| 1 | PriceOracleAdapter | [`0xf440dc35…`](https://explorer.test.mezo.org/tx/0xf440dc35235a4a0d0b211cebdb1d517bcb00ffae69a4bcda81f80aa7c769c1b7) |
| 2 | ProtocolConfig | [`0xfceef808…`](https://explorer.test.mezo.org/tx/0xfceef8085ff9bfa3b3bd44e73da7e841e64f41889710ec0ac2009a15118f9fa0) |
| 3 | LiquidityXVault | [`0x25ce6222…`](https://explorer.test.mezo.org/tx/0x25ce622298d8c88bf91ac19e4de8e16bb57fd55178282cdb1f51f2c55865ff36) |
| 4 | CollateralManager | [`0xab7a8a7a…`](https://explorer.test.mezo.org/tx/0xab7a8a7a271b03db9fbefd13cbe7520f37568a2805d007578d137cd805b7582d) |
| 5 | LoanManager | [`0xe4a4308a…`](https://explorer.test.mezo.org/tx/0xe4a4308aff068ecdd6c6ce6c676bcfea861e792cdba1da7a73073639f7fc84ee) |
| 6 | LoanMarketplace | [`0x9c43fb0f…`](https://explorer.test.mezo.org/tx/0x9c43fb0f70cabcd80dd1196b8f0020d7362c88e3be34890c321791c2f4bf8368) |
| 7 | LiquidationEngine | [`0x86a8a25d…`](https://explorer.test.mezo.org/tx/0x86a8a25d557fb45b1700215aff4d835b58989d8f4017c484de2be712eb4fc55d) |
| 8 | grantRole | [`0x5185f47f…`](https://explorer.test.mezo.org/tx/0x5185f47f9ca8870ce3ea022323a109eecbf3152d1fc522b4c64a88e5d820429f) |
| 9 | grantRole | [`0x35ff1a6b…`](https://explorer.test.mezo.org/tx/0x35ff1a6be12333bbfc61371d3a5a8996987e28d22b85eeea2cc462f71c9bb1f0) |
| 10 | grantRole | [`0xea9d0d5a…`](https://explorer.test.mezo.org/tx/0xea9d0d5abb6538db107f4df90fa7e3e2b5d61000089a4a08cc54bbe552ea885e) |
| 11 | grantRole | [`0x5a6e16e3…`](https://explorer.test.mezo.org/tx/0x5a6e16e3eab80e93cdd6af4bcb193439c5abcaadc494075e969ebf8954e0b8e4) |
| 12 | grantRole | [`0x309e2dea…`](https://explorer.test.mezo.org/tx/0x309e2dea6a6cd0ec5c6b27405a0989a7a035e42ef3b8ec09362cd1b1debd6c58) |
| 13 | grantRole | [`0x6195b6ae…`](https://explorer.test.mezo.org/tx/0x6195b6aeeef70be7b9363430963521e0680fc53f13a6ba3c51a4a5fb49a4db34) |
| 14 | configureAsset | [`0x527d19f2…`](https://explorer.test.mezo.org/tx/0x527d19f2b8846edf8e23d5b23bd23dd81157c258956aa4e5292061a3a19092e2) |
| 15 | configureAsset | [`0x2001dcc4…`](https://explorer.test.mezo.org/tx/0x2001dcc4e996e33d49b1de8a413319411eb8f223e14b4b1b370822c2b21a1523) |

### Two-wallet demo on testnet (v2): loan #1 opened and repaid

| # | Step | Tx |
|---|---|---|
| 1 | approve | [`0x4403129e…`](https://explorer.test.mezo.org/tx/0x4403129e67389d3995629d870f42fc1656532043cf349c71c0aea090911b9e2e) |
| 2 | deposit | [`0x81d0fcce…`](https://explorer.test.mezo.org/tx/0x81d0fcce8ecd260b39e88cd93992e4bde0345c130e37e16f84a05d4934faff92) |
| 3 | createOffer | [`0x340ffc45…`](https://explorer.test.mezo.org/tx/0x340ffc454040ab72847a27f76224a35e9d9ac3f9e72fe2e709983079826f06dd) |
| 4 | createRequest | [`0x884ec883…`](https://explorer.test.mezo.org/tx/0x884ec883c360187362893524a29315e22d94ac2f53b4553d9fd0d153505e9dde) |
| 5 | matchOfferAndRequest | [`0xbb9e2604…`](https://explorer.test.mezo.org/tx/0xbb9e2604324955ea3effb0b79b514e30bf560e369e2f357f4364802e8aa5d573) |
| 6 | approve | [`0xcebf0938…`](https://explorer.test.mezo.org/tx/0xcebf093833bc0ebd6abcc4ec7bd3185ebebf3a6175a697864cb21b667219f65c) |
| 7 | repay | [`0x9e4b30e0…`](https://explorer.test.mezo.org/tx/0x9e4b30e0b17e937d91b765308d3bb4c89930bd9e304db020d98f067b6af9d7b6) |
| 8 | withdrawCollateral | [`0x74b01e16…`](https://explorer.test.mezo.org/tx/0x74b01e16128103e293ee0cd322389b04e4c339d159257fbc60e663a67145af62) |
| 9 | withdraw | [`0xd5febbb0…`](https://explorer.test.mezo.org/tx/0xd5febbb0b4fd46e9ff6ed2633dca3e99789947237116e9fb8fee55e3dae36215) |

Steps: lender approves and deposits 20 MUSD → creates an offer → borrower creates a request with BTC at about 200% CR → match → borrower approves and repays in full → borrower withdraws BTC collateral → lender withdraws principal and interest.
