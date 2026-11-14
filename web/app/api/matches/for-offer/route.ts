import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { forOfferQuery } from "@/lib/server/schemas";
import { requestsForOffer } from "@/lib/server/services";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, forOfferQuery);
    await maybeSync();
    return json(await requestsForOffer(q.offerId));
  });
}
