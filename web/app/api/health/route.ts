import { handle, json } from "@/lib/server/http";
import { health } from "@/lib/server/services";

export async function GET() {
  return handle(async () => json(await health()));
}
