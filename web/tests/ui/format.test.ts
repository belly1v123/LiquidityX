import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatApr,
  formatBtc,
  formatCountdown,
  formatCr,
  formatDuration,
  formatUsd,
  parseAmount,
  percentToBps,
  shortAddress,
  toInputString,
} from "@/lib/format";

const E18 = 10n ** 18n;

describe("formatAmount", () => {
  it("groups and trims", () => {
    expect(formatAmount(1_234_500n * E18 / 1000n, 18)).toBe("1,234.5");
    expect(formatAmount(0n, 18)).toBe("0");
    expect(formatAmount("1000000000000000000000", 18)).toBe("1,000");
  });
  it("never rounds a balance up", () => {
    expect(formatAmount(1_999_999n * 10n ** 12n, 18)).toBe("1.99");
  });
  it("shows dust instead of 0", () => {
    expect(formatAmount(1n, 18)).toBe("< 0.000001");
    expect(formatAmount(24_000_000_000_000n, 18)).toBe("0.000024");
  });
  it("compacts large values only when asked", () => {
    expect(formatAmount(1_250_000n * E18, 18, { compact: true })).toBe("1.25M");
    expect(formatAmount(99_000n * E18, 18, { compact: true })).toBe("99,000");
  });
  it("handles 6-decimal assets", () => {
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
  });
});

describe("other formatters", () => {
  it("formats rates and ratios", () => {
    expect(formatApr(625)).toBe("6.25%");
    expect(formatApr(800)).toBe("8%");
    expect(formatCr(18_750n)).toBe("187.5%");
    expect(formatCr(2n ** 256n - 1n)).toBe("No debt");
  });
  it("formats BTC and USD", () => {
    expect(formatBtc(7_500_000_000_000_000n)).toBe("0.0075");
    expect(formatUsd(1_213_005_060_000_000_000_000_000n)).toBe("$1,213,005.06");
  });
  it("formats durations and countdowns", () => {
    expect(formatDuration(30 * 86400)).toBe("30 days");
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(365 * 86400)).toBe("1 year");
    expect(formatCountdown(1000 + 86400 * 2 + 3600 * 3, 1000)).toBe("2d 3h");
    expect(formatCountdown(10, 20)).toBe("ended");
  });
  it("shortens addresses", () => {
    expect(shortAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBe("0x7099…79C8");
  });
});

describe("parsing user input", () => {
  it("parses amounts exactly", () => {
    expect(parseAmount("1,250.5", 18)).toBe(1_250_500n * E18 / 1000n);
    expect(parseAmount("0.1234567", 6)).toBeNull();
    expect(parseAmount("abc", 18)).toBeNull();
    expect(parseAmount("", 18)).toBeNull();
    expect(parseAmount(".", 18)).toBeNull();
  });
  it("round-trips through the input string", () => {
    const v = parseAmount("42.0075", 18)!;
    expect(toInputString(v, 18)).toBe("42.0075");
  });
  it("converts percent to bps", () => {
    expect(percentToBps("6.25")).toBe(625);
    expect(percentToBps("8")).toBe(800);
    expect(percentToBps("6.255")).toBeNull();
    expect(percentToBps("-1")).toBeNull();
  });
});
