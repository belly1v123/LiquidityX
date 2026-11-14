// Records every scene of the LiquidityX demo against the local app (real anvil transactions),
// the Passport connect modal (second server without NEXT_PUBLIC_CHAIN) and the live testnet site.
// Usage: node record.mjs <workDir>   (env APP, PASSPORT_APP, LIVE_APP override the URLs;
// TAIL_ONLY=1 re-records only the scenes that don't depend on local chain state)
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, SceneRecorder, click, hover, launch, loadAudio, newContext, park, sleep, type, waitToast } from "./lib.mjs";

const WORK = path.resolve(process.argv[2] ?? path.join(HERE, "../out/work"));
const APP = process.env.APP ?? "http://localhost:3100";
const PASSPORT_APP = process.env.PASSPORT_APP ?? "http://localhost:3200";
const LIVE_APP = process.env.LIVE_APP ?? "https://liquidityx-taupe.vercel.app";
const RPC = "http://127.0.0.1:8545";
const CARDS = pathToFileURL(path.join(HERE, "cards.html")).href;
const ROLE_CARD_SECONDS = 1.4;
const tailOnly = process.env.TAIL_ONLY === "1";

const LENDER = { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", rpcUrl: RPC, chainId: 31337, name: "Local test wallet" };
const BORROWER = { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", rpcUrl: RPC, chainId: 31337, name: "Local test wallet" };

const rec = new SceneRecorder(WORK);
const A = (id) => loadAudio(WORK, id);
const fast = { ms: 420, pause: 120 };

async function api(p) {
  const r = await fetch(APP + p);
  return r.json();
}
async function until(fn, label, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("timed out: " + label);
}
async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator(".skeleton").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  await sleep(500);
}

const browser = await launch();
const cards = await newContext(browser, {});
const lender = await newContext(browser, { wallet: LENDER, role: { label: "Lender", short: "0x7099…79C8" } });
const borrower = await newContext(browser, { wallet: BORROWER, role: { label: "Borrower", short: "0x3C44…93BC" } });
const passport = await newContext(browser, {});
const live = await newContext(browser, {});
await passport.ctx.addInitScript(() => {
  // Hide the Next.js dev-tools badge on the dev server.
  const add = () => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.head.appendChild(s);
  };
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
});

async function roleCard(name) {
  const p = cards.page;
  await p.goto(`${CARDS}#role-${name}`);
  await park(p, -50, -50);
  await sleep(400);
  const sc = await rec.start(`card-${name}`, p, null);
  await sc.at(ROLE_CARD_SECONDS);
  await rec.stop(sc, { tail: 0 });
}

// Warm up: first indexer sync, and the slower external pages in the background.
if (!tailOnly) {
  await api("/api/health");
  await until(async () => (await api("/api/offers")).items?.length >= 2, "seeded offers indexed");
}
const ppWarm = passport.page.goto(`${PASSPORT_APP}/marketplace`, { timeout: 300_000 }).catch(() => {});
const liveAct = await live.ctx.newPage();
const liveWarm = Promise.all([
  live.page.goto(`${LIVE_APP}/marketplace`, { timeout: 120_000 }).catch(() => {}),
  liveAct.goto(`${LIVE_APP}/activity`, { timeout: 120_000 }).catch(() => {}),
]);

// ---------------------------------------------------------------------------------------------
// Intro: what it is + the problem
{
  const p = cards.page;
  await p.goto(`${CARDS}#intro`);
  await p.waitForLoadState("networkidle");
  await p.evaluate(() => document.fonts.ready);
  await park(p, -50, -50);
  await sleep(500);
  const sc = await rec.start("intro", p, A("intro"));
  await sc.atWord("Today", 1, 0.1);
  await p.evaluate(() => window.step(1));
  await sc.atWord("Borrowers", 1, 0.1);
  await p.evaluate(() => window.step(2));
  await sc.atWord("pooled", 1, 0.1);
  await p.evaluate(() => window.step(3));
  await rec.stop(sc, { tail: 0.5 });
}

if (!tailOnly) {
  // Lender: deposit, then a funded offer
  await lender.page.goto(`${APP}/lend`);
  await settle(lender.page);
  await roleCard("lender");
  {
    const p = lender.page;
    await park(p, 420, 420);
    const sc = await rec.start("lender", p, A("lender"));
    await type(p, p.getByLabel("Amount to deposit"), "600", { delay: 50 });
    await click(p, p.getByRole("button", { name: "Deposit", exact: true }).last(), fast);
    await waitToast(p, /Deposited/);
    await type(p, p.getByLabel("Amount", { exact: true }), "500", { delay: 50 });
    await hover(p, p.getByLabel("APR"), 300);
    await click(p, p.getByRole("button", { name: "Review offer" }), fast);
    await sleep(500);
    await click(p, p.getByRole("button", { name: "Post offer" }), fast);
    await waitToast(p, /Offer posted/);
    await sc.atWord("The", 1, 0.1);
    await hover(p, p.getByText("Reserved in offers"), 500);
    await rec.stop(sc, { tail: 0.3 });
  }

  // Borrower: request backed by native BTC
  await borrower.page.goto(`${APP}/borrow`);
  await settle(borrower.page);
  await roleCard("borrower");
  {
    const p = borrower.page;
    await park(p, 900, 260);
    const sc = await rec.start("borrower", p, A("borrower"));
    await sc.atWord("asks", 1, 0.2);
    await type(p, p.getByLabel("Borrow", { exact: true }), "1000", { delay: 55 });
    await sc.atWord("8", 1, 0.3);
    await hover(p, p.getByLabel("Most APR you'll pay"), 350);
    await sc.atWord("locks", 1, 0.2);
    await type(p, p.getByLabel("BTC to lock"), "0.02", { delay: 55 });
    await sc.atWord("ratio", 1, 0.3);
    await hover(p, p.getByText("Collateral ratio", { exact: true }).first(), 400);
    await sc.atWord("liquidation", 1, 0.3);
    await hover(p, p.getByText("Liquidated if BTC falls below"), 400);
    await sleep(500);
    await click(p, p.getByRole("button", { name: "Review request" }), fast);
    await sleep(400);
    await click(p, p.getByRole("button", { name: "Post request" }), fast);
    await waitToast(p, /Request posted/);
    await rec.stop(sc, { tail: 0.3 });
  }

  // Matching engine (still the borrower)
  await until(async () => (await api("/api/requests")).items?.some((r) => r.id === "1"), "request #1 indexed");
  await until(async () => (await api("/api/offers")).items?.some((o) => o.id === "3"), "offer #3 indexed");
  {
    const p = borrower.page;
    await p.goto(`${APP}/marketplace?tab=requests`);
    await settle(p);
    await park(p, 900, 420);
    const row = p.getByRole("row").filter({ hasText: "#1" });
    const sc = await rec.start("match", p, A("match"));
    await click(p, row.getByRole("button", { name: "Match" }), fast);
    const sheet = p.getByRole("dialog");
    await sheet.getByText(/fill/).first().waitFor();
    await sc.atWord("400", 1, 0.3);
    await hover(p, sheet.locator("li").filter({ hasText: "Offer #1" }), 450);
    await sc.atWord("500", 1, 0.3);
    await hover(p, sheet.locator("li").filter({ hasText: "Offer #3" }), 450);
    await sc.atWord("That", 1, 0.2);
    await hover(p, sheet.getByText(/fill .*of/).first(), 450);
    await sc.atWord("The", 2, 0.2);
    await hover(p, sheet.getByText("Offer #2:"), 450);
    // Run the first fill while the last sentences play, so the transactions don't leave a gap.
    await sc.atWord("limit", 1, 0.1);
    await click(p, sheet.locator("li").filter({ hasText: "Offer #1" }).getByRole("button", { name: "Run fill" }), fast);
    await waitToast(p, /Loan opened from offer #1/);
    await sc.atWord("Each", 1, 0.2);
    // Give the panel a moment to refresh (offer #1 is used up) before aiming at offer #3.
    await sheet.locator("li").filter({ hasText: "Offer #1" }).waitFor({ state: "detached", timeout: 3_500 }).catch(() => {});
    await sleep(200);
    await click(p, sheet.locator("li").filter({ hasText: "Offer #3" }).getByRole("button", { name: "Run fill" }), fast);
    await waitToast(p, /Loan opened from offer #3/);
    await sleep(400);
    await rec.stop(sc, { tail: 0.2 });
  }

  // Lender funds the remainder at their own APR
  await until(async () => (await api("/api/requests")).items?.some((r) => r.id === "1" && r.filled === "900000000000000000000"), "request #1 part-filled indexed");
  await lender.page.goto(`${APP}/marketplace?tab=requests`);
  await settle(lender.page);
  await roleCard("lender2");
  {
    const p = lender.page;
    await park(p, 900, 420);
    const sc = await rec.start("fund", p, A("fund"));
    await click(p, p.getByRole("row").filter({ hasText: "#1" }).getByRole("button", { name: "Fund" }), fast);
    const sheet = p.getByRole("dialog");
    await sc.atWord("7", 1, 0.6);
    await type(p, sheet.getByLabel(/Your APR/), "7", { delay: 40 });
    await sleep(250);
    await click(p, sheet.getByRole("button", { name: "Fund request" }), fast);
    await waitToast(p, /Loan opened\. 100/);
    await rec.stop(sc, { tail: 0.4 });
  }

  // Loan page (borrower)
  await borrower.page.goto(`${APP}/loans/2`);
  await settle(borrower.page);
  await roleCard("borrower2");
  {
    const p = borrower.page;
    await park(p, 700, 300);
    const sc = await rec.start("loan", p, A("loan"));
    await sc.atWord("fixed", 1, 0.3);
    await hover(p, p.getByText("APR (fixed)"), 450);
    await sc.atWord("interest", 1, 0.3);
    await hover(p, p.getByText("Owed now (estimate)"), 450);
    await sc.atWord("Below", 1, 0.2);
    await hover(p, p.getByText("Collateral ratio", { exact: true }).first(), 450);
    await sc.atWord("liquidate", 1, 0.4);
    await hover(p, p.getByText("Liquidation price", { exact: true }), 450);
    await sc.atWord("On", 1, 0.2);
    await hover(p, p.getByText(/Mezo testnet oracle/).first(), 450);
    await rec.stop(sc, { tail: 0.2 });
  }

  // Repay in full, withdraw BTC
  {
    const p = borrower.page;
    const sc = await rec.start("repay", p, A("repay"));
    await click(p, p.getByRole("button", { name: "Repay in full" }), fast);
    await waitToast(p, /Loan repaid/);
    const w = p.getByRole("button", { name: /^Withdraw .* BTC$/ });
    await w.waitFor({ timeout: 20_000 });
    await click(p, w, fast);
    await waitToast(p, /BTC sent to your wallet/);
    await sleep(500);
    await rec.stop(sc, { tail: 0.2 });
  }
} // end of local-chain scenes

// Mezo Passport connect modal (server without NEXT_PUBLIC_CHAIN = Mezo testnet config)
await ppWarm;
{
  const p = passport.page;
  await settle(p);
  await park(p, 1100, 200);
  const sc = await rec.start("passport", p, A("passport"));
  await sc.atWord("Passport", 1, 0.5);
  await click(p, p.getByRole("button", { name: "Connect wallet" }).first(), fast);
  await sc.atWord("Bitcoin", 1, 0.1);
  await hover(p, p.getByText("Unisat", { exact: true }), 350);
  await sleep(250);
  await hover(p, p.getByText("Xverse", { exact: true }), 450);
  await sc.atWord("Ethereum", 1, 0.2);
  await hover(p, p.getByText("Ethereum wallets", { exact: true }), 400);
  await rec.stop(sc, { tail: 0.3 });
}

// Live on Mezo testnet (the deployed site): contract footer, then the activity log
await liveWarm;
{
  const p = live.page;
  await settle(p);
  // Room under the footer so the subtitles don't sit on the contract list.
  await p.addStyleTag({ content: "footer{padding-bottom:170px}" });
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(600);
  await park(p, 700, 420);
  await liveAct.getByRole("row").nth(1).getByRole("link").first().waitFor({ timeout: 90_000 }).catch(() => {});
  const sc = await rec.start("live", p, A("live"));
  await sc.atWord("seven", 1, 0.4);
  await hover(p, p.getByText("Contracts on chain 31611"), 400);
  await hover(p, p.locator("footer li").first(), 500);
  await sc.atWord("every", 1, 0.3);
  const footerPart = sc.elapsed();
  await rec.stop(sc, { tail: -100 }); // the rest of this narration plays over the activity page
  const sc2 = await rec.start("live-b", liveAct, null);
  await park(liveAct, 1000, 420);
  await hover(liveAct, liveAct.getByRole("row").nth(1).getByRole("link").last(), 500);
  await sc2.at(Math.max(1.5, A("live").duration + 0.4 - footerPart));
  await rec.stop(sc2, { tail: 0 });
}

// Outro
{
  const p = cards.page;
  await p.goto(`${CARDS}#outro`);
  await p.waitForLoadState("networkidle");
  await park(p, -50, -50);
  await sleep(400);
  const sc = await rec.start("outro", p, A("outro"));
  await sc.atWord("rate", 1, 0.1);
  await p.evaluate(() => window.step(1));
  await sc.atWord("liquidation", 1, 0.1);
  await p.evaluate(() => window.step(2));
  await sc.atWord("gasless", 1, 0.1);
  await p.evaluate(() => window.step(3));
  await rec.stop(sc, { tail: 1.6 });
}

await browser.close();
fs.writeFileSync(path.join(WORK, "scenes", "manifest.json"), JSON.stringify(rec.manifest, null, 1));
console.log("done");
