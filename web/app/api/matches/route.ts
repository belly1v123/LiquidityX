import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { matchesQuery } from "@/lib/server/schemas";
import { matchesForRequest } from "@/lib/server/services";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, matchesQuery);
    await maybeSync();
    return json(await matchesForRequest(q.requestId));
  });
}
