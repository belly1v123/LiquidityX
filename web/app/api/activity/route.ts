import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { listActivity } from "@/lib/server/queries";
import { activityQuery } from "@/lib/server/schemas";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, activityQuery);
    await maybeSync();
    return json(await listActivity(q));
  });
}
