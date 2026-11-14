import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  InsufficientFundsError,
  UserRejectedRequestError,
  type Abi,
} from "viem";
import * as abis from "@/lib/abi";
import { decodeTxError, describeContractError, extraErrorsAbi, INTERFACE_ERROR_NAMES } from "@/hooks/tx-errors";
import { loanMarketplaceAbi, liquidityXVaultAbi } from "@/lib/abi";

const allErrorNames = () => {
  const names = new Set<string>();
  for (const abi of Object.values(abis)) {
    for (const item of abi as Abi) if (item.type === "error") names.add(item.name);
  }
  return [...names];
};

function revert(abi: Abi, errorName: string, args: readonly unknown[]) {
  const data = encodeErrorResult({ abi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: "x" });
  return new ContractFunctionExecutionError(cause as unknown as BaseError, { abi, functionName: "x", args: [] });
}

describe("contract error sentences", () => {
  it("covers every custom error in the frozen interface", () => {
    for (const name of INTERFACE_ERROR_NAMES) {
      expect(describeContractError(name), name).not.toMatch(/rejected this \(/);
    }
  });

  it("covers every error in the generated ABIs (implementations included)", () => {
    const missing = allErrorNames().filter((n) => describeContractError(n).includes(`(${n})`));
    expect(missing).toEqual([]);
  });

  it("states action + numbers for balance errors", () => {
    expect(describeContractError("InsufficientAvailable", [12_500000000000000000n, 40n * 10n ** 18n], { symbol: "MUSD", decimals: 18 })).toBe(
      "Not enough available MUSD in your vault. You have 12.5, this needs 40.",
    );
    expect(describeContractError("AprTooHigh", [900, 800])).toBe("The offer's APR (9%) is above the request's limit (8%).");
    expect(describeContractError("InsufficientCollateral", [14_000n, 15_000n])).toBe(
      "Not enough collateral. This loan would be at 140%, it needs at least 150%.",
    );
  });

  it("respects asset decimals (mUSDC has 6)", () => {
    expect(describeContractError("FillTooSmall", [500_000n, 1_000_000n], { symbol: "mUSDC", decimals: 6 })).toBe(
      "Fill too small. 0.5 mUSDC is below the 1 mUSDC minimum.",
    );
  });
});

describe("decodeTxError", () => {
  it("decodes a real revert payload from the marketplace ABI", () => {
    const abi = [...loanMarketplaceAbi, ...extraErrorsAbi] as Abi;
    const d = decodeTxError(revert(abi, "OfferExpired", [7n]));
    expect(d).toMatchObject({ kind: "revert", errorName: "OfferExpired", message: "Offer #7 has expired." });
  });

  it("decodes vault errors with the asset context", () => {
    const abi = [...liquidityXVaultAbi] as Abi;
    const d = decodeTxError(revert(abi, "InsufficientAvailable", [10n ** 18n, 5n * 10n ** 18n]), { symbol: "MUSD", decimals: 18 });
    expect(d.message).toBe("Not enough available MUSD in your vault. You have 1, this needs 5.");
  });

  it("decodes OpenZeppelin pause errors", () => {
    const d = decodeTxError(revert(extraErrorsAbi as unknown as Abi, "EnforcedPause", []));
    expect(d.message).toMatch(/paused/);
  });

  it("treats wallet rejection as a cancel, not a failure", () => {
    const e = new UserRejectedRequestError(new Error("User rejected"));
    expect(decodeTxError(e).kind).toBe("rejected");
    expect(decodeTxError({ code: 4001, message: "denied" }).kind).toBe("rejected");
  });

  it("maps missing gas to a BTC sentence", () => {
    const e = new InsufficientFundsError({ cause: new BaseError("insufficient funds for gas * price + value") });
    const d = decodeTxError(e);
    expect(d.kind).toBe("gas");
    expect(d.message).toMatch(/BTC/);
  });
});
