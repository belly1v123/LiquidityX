import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/drizzle/schema";
import { DDL } from "@/drizzle/ddl";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbKind = "postgres" | "pglite";

interface DbHandle {
  db: Db;
  kind: DbKind;
  close: () => Promise<void>;
}

let handle: Promise<DbHandle> | null = null;

/** Postgres when DATABASE_URL is set, else PGlite on disk (web/.data/pglite, or /tmp/pglite on Vercel). */
export function dbKind(): DbKind {
  return process.env.DATABASE_URL ? "postgres" : "pglite";
}

function pgliteDir(): string {
  if (process.env.PGLITE_DIR) return process.env.PGLITE_DIR;
  if (process.env.VERCEL) return "/tmp/pglite";
  return `${process.cwd()}/.data/pglite`;
}

async function open(): Promise<DbHandle> {
  if (process.env.DATABASE_URL) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // DB_SCHEMA isolates LiquidityX's tables inside a shared database (e.g. a Supabase project used by
    // several apps). Every connection starts with search_path = DB_SCHEMA, so unqualified queries and
    // the DDL below land in that schema.
    const dbSchema = process.env.DB_SCHEMA?.trim();
    if (dbSchema && !/^[a-z_][a-z0-9_]*$/.test(dbSchema)) throw new Error("DB_SCHEMA must be a lowercase identifier");
    const client = postgres(process.env.DATABASE_URL, {
      max: process.env.VERCEL ? 1 : 5,
      prepare: false, // works behind transaction poolers (Neon/Supabase pgbouncer)
      onnotice: () => {},
      connect_timeout: 10,
      ...(dbSchema ? { connection: { search_path: dbSchema } } : {}),
    });
    if (dbSchema) await client.unsafe(`create schema if not exists ${dbSchema}`);
    await client.unsafe(DDL).simple();
    const db = drizzle({ client, schema }) as unknown as Db;
    return { db, kind: "postgres", close: () => client.end() };
  }
  return openPglite(pgliteDir());
}

/** Opens a PGlite database (dataDir undefined => in-memory). Exported for tests. */
export async function openPglite(dataDir?: string): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  if (dataDir) {
    const fs = await import("node:fs");
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.exec(DDL);
  const db = drizzle({ client, schema }) as unknown as Db;
  return { db, kind: "pglite", close: () => client.close() };
}

export async function getDb(): Promise<Db> {
  if (!handle) {
    handle = open().catch((e) => {
      handle = null; // retry on the next call
      throw e;
    });
  }
  return (await handle).db;
}

/** Tests: swap in an in-memory PGlite (or reset with null). */
export async function setDbForTests(next: { db: Db; kind?: DbKind; close?: () => Promise<void> } | null) {
  if (handle) {
    const h = await handle.catch(() => null);
    if (h && next?.db !== h.db) await h.close().catch(() => {});
  }
  handle = next ? Promise.resolve({ db: next.db, kind: next.kind ?? "pglite", close: next.close ?? (async () => {}) }) : null;
}

export { schema };
