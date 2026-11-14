/**
 * Turns any wallet / RPC / contract error into one plain sentence.
 * Every custom error in contracts/src/interfaces/ILiquidityX.sol has an entry, plus the
 * OpenZeppelin errors the implementations can raise. Pure: no React, safe to unit test.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  type Abi,
} from "viem";
import { formatAmount, formatApr, formatBtc, formatCr, formatDateTime, formatDuration } from "@/lib/format";

/** OZ errors the implementations may revert with. Merged into every simulate/write ABI so they decode. */
export const extraErrorsAbi = [
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ExpectedPause", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  {
    type: "error",
    name: "AccessControlUnauthorizedAccount",
    inputs: [
      { name: "account", type: "address" },
      { name: "neededRole", type: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "AddressEmptyCode", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "FailedCall", inputs: [] },
] as const satisfies Abi;

export interface ErrorContext {
  /** Symbol and decimals of the stablecoin involved, for amounts in error args. */
  symbol?: string;
  decimals?: number;
}

export type TxErrorKind = "rejected" | "gas" | "revert" | "network" | "unknown";
export interface DecodedTxError {
  kind: TxErrorKind;
  message: string;
  /** Custom error name when the contract reverted with one. */
  errorName?: string;
}

type Args = readonly unknown[];
const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

/** Contract error name -> sentence. Amount args are in the context asset's units unless named BTC. */
export function describeContractError(name: string, args: Args = [], ctx: ErrorContext = {}): string {
  const sym = ctx.symbol ?? "MUSD";
  const dec = ctx.decimals ?? 18;
  const amt = (v: unknown) => formatAmount(big(v), dec);
  switch (name) {
    // Oracle
    case "InvalidFeed":
      return "The price feed address is not valid.";
    case "InvalidPrice":
      return "The BTC price feed returned an invalid price. Try again shortly.";
    case "StalePrice":
      return `The BTC price is out of date (last update ${formatDateTime(Number(big(args[0])))}, limit ${formatDuration(big(args[1]))}). New loans wait until it updates.`;
    // Config
    case "InvalidRiskParams":
      return "Those risk settings are outside the allowed bounds.";
    case "InvalidAsset":
      return "That token can't be used as a loan asset.";
    // Vault + marketplace
    case "AssetNotEnabled":
      return "This asset is not enabled for lending right now.";
    case "ZeroAmount":
      return "Enter an amount above zero.";
    case "InsufficientAvailable":
      return `Not enough available ${sym} in your vault. You have ${amt(args[0])}, this needs ${amt(args[1])}.`;
    case "InsufficientReserved":
      return `Not enough reserved ${sym}. Reserved ${amt(args[0])}, this needs ${amt(args[1])}.`;
    case "InsufficientLent":
      return `Lent balance too low. Lent ${amt(args[0])}, this needs ${amt(args[1])}.`;
    case "TransferAmountMismatch":
      return `The token moved a different amount than expected (${amt(args[1])} instead of ${amt(args[0])}). Fee-on-transfer tokens are not supported.`;
    // Collateral
    case "InsufficientFree":
      return `Not enough free BTC. You have ${formatBtc(big(args[0]))}, this needs ${formatBtc(big(args[1]))}.`;
    case "InsufficientLocked":
      return `Not enough locked BTC. Locked ${formatBtc(big(args[0]))}, this needs ${formatBtc(big(args[1]))}.`;
    case "NativeTransferFailed":
      return "Sending BTC to your wallet failed. Try again from a regular wallet address.";
    case "DirectTransferNotAllowed":
      return "Send BTC through the app, not directly to the contract.";
    // Loans
    case "LoanNotActive":
      return `Loan #${big(args[0])} is already closed.`;
    case "InvalidLoanParams":
      return "Those loan terms are not valid.";
    case "ExcessiveSeize":
      return `Liquidation would take ${formatBtc(big(args[0]))} BTC but the loan only holds ${formatBtc(big(args[1]))}.`;
    // Marketplace
    case "InvalidAmount":
      return "The amount is outside this asset's minimum and maximum loan size.";
    case "InvalidApr":
      return "That APR is outside the allowed range.";
    case "InvalidDuration":
      return "That duration is outside the allowed range.";
    case "InvalidExpiry":
      return "The listing expiry must be in the future and within the maximum listing lifetime.";
    case "InvalidCollateralRatio":
      return "That collateral ratio is below the protocol minimum.";
    case "OfferNotOpen":
      return `Offer #${big(args[0])} is no longer open.`;
    case "RequestNotOpen":
      return `Request #${big(args[0])} is no longer open.`;
    case "OfferExpired":
      return `Offer #${big(args[0])} has expired.`;
    case "RequestExpired":
      return `Request #${big(args[0])} has expired.`;
    case "NotOfferOwner":
      return "Only the lender who created this offer can do that.";
    case "NotRequestOwner":
      return "Only the borrower who created this request can do that.";
    case "NotParty":
      return "Only the offer's lender or the request's borrower can run this match.";
    case "SelfMatch":
      return "You can't lend to yourself.";
    case "AssetMismatch":
      return "The offer and the request use different assets.";
    case "AprTooHigh":
      return `The offer's APR (${formatApr(big(args[0]))}) is above the request's limit (${formatApr(big(args[1]))}).`;
    case "DurationTooLong":
      return `The loan would run ${formatDuration(big(args[0]))}, longer than the offer allows (${formatDuration(big(args[1]))}).`;
    case "InsufficientCollateral":
      return `Not enough collateral. This loan would be at ${formatCr(big(args[0]))}, it needs at least ${formatCr(big(args[1]))}.`;
    case "CollateralCapExceeded":
      return `Too much collateral for one loan. ${formatBtc(big(args[0]))} BTC is above the ${formatBtc(big(args[1]))} BTC cap.`;
    case "FillTooSmall":
      return `Fill too small. ${amt(args[0])} ${sym} is below the ${amt(args[1])} ${sym} minimum.`;
    // Liquidation
    case "NotLiquidatable":
      return `Loan #${big(args[0])} can't be liquidated. It is healthy and not overdue.`;
    case "NotAuthorized":
      return "Only the loan's lender can liquidate it.";
    // OpenZeppelin
    case "EnforcedPause":
      return "LiquidityX is paused. Repay, withdraw and cancel still work.";
    case "ExpectedPause":
      return "This only works while the protocol is paused.";
    case "AccessControlBadConfirmation":
      return "Role change refused: the confirmation address didn't match.";
    case "InvalidMaxStaleness":
      return "That price staleness limit is outside the allowed range (30 seconds to 1 day).";
    case "ZeroAddress":
      return "An address was empty. Check the inputs and retry.";
    case "ReentrancyGuardReentrantCall":
      return "That call was blocked as unsafe.";
    case "AccessControlUnauthorizedAccount":
      return "Your wallet doesn't have permission to do that.";
    case "ERC20InsufficientBalance":
      return `Not enough ${sym}. You have ${amt(args[1])}, this needs ${amt(args[2])}.`;
    case "ERC20InsufficientAllowance":
      return `The approval is too small. Approved ${amt(args[1])} ${sym}, this needs ${amt(args[2])}. Approve again and retry.`;
    case "SafeERC20FailedOperation":
      return `The ${sym} transfer failed. Check your balance and approval.`;
    default:
      return `The contract rejected this (${name}).`;
  }
}

/** Any thrown value -> { kind, message }. */
export function decodeTxError(err: unknown, ctx: ErrorContext = {}): DecodedTxError {
  if (err instanceof BaseError) {
    const rejected = err.walk((e) => e instanceof UserRejectedRequestError || (e as { code?: number })?.code === 4001);
    if (rejected) return { kind: "rejected", message: "You cancelled the request in your wallet." };

    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return { kind: "gas", message: "Not enough BTC to pay the network fee. Add testnet BTC to this wallet and retry." };
    }

    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert) {
      const name = revert.data?.errorName;
      if (name && name !== "Error" && name !== "Panic") {
        return { kind: "revert", errorName: name, message: describeContractError(name, revert.data?.args ?? [], ctx) };
      }
      if (revert.reason) return { kind: "revert", message: `The contract rejected this: ${revert.reason}.` };
      return { kind: "revert", message: "The contract rejected this transaction." };
    }

    const text = `${err.shortMessage} ${err.details ?? ""}`.toLowerCase();
    if (text.includes("insufficient funds")) {
      return { kind: "gas", message: "Not enough BTC to pay the network fee. Add testnet BTC to this wallet and retry." };
    }
    if (text.includes("chain mismatch") || text.includes("does not match the target chain")) {
      return { kind: "network", message: "Your wallet is on another network. Switch to Mezo Testnet and retry." };
    }
    if (text.includes("http request failed") || text.includes("fetch failed") || text.includes("timed out") || text.includes("took too long")) {
      return { kind: "network", message: "Couldn't reach the Mezo testnet RPC. Check your connection and retry." };
    }
    return { kind: "unknown", message: err.shortMessage || "Something went wrong with this transaction." };
  }
  const anyErr = err as { code?: number; message?: string } | null;
  if (anyErr?.code === 4001) return { kind: "rejected", message: "You cancelled the request in your wallet." };
  return { kind: "unknown", message: anyErr?.message ? String(anyErr.message).split("\n")[0] : "Something went wrong." };
}

/** Every custom error declared in the frozen interface. Used by tests to prove coverage. */
export const INTERFACE_ERROR_NAMES = [
  "InvalidFeed", "InvalidPrice", "StalePrice", "InvalidRiskParams", "InvalidAsset", "AssetNotEnabled", "ZeroAmount",
  "InsufficientAvailable", "InsufficientReserved", "InsufficientLent", "TransferAmountMismatch", "InsufficientFree",
  "InsufficientLocked", "NativeTransferFailed", "DirectTransferNotAllowed", "LoanNotActive", "InvalidLoanParams",
  "ExcessiveSeize", "InvalidAmount", "InvalidApr", "InvalidDuration", "InvalidExpiry", "InvalidCollateralRatio",
  "OfferNotOpen", "RequestNotOpen", "OfferExpired", "RequestExpired", "NotOfferOwner", "NotRequestOwner", "NotParty",
  "SelfMatch", "AssetMismatch", "AprTooHigh", "DurationTooLong", "InsufficientCollateral", "CollateralCapExceeded",
  "FillTooSmall", "NotLiquidatable", "NotAuthorized",
] as const;
