#!/usr/bin/env bash
# Fresh local chain for the recording: anvil, deploy, export ABIs, then a second lender
# (anvil account 3) posts two offers with real transactions: 400 MUSD @ 5% and 300 MUSD @ 9%.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${DEMO_WORK:-$ROOT/demo/out/work}"
mkdir -p "$WORK"
R=http://127.0.0.1:8545

# anvil in automine mode (each transaction is mined as soon as it is sent, so the app's receipt
# poll finds it on its first check) plus an empty block every second, so the indexer, which stays
# 2 blocks behind head, keeps seeing the newest events. Same effect as --block-time 1 for the
# indexer, without each transaction waiting for the next block plus the app's 4 s receipt poll.
if ! cast block-number --rpc-url $R >/dev/null 2>&1; then
  nohup anvil --port 8545 >"$WORK/anvil.log" 2>&1 &
  echo $! >"$WORK/anvil.pid"
  for _ in $(seq 1 30); do cast block-number --rpc-url $R >/dev/null 2>&1 && break; sleep 0.5; done
  nohup bash -c "while cast rpc evm_mine --rpc-url $R >/dev/null 2>&1; do sleep 1; done" >/dev/null 2>&1 &
  echo $! >"$WORK/miner.pid"
fi

cd "$ROOT/contracts"
forge build >/dev/null
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/Deploy.s.sol --rpc-url $R --broadcast >"$WORK/deploy.log" 2>&1
cd "$ROOT/web" && pnpm abi >/dev/null

D="$ROOT/contracts/deployments/31337.json"
MUSD=$(python3 -c "import json;print(json.load(open('$D'))['assets']['MUSD'])")
V=$(python3 -c "import json;print(json.load(open('$D'))['contracts']['vault'])")
M=$(python3 -c "import json;print(json.load(open('$D'))['contracts']['marketplace'])")
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6 # anvil default account 3
T=$(cast block latest -f timestamp --rpc-url $R)
EXP=$((T + 7 * 86400))
cast send $MUSD "approve(address,uint256)" $V 700000000000000000000 --private-key $K3 --rpc-url $R -q
cast send $V "deposit(address,uint256)" $MUSD 700000000000000000000 --private-key $K3 --rpc-url $R -q
cast send $M "createOffer(address,uint256,uint16,uint32,uint16,uint64)" $MUSD 400000000000000000000 500 2592000 0 $EXP --private-key $K3 --rpc-url $R -q
cast send $M "createOffer(address,uint256,uint16,uint32,uint16,uint64)" $MUSD 300000000000000000000 900 2592000 0 $EXP --private-key $K3 --rpc-url $R -q
echo "chain ready: offers #1 (400 @ 5%) and #2 (300 @ 9%) posted by 0x90F7…b906"
