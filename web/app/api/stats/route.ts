import { handle, json } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { stats } from "@/lib/server/services";

export async function GET() {
  return handle(async () => {
    await maybeSync();
    return json(await stats());
  });
}
