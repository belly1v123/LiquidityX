import { sql } from "drizzle-orm";
import { openPglite, setDbForTests, type Db } from "@/lib/server/db";
import { resetTestContext, setTestContext } from "@/lib/server/context";
import { resetRpcCaches, setRetryBaseDelay } from "@/lib/server/rpc";
import { clearIndexerCaches } from "@/lib/server/indexer";
import { mezoTestnet } from "@/lib/chain";
import { FakeChain, testDeployment } from "./fake-chain";

export interface TestEnv {
  db: Db;
  chain: FakeChain;
  close: () => Promise<void>;
}

/** Fresh in-memory PGlite + fake chain + test deployment. */
// One in-memory PGlite per test file (startup is slow); tables are truncated between tests.
let shared: Awaited<ReturnType<typeof openPglite>> | null = null;
const TABLES = [
  "users", "lending_offers", "borrowing_requests", "loans", "repayments", "indexed_events", "price_snapshots",
  "marketplace_analytics", "sync_state",
];

export async function setupEnv(opts: { deployed?: boolean; multicall?: boolean } = {}): Promise<TestEnv> {
  if (!shared) shared = await openPglite();
  const h = shared;
  await h.db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")}`));
  await setDbForTests({ db: h.db });
  const chain = new FakeChain();
  const multicall = opts.multicall ?? true;
  setTestContext({
    client: chain.client(),
    deployment: opts.deployed === false ? null : testDeployment(),
    chain: multicall ? mezoTestnet : { ...mezoTestnet, contracts: {} },
  });
  setRetryBaseDelay(0);
  resetRpcCaches();
  clearIndexerCaches();
  return {
    db: h.db,
    chain,
    close: async () => {
      await setDbForTests(null);
      resetTestContext();
    },
  };
}
