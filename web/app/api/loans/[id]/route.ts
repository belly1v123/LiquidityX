import { badRequest, handle, json } from "@/lib/server/http";
import { maybeSync } from "@/lib/server/indexer";
import { loanActivity } from "@/lib/server/queries";
import { idParam } from "@/lib/server/schemas";
import { loanById } from "@/lib/server/services";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const parsed = idParam.safeParse((await ctx.params).id);
    if (!parsed.success) throw badRequest("id: expected a positive integer id");
    await maybeSync();
    const loan = await loanById(parsed.data);
    return json({ loan, activity: await loanActivity(parsed.data) });
  });
}
