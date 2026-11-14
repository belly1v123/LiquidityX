#!/usr/bin/env bash
# One command: narration -> local chain + apps -> recording -> final video.
#   bash demo/record/run-all.sh
# Output: demo/out/liquidityx-demo.mp4 and demo/out/liquidityx-demo.srt (work files in demo/out/work).
# Needs: foundry (anvil, forge, cast), node + pnpm (web deps installed), python3, network access
# (edge-tts voice, Google Fonts, the live site https://liquidityx-taupe.vercel.app).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/demo/out"
WORK="$OUT/work"
export DEMO_WORK="$WORK"
mkdir -p "$WORK"

# Tools: Playwright (node) and a venv with edge-tts + imageio-ffmpeg (static ffmpeg with libass).
cd "$HERE"
[ -d node_modules/playwright ] || npm install --no-audit --no-fund
npx playwright install chromium >/dev/null
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt

# 1. Narration (one MP3 + word timings per scene). FORCE_TTS=1 regenerates.
if [ -n "${FORCE_TTS:-}" ] || [ ! -f "$WORK/audio/outro.json" ]; then
  .venv/bin/python tts.py "$WORK"
fi

# 2. Fresh chain, deploy, seed, build and start both app servers.
trap 'bash "$HERE/services.sh" stop' EXIT
bash "$HERE/services.sh" start

# 3. Record every scene with real local transactions.
node "$HERE/record.mjs" "$WORK"

# 4. Assemble video, narration and subtitles.
.venv/bin/python "$HERE/assemble.py" "$WORK" "$OUT"
