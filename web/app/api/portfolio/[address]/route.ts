import { badRequest, handle, json } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { addressParam } from "@/lib/server/schemas";
import { portfolio } from "@/lib/server/services";

export async function GET(_req: Request, ctx: { params: Promise<{ address: string }> }) {
  return handle(async () => {
    const parsed = addressParam.safeParse((await ctx.params).address);
    if (!parsed.success) throw badRequest("address: invalid address");
    await maybeSync();
    return json(await portfolio(parsed.data));
  });
}
