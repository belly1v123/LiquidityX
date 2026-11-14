/** In-memory fake of the contracts + RPC used by backend tests (no network). */
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Abi, type AbiEvent, type Address, type Log } from "viem";
import type { Deployment } from "@/lib/chain";
import { MUSD } from "@/lib/chain";
import { abis, type ChainLoan, type ChainOffer, type ChainRequest, type RiskParams } from "@/lib/server/rpc";
import type { ChainClient } from "@/lib/server/context";

export const ADDR = {
  oracle: "0x00000000000000000000000000000000000000a1",
  config: "0x00000000000000000000000000000000000000a2",
  vault: "0x00000000000000000000000000000000000000a3",
  collateral: "0x00000000000000000000000000000000000000a4",
  loans: "0x00000000000000000000000000000000000000a5",
  marketplace: "0x00000000000000000000000000000000000000a6",
  liquidation: "0x00000000000000000000000000000000000000a7",
} as const;

export const ALICE = getAddress("0x1111111111111111111111111111111111111111"); // lender
export const BOB = getAddress("0x2222222222222222222222222222222222222222"); // borrower
export const CAROL = getAddress("0x3333333333333333333333333333333333333333"); // lender 2

export const START_BLOCK = 100n;

export function testDeployment(): Deployment {
  const contracts = Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [k, getAddress(v)])) as Deployment["contracts"];
  return { chainId: 31611, deployer: null, startBlock: START_BLOCK, contracts, assets: [MUSD], txs: {} };
}

export const E18 = 10n ** 18n;
export const PRICE = 100_000n * E18; // $100k / BTC

export const DEFAULT_RISK: RiskParams = {
  minInitialCrBps: 15_000, liquidationCrBps: 12_000, liquidationBonusBps: 500, minAprBps: 1, maxAprBps: 10_000,
  minDuration: 3600, maxDuration: 365 * 86400, gracePeriod: 86400, maxListingLifetime: 30 * 86400, maxCollateralPerLoan: 10n * E18,
};

export class FakeChain {
  head = 200n;
  blockHashSalt = "a";
  logs: Log[] = [];
  offers = new Map<bigint, ChainOffer>();
  requests = new Map<bigint, ChainRequest>();
  loans = new Map<bigint, ChainLoan>();
  price: { ok: boolean; price: bigint; updatedAt: bigint } = { ok: true, price: PRICE, updatedAt: 1_800_000_000n };
  risk = DEFAULT_RISK;
  paused = false;
  /** number of upcoming RPC calls (any method) that throw */
  failNext = 0;
  /** every RPC call throws */
  down = false;
  calls: Record<string, number> = {};

  private maybeFail(method: string) {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if (this.down) throw new Error(`rpc down (${method})`);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`transient rpc error (${method})`);
    }
  }

  blockHash(n: bigint): `0x${string}` {
    return keccak256(toHex(`${this.blockHashSalt}:${n}`));
  }
  blockTime(n: bigint): number {
    return 1_800_000_000 + Number(n) * 2;
  }

  read(functionName: string, args: readonly unknown[] = []): unknown {
    const id = args[0] as bigint;
    switch (functionName) {
      case "tryGetPrice": return [this.price.ok, this.price.ok ? this.price.price : 0n, this.price.updatedAt] as const;
      case "maxStaleness": return 3600n;
      case "riskParams": return this.risk;
      case "paused": return this.paused;
      case "listAssets": return [MUSD.address];
      case "assetConfig": return { enabled: true, decimals: 18, minLoan: E18, maxLoan: 1_000_000n * E18 };
      case "getOffer": return this.offers.get(id) ?? emptyOffer();
      case "getRequest": return this.requests.get(id) ?? emptyRequest();
      case "getLoan": return this.loans.get(id) ?? emptyLoan();
      case "health": {
        const l = this.loans.get(id);
        return [l ? 20_000n : 0n, 0, this.price.ok] as const;
      }
      case "totalAvailable": return 10n * E18;
      case "totalReserved": return 20n * E18;
      case "totalLent": return 30n * E18;
      case "totalInterestPaid": return 1n * E18;
      case "totalLockedInRequests": return 2n * E18;
      case "totalLockedInLoans": return 3n * E18;
      case "available": case "reserved": case "lent": case "interestEarned": return 5n * E18;
      case "freeCollateral": return 7n * E18;
      default: throw new Error(`fake: unknown function ${functionName}`);
    }
  }

  client(): ChainClient {
    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
    const c = {
      async getBlockNumber() {
        self.maybeFail("getBlockNumber");
        return self.head;
      },
      async getBlock({ blockNumber }: { blockNumber: bigint }) {
        self.maybeFail("getBlock");
        return { number: blockNumber, hash: self.blockHash(blockNumber), timestamp: BigInt(self.blockTime(blockNumber)) };
      },
      async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
        self.maybeFail("getLogs");
        if (toBlock - fromBlock + 1n > 10_000n) throw new Error("range too large");
        return self.logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
      },
      async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
        self.maybeFail("readContract");
        return self.read(functionName, args);
      },
      async multicall({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) {
        self.maybeFail("multicall");
        return contracts.map((k) => {
          try {
            return { status: "success", result: self.read(k.functionName, k.args) };
          } catch (error) {
            return { status: "failure", error };
          }
        });
      },
    };
    return c as unknown as ChainClient;
  }

  /** Append an encoded log as the real contract would emit it. */
  emit(contract: keyof typeof ADDR, eventName: string, args: Record<string, unknown>, block: bigint, opts: { txHash?: `0x${string}`; logIndex?: number } = {}): Log {
    const abi = abis[contract] as Abi;
    const ev = abi.find((x) => x.type === "event" && x.name === eventName) as AbiEvent | undefined;
    if (!ev) throw new Error(`no event ${eventName} on ${contract}`);
    const topics = encodeEventTopics({ abi: [ev], eventName, args: args as never });
    const nonIndexed = ev.inputs.filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
    const logIndex = opts.logIndex ?? this.logs.filter((l) => l.blockNumber === block).length;
    const log = {
      address: ADDR[contract],
      topics,
      data,
      blockNumber: block,
      blockHash: this.blockHash(block),
      transactionHash: opts.txHash ?? keccak256(toHex(`tx:${block}:${logIndex}:${eventName}`)),
      transactionIndex: 0,
      logIndex,
      removed: false,
    } as unknown as Log;
    this.logs.push(log);
    return log;
  }
}

export function emptyOffer(): ChainOffer {
  return { id: 0n, lender: zero, asset: zero, amount: 0n, remaining: 0n, aprBps: 0, maxDuration: 0, minCrBps: 0, expiry: 0n, createdAt: 0n, fills: 0, status: 0 };
}
export function emptyRequest(): ChainRequest {
  return { id: 0n, borrower: zero, asset: zero, amount: 0n, filled: 0n, maxAprBps: 0, duration: 0, collateral: 0n, collateralRemaining: 0n, expiry: 0n, createdAt: 0n, fills: 0, status: 0 };
}
export function emptyLoan(): ChainLoan {
  return {
    id: 0n, offerId: 0n, requestId: 0n, lender: zero, borrower: zero, asset: zero, principal: 0n, outstandingPrincipal: 0n,
    accruedInterest: 0n, interestPaid: 0n, principalRepaid: 0n, collateral: 0n, aprBps: 0, start: 0n, maturity: 0n,
    lastAccrual: 0n, closedAt: 0n, status: 0,
  };
}
const zero = "0x0000000000000000000000000000000000000000" as Address;

export const FAR_FUTURE = 4_000_000_000n;

export function makeOffer(id: bigint, p: Partial<ChainOffer> = {}): ChainOffer {
  return {
    id, lender: ALICE, asset: MUSD.address, amount: 1000n * E18, remaining: 1000n * E18, aprBps: 500, maxDuration: 30 * 86400,
    minCrBps: 15_000, expiry: FAR_FUTURE, createdAt: 1_800_000_000n, fills: 0, status: 1, ...p,
  };
}
export function makeRequest(id: bigint, p: Partial<ChainRequest> = {}): ChainRequest {
  return {
    id, borrower: BOB, asset: MUSD.address, amount: 1000n * E18, filled: 0n, maxAprBps: 800, duration: 7 * 86400,
    collateral: E18 / 50n, collateralRemaining: E18 / 50n, expiry: FAR_FUTURE, createdAt: 1_800_000_000n, fills: 0, status: 1, ...p,
  };
}
export function makeLoan(id: bigint, p: Partial<ChainLoan> = {}): ChainLoan {
  return {
    id, offerId: 1n, requestId: 1n, lender: ALICE, borrower: BOB, asset: MUSD.address, principal: 400n * E18,
    outstandingPrincipal: 400n * E18, accruedInterest: 0n, interestPaid: 0n, principalRepaid: 0n, collateral: E18 / 125n,
    aprBps: 500, start: 1_800_000_000n, maturity: BigInt(FAR_FUTURE), lastAccrual: 1_800_000_000n, closedAt: 0n, status: 1, ...p,
  };
}
