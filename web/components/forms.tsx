"use client";
/** Form helpers shared by lend, borrow and marketplace sheets. Validation returns sentences with numbers. */
import { useState } from "react";
import { formatAmount, formatBtc, formatDuration } from "@/lib/format";
import { Input, Select } from "./ui/field";

export type DurationUnit = "hours" | "days";
export const UNIT_SECONDS: Record<DurationUnit, number> = { hours: 3600, days: 86400 };

export function useDurationState(initial = 30, initialUnit: DurationUnit = "days") {
  const [value, setValue] = useState(String(initial));
  const [unit, setUnit] = useState<DurationUnit>(initialUnit);
  const n = Number(value);
  const seconds = value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * UNIT_SECONDS[unit]) : null;
  return { value, setValue, unit, setUnit, seconds };
}

export function DurationInput({
  id,
  state,
  invalid,
}: {
  id: string;
  state: ReturnType<typeof useDurationState>;
  invalid?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_7.5rem] gap-2">
      <Input id={id} inputMode="decimal" autoComplete="off" value={state.value} onChange={(e) => state.setValue(e.target.value)} invalid={invalid} />
      <Select aria-label="Unit" value={state.unit} onChange={(e) => state.setUnit(e.target.value as DurationUnit)}>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </Select>
    </div>
  );
}

/** Sensible starting term for a max duration in seconds: whole days, or hours when under a day. */
export function initialTerm(maxSeconds: number): [number, DurationUnit] {
  return maxSeconds >= 86400 ? [Math.floor(maxSeconds / 86400), "days"] : [Math.max(1, Math.floor(maxSeconds / 3600)), "hours"];
}

/** Amount checks shared by every stablecoin input. Returns an error sentence or null. */
export function checkAmount(opts: {
  amount: bigint | null;
  raw: string;
  decimals: number;
  symbol: string;
  min?: bigint;
  max?: bigint;
  maxLabel?: string;
  balance?: bigint;
  balanceLabel?: string;
  /** A size below min is allowed when it equals this exactly (completing a listing). */
  allowExact?: bigint;
}): string | null {
  const { amount, raw, decimals, symbol } = opts;
  if (!raw.trim()) return null;
  if (amount === null) return `Enter a number with at most ${decimals} decimals.`;
  if (amount === 0n) return "Enter an amount above zero.";
  const f = (v: bigint) => formatAmount(v, decimals);
  if (opts.balance !== undefined && amount > opts.balance) {
    return `Not enough ${opts.balanceLabel ?? symbol}. You have ${f(opts.balance)}, this needs ${f(amount)}.`;
  }
  if (opts.max !== undefined && opts.max > 0n && amount > opts.max) {
    return `Too much. ${opts.maxLabel ?? "The maximum"} is ${f(opts.max)} ${symbol}.`;
  }
  if (opts.min !== undefined && opts.min > 0n && amount < opts.min && amount !== opts.allowExact) {
    return `Too small. The minimum is ${f(opts.min)} ${symbol}.`;
  }
  return null;
}

export function checkDuration(seconds: number | null, min: number, max: number, maxLabel = "The maximum"): string | null {
  if (seconds === null) return "Enter a term.";
  if (seconds < min) return `Too short. The minimum term is ${formatDuration(min)}.`;
  if (seconds > max) return `Too long. ${maxLabel} is ${formatDuration(max)}.`;
  return null;
}

export function checkBtc(amount: bigint | null, raw: string, opts: { max?: bigint; balance?: bigint; min?: bigint }): string | null {
  if (!raw.trim()) return null;
  if (amount === null) return "Enter a BTC amount with at most 18 decimals.";
  if (amount === 0n) return "Enter an amount above zero.";
  if (opts.balance !== undefined && amount > opts.balance) {
    return `Not enough BTC. You have ${formatBtc(opts.balance)}, this needs ${formatBtc(amount)}.`;
  }
  if (opts.max !== undefined && amount > opts.max) return `Too much for one loan. The cap is ${formatBtc(opts.max)} BTC.`;
  if (opts.min !== undefined && amount < opts.min) return `Not enough collateral. This needs at least ${formatBtc(opts.min)} BTC.`;
  return null;
}

/** "Max" link next to a field label. */
export function MaxButton({ onClick, children = "Max" }: { onClick: () => void; children?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="ml-2 font-medium text-accent-text hover:underline">
      {children}
    </button>
  );
}
