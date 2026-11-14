import { handle, json } from "@/lib/server/http";
import { config } from "@/lib/server/services";

export async function GET() {
  return handle(async () => json(await config()));
}
