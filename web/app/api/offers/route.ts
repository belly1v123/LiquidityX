import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { listOffers } from "@/lib/server/queries";
import { offersQuery } from "@/lib/server/schemas";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, offersQuery);
    await maybeSync();
    return json(await listOffers(q));
  });
}
