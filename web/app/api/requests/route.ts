import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { listRequests } from "@/lib/server/queries";
import { requestsQuery } from "@/lib/server/schemas";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, requestsQuery);
    await maybeSync();
    return json(await listRequests(q));
  });
}
