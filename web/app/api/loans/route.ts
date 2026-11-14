import { handle, json, parseQuery } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { listLoans } from "@/lib/server/queries";
import { loansQuery } from "@/lib/server/schemas";

export async function GET(req: Request) {
  return handle(async () => {
    const q = parseQuery(req.url, loansQuery);
    await maybeSync();
    return json(await listLoans(q));
  });
}
