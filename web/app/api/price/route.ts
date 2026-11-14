import { handle, json } from "@/lib/server/http";
import { price } from "@/lib/server/services";

export async function GET() {
  return handle(async () => json(await price()));
}
