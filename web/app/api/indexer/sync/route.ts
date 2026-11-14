import { timingSafeEqual } from "node:crypto";
import { errorJson, handle, json } from "@/lib/server/http";
import { syncIndexer } from "@/lib/server/indexer";

// Long catch-up runs: the sync itself stops starting new 9k-block chunks after ~50s.
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // INDEXER_SECRET for manual/external calls; CRON_SECRET is what Vercel Cron sends.
  const secrets = [process.env.INDEXER_SECRET, process.env.CRON_SECRET].filter((s): s is string => Boolean(s));
  if (!token || secrets.length === 0) return false;
  return secrets.some((s) => s.length === token.length && timingSafeEqual(Buffer.from(s), Buffer.from(token)));
}

async function run(req: Request) {
  return handle(async () => {
    if (!authorized(req)) return errorJson(401, "unauthorized", "missing or invalid bearer token");
    const r = await syncIndexer({ budgetMs: 50_000 });
    return json({ fromBlock: r.fromBlock, toBlock: r.toBlock, events: r.events, headBlock: r.headBlock, reorg: r.reorg, done: r.done, deployed: !r.skipped });
  });
}

export async function POST(req: Request) {
  return run(req);
}

/** Vercel Cron invokes routes with GET (+ `authorization: Bearer $CRON_SECRET`). */
export async function GET(req: Request) {
  return run(req);
}
