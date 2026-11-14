import "server-only";
import { decodeEventLog, getAddress, type Abi, type Address, type Log } from "viem";
import type { ActivityKind } from "@/lib/api-types";
import type { ContractKey, Deployment } from "@/lib/chain";
import { abis } from "./rpc";

export interface DecodedLog {
  contract: ContractKey;
  address: Address;
  eventName: string;
  args: Record<string, unknown>;
}

/** address(lowercase) -> contract key */
export function contractMap(d: Deployment): Map<string, ContractKey> {
  const m = new Map<string, ContractKey>();
  for (const [k, a] of Object.entries(d.contracts) as [ContractKey, Address][]) m.set(a.toLowerCase(), k);
  return m;
}

/** Decode with the ABI of the contract that emitted it. Unknown events (e.g. OZ Paused/RoleGranted) => eventName "unknown". */
export function decodeLog(log: Pick<Log, "address" | "topics" | "data">, map: Map<string, ContractKey>): DecodedLog | null {
  const contract = map.get(log.address.toLowerCase());
  if (!contract) return null;
  const abi = abis[contract] as Abi;
  try {
    const dec = decodeEventLog({ abi, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data, strict: true });
    return {
      contract,
      address: getAddress(log.address),
      eventName: dec.eventName ?? "unknown",
      args: (dec.args ?? {}) as Record<string, unknown>,
    };
  } catch {
    return { contract, address: getAddress(log.address), eventName: "unknown", args: { topics: log.topics, data: log.data } };
  }
}

export interface EventFields {
  kind: ActivityKind | null;
  account: Address | null;
  counterparty: Address | null;
  asset: Address | null;
  amount: bigint | null;
  btcAmount: bigint | null;
  offerId: bigint | null;
  requestId: bigint | null;
  loanId: bigint | null;
}

const nz = (v: unknown): bigint | null => {
  if (v === undefined || v === null) return null;
  const b = BigInt(v as bigint);
  return b === 0n ? null : b;
};
const big = (v: unknown): bigint | null => (v === undefined || v === null ? null : BigInt(v as bigint));
const addr = (v: unknown): Address | null => (typeof v === "string" ? getAddress(v) : null);

/** Maps a decoded event to the activity columns. Missing account/asset for loan events are filled from the loans table later. */
export function eventFields(ev: Pick<DecodedLog, "eventName" | "args">): EventFields {
  const a = ev.args;
  const f: EventFields = {
    kind: null, account: null, counterparty: null, asset: null, amount: null, btcAmount: null,
    offerId: null, requestId: null, loanId: null,
  };
  switch (ev.eventName) {
    // Vault
    case "Deposited":
    case "Withdrawn":
      f.kind = ev.eventName === "Deposited" ? "deposit" : "withdraw";
      f.account = addr(a.lender); f.asset = addr(a.asset); f.amount = big(a.amount);
      break;
    case "LiquidityReserved":
    case "LiquidityReleased":
      f.account = addr(a.lender); f.asset = addr(a.asset); f.amount = big(a.amount);
      break;
    case "LoanFunded":
      f.loanId = nz(a.loanId); f.account = addr(a.lender); f.counterparty = addr(a.borrower); f.asset = addr(a.asset); f.amount = big(a.amount);
      break;
    case "RepaymentCredited":
      f.loanId = nz(a.loanId); f.account = addr(a.lender); f.asset = addr(a.asset);
      f.amount = (big(a.principal) ?? 0n) + (big(a.interest) ?? 0n);
      break;
    case "PrincipalWrittenOff":
      f.loanId = nz(a.loanId); f.account = addr(a.lender); f.asset = addr(a.asset); f.amount = big(a.principal);
      break;
    // CollateralManager
    case "CollateralDeposited":
    case "CollateralWithdrawn":
      f.kind = ev.eventName === "CollateralDeposited" ? "collateral_deposited" : "collateral_withdrawn";
      f.account = addr(a.account); f.btcAmount = big(a.amount);
      break;
    case "CollateralLocked":
    case "CollateralUnlocked":
      f.requestId = nz(a.requestId); f.account = addr(a.account); f.btcAmount = big(a.amount);
      break;
    case "CollateralAssignedToLoan":
      f.loanId = nz(a.loanId); f.requestId = nz(a.requestId); f.account = addr(a.account); f.btcAmount = big(a.amount);
      break;
    case "CollateralReleased":
      f.kind = "collateral_released"; f.loanId = nz(a.loanId); f.account = addr(a.account); f.btcAmount = big(a.amount);
      break;
    case "CollateralSeized":
      f.loanId = nz(a.loanId); f.account = addr(a.lender); f.counterparty = addr(a.borrower); f.btcAmount = big(a.lenderAmount);
      break;
    // LoanManager
    case "LoanActivated":
      f.kind = "loan_activated"; f.loanId = nz(a.loanId); f.account = addr(a.borrower); f.counterparty = addr(a.lender);
      f.asset = addr(a.asset); f.amount = big(a.principal); f.btcAmount = big(a.collateral);
      f.offerId = nz(a.offerId); f.requestId = nz(a.requestId);
      break;
    case "LoanRepayment":
      f.kind = "repayment"; f.loanId = nz(a.loanId); f.account = addr(a.payer);
      f.amount = (big(a.interestPaid) ?? 0n) + (big(a.principalPaid) ?? 0n);
      break;
    case "LoanRepaid":
      f.kind = "loan_repaid"; f.loanId = nz(a.loanId); f.amount = big(a.totalInterestPaid);
      break;
    case "LoanLiquidated":
      f.loanId = nz(a.loanId); f.btcAmount = big(a.lenderCollateral);
      break;
    // LoanMarketplace
    case "OfferCreated":
      f.kind = "offer_created"; f.offerId = nz(a.offerId); f.account = addr(a.lender); f.asset = addr(a.asset); f.amount = big(a.amount);
      break;
    case "OfferCancelled":
      f.kind = "offer_cancelled"; f.offerId = nz(a.offerId); f.account = addr(a.lender); f.amount = big(a.released);
      break;
    case "RequestCreated":
      f.kind = "request_created"; f.requestId = nz(a.requestId); f.account = addr(a.borrower); f.asset = addr(a.asset);
      f.amount = big(a.amount); f.btcAmount = big(a.collateral);
      break;
    case "RequestCancelled":
      f.kind = "request_cancelled"; f.requestId = nz(a.requestId); f.account = addr(a.borrower); f.btcAmount = big(a.collateralReleased);
      break;
    case "Matched": {
      f.kind = "matched"; f.loanId = nz(a.loanId); f.offerId = nz(a.offerId); f.requestId = nz(a.requestId);
      const lender = addr(a.lender), borrower = addr(a.borrower), executor = addr(a.executor);
      f.account = executor ?? lender;
      f.counterparty = f.account && lender && f.account === lender ? borrower : lender;
      f.amount = big(a.amount); f.btcAmount = big(a.collateral);
      break;
    }
    // LiquidationEngine
    case "Liquidated":
      f.kind = "liquidated"; f.loanId = nz(a.loanId); f.account = addr(a.caller); f.amount = big(a.debt); f.btcAmount = big(a.lenderCollateral);
      break;
    default:
      break;
  }
  return f;
}

/** JSON-safe args (bigint -> decimal string). */
export function jsonArgs(args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
