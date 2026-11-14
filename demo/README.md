# Demo video

A narrated walkthrough of LiquidityX, under two minutes long. It is recorded against a local anvil chain with real transactions from two wallets, then closes on the live Mezo testnet site.

- Video: `demo/out/liquidityx-demo.mp4` (1920x1080, 30 fps, H.264 + AAC, subtitles burned in)
- Subtitles: `demo/out/liquidityx-demo.srt`
- Narration by scene, with timings: [`script.md`](script.md)

`demo/out/` is gitignored, so render the video locally.

## Render it

```bash
bash demo/record/run-all.sh
```

This needs Foundry (anvil, forge, cast), Node with pnpm (run `pnpm install` in `web/` first), Python 3 and network access (the edge-tts voice, Google Fonts, and the live site). Ports 8545, 3100 and 3200 must be free. A full run takes about 10 minutes, most of it the web build and the recording itself. When it finishes, the script stops every process it started and restores `contracts/deployments` and `web/lib/deployments` to their committed versions.

Steps:

1. `tts.py` writes one MP3 per scene plus word timings, from `narration.json`, using Microsoft's Andrew neural voice (`en-US-AndrewNeural`) through edge-tts. The audio is cached in `demo/out/work/audio`. Set `FORCE_TTS=1` to generate it again.
2. `services.sh start` starts a fresh anvil and deploys the contracts. On chain 31337 the deploy script adds a mock MUSD and a BTC/USD feed fixed at $100,000. Then `pnpm abi` runs, and `setup-chain.sh` has a second lender (anvil account 3) post two offers: 400 MUSD at 5% and 300 MUSD at 9%. Next it builds the web app with `NEXT_PUBLIC_CHAIN=local` and serves it on :3100, with PGlite stored in the work directory. A second dev server on :3200 runs without `NEXT_PUBLIC_CHAIN`, so it uses the Mezo testnet and Mezo Passport configuration. That server is only used to show the Passport connect modal.
3. `record.mjs` drives headless Chromium with Playwright and captures each scene through the CDP screencast. The lender is anvil account 1 and the borrower is anvil account 2, each in its own browser context. `wallet-shim.js` is a small EIP-1193 provider injected only into these recording contexts. It forwards calls to anvil, which signs for its unlocked accounts, so every transaction on screen is real. The app itself is not modified. `overlay.js` draws a cursor and a corner tag naming the wallet. `cards.html` holds the title and role cards.
4. `assemble.py` builds the video and audio timeline, the subtitles (.srt, plus .ass for burning in with libass) and `script.md`, then encodes the MP4 with the static ffmpeg from imageio-ffmpeg.

## How narration and picture stay in sync

Each scene has its own narration clip, and edge-tts reports when each word starts. The recorder waits for those word times before each on-screen action, such as typing a value or hovering a figure. Sometimes a transaction runs past the point where the next sentence should start. When that happens, that sentence and the rest of the scene's narration move later by the overrun. The clip is cut at sentence boundaries, so speech is never stretched or cut mid-word. `assemble.py` places each piece where the recorder scheduled it, and the subtitle timings follow the same placement.

## Notes

- anvil runs in automine mode, and a loop mines an empty block every second. Each transaction is mined as soon as it is sent, so the app's receipt poll finds it on the first check. The indexer stays two blocks behind head, and the steady blocks keep it in step with the newest events, as `--block-time 1` would.
- A local chain has no explorer, so the local activity log can show hashes but not links. The video shows the activity log from the live testnet site instead, where every entry links to the Mezo explorer.
