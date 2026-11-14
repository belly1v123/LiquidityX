#!/usr/bin/env bash
# services.sh start|stop  — local chain + the two app servers used by the recording.
#   start: fresh anvil + deploy + seed (setup-chain.sh), local app on :3100 (production build,
#          NEXT_PUBLIC_CHAIN=local, PGlite in the work dir), Passport app on :3200 (dev server,
#          no NEXT_PUBLIC_CHAIN, so it uses the Mezo testnet + Passport config).
#   SKIP_BUILD=1 reuses an existing local build.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${DEMO_WORK:-$ROOT/demo/out/work}"
mkdir -p "$WORK"

stop() {
  for port in 3100 3200 8545; do
    pids=$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
  done
  [ -f "$WORK/miner.pid" ] && kill "$(cat "$WORK/miner.pid")" 2>/dev/null || true
  sleep 1
  # Leave the repo as committed: the deploy rewrites startBlock in these files.
  git -C "$ROOT" checkout -- contracts/deployments web/lib/deployments 2>/dev/null || true
}

start() {
  stop
  DEMO_WORK="$WORK" bash "$HERE/setup-chain.sh"
  cd "$ROOT/web"
  if [ -z "${SKIP_BUILD:-}" ]; then
    env -u DATABASE_URL NEXT_PUBLIC_CHAIN=local pnpm build >"$WORK/build.log" 2>&1
  fi
  git -C "$ROOT" checkout -- contracts/deployments web/lib/deployments
  rm -rf "$WORK/pglite" "$WORK/pglite-passport"
  mkdir -p "$WORK/pglite" "$WORK/pglite-passport"
  env -u DATABASE_URL NEXT_PUBLIC_CHAIN=local PGLITE_DIR="$WORK/pglite" nohup pnpm start -p 3100 >"$WORK/app.log" 2>&1 &
  env -u DATABASE_URL -u NEXT_PUBLIC_CHAIN PGLITE_DIR="$WORK/pglite-passport" nohup pnpm exec next dev -p 3200 >"$WORK/app-passport.log" 2>&1 &
  for _ in $(seq 1 60); do curl -sf localhost:3100/api/health >/dev/null && break; sleep 1; done
  echo "services up: anvil :8545, app :3100, passport app :3200"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 1 ;;
esac
