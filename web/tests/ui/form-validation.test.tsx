import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { checkAmount, checkBtc, checkDuration } from "@/components/forms";
import { Field, AmountInput } from "@/components/ui/field";
import { parseAmount } from "@/lib/format";

const E18 = 10n ** 18n;

describe("amount validation", () => {
  const base = { decimals: 18, symbol: "MUSD" };
  it("is quiet while the field is empty", () => {
    expect(checkAmount({ ...base, amount: null, raw: "" })).toBeNull();
  });
  it("explains balance shortfalls with both numbers", () => {
    expect(checkAmount({ ...base, amount: 40n * E18, raw: "40", balance: 12_500000000000000000n })).toBe(
      "Not enough MUSD. You have 12.5, this needs 40.",
    );
  });
  it("enforces min and max, allowing an exact remainder below the minimum", () => {
    expect(checkAmount({ ...base, amount: E18 / 2n, raw: "0.5", min: E18 })).toBe("Too small. The minimum is 1 MUSD.");
    expect(checkAmount({ ...base, amount: E18 / 2n, raw: "0.5", min: E18, allowExact: E18 / 2n })).toBeNull();
    expect(checkAmount({ ...base, amount: 2000n * E18, raw: "2000", max: 1000n * E18, maxLabel: "What's left in this offer" })).toBe(
      "Too much. What's left in this offer is 1,000 MUSD.",
    );
  });
  it("rejects malformed input", () => {
    expect(checkAmount({ ...base, amount: parseAmount("1.2.3", 18), raw: "1.2.3" })).toMatch(/at most 18 decimals/);
    expect(checkAmount({ ...base, amount: 0n, raw: "0" })).toBe("Enter an amount above zero.");
  });
});

describe("term and collateral validation", () => {
  it("checks term bounds", () => {
    expect(checkDuration(1800, 3600, 86400 * 365)).toBe("Too short. The minimum term is 1 hour.");
    expect(checkDuration(86400 * 60, 3600, 86400 * 30, "This offer's longest term")).toBe("Too long. This offer's longest term is 30 days.");
    expect(checkDuration(86400, 3600, 86400 * 30)).toBeNull();
  });
  it("checks collateral against wallet and the minimum", () => {
    expect(checkBtc(2n * E18, "2", { balance: E18 })).toBe("Not enough BTC. You have 1, this needs 2.");
    expect(checkBtc(E18 / 100n, "0.01", { min: E18 / 50n })).toBe("Not enough collateral. This needs at least 0.02 BTC.");
    expect(checkBtc(11n * E18, "11", { max: 10n * E18 })).toBe("Too much for one loan. The cap is 10 BTC.");
  });
});

describe("Field", () => {
  it("announces errors and links the label", () => {
    render(
      <Field label="Amount" htmlFor="amt" error="Not enough MUSD. You have 12.5, this needs 40.">
        <AmountInput id="amt" invalid suffix="MUSD" />
      </Field>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Not enough MUSD. You have 12.5, this needs 40.");
    const input = screen.getByLabelText("Amount");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("inputmode")).toBe("decimal");
  });
});
