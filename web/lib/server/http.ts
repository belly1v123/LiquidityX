import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const notFound = (message: string) => new HttpError(404, "not_found", message);

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body, replacer), { ...init, headers });
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

/**
 * Wraps a route handler: opts out of prerendering (cacheComponents) via connection(), maps HttpError/ZodError to the
 * api-types error shape, rethrows Next.js control-flow errors, and turns anything else into a 500 with a short message.
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  await connection();
  try {
    return await fn();
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof HttpError) return errorJson(e.status, e.code, e.message);
    if (e instanceof z.ZodError) return errorJson(400, "bad_request", formatZod(e));
    console.error("[api] unhandled:", e);
    return errorJson(500, "internal", e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "internal error");
  }
}

function formatZod(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ");
}

/** Parse URL search params with a zod object schema; throws a 400 on failure. */
export function parseQuery<T extends z.ZodType>(url: string | URL, schema: T): z.infer<T> {
  const u = typeof url === "string" ? new URL(url) : url;
  const obj: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (v !== "") obj[k] = v;
  const r = schema.safeParse(obj);
  if (!r.success) throw badRequest(formatZod(r.error));
  return r.data;
}

// ---------------------------------------------------------------------------------------------
// Common param schemas
// ---------------------------------------------------------------------------------------------

export const zAddress = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "invalid address")
  .transform((s) => getAddress(s));
export const zUint = z.string().regex(/^\d{1,78}$/, "expected a non-negative integer");
export const zId = z
  .string()
  .regex(/^[1-9]\d{0,77}$/, "expected a positive integer id");
export const zInt = (min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
export const zPage = {
  page: zInt(1, 1_000_000).default(1),
  pageSize: zInt(1, 100).default(20),
};
export const zOrder = z.enum(["asc", "desc"]);
