/**
 * FROZEN. Exact TypeScript mirror of the on-chain math in contracts/src (see contracts/src/interfaces/ILiquidityX.sol).
 * bigint only. The contract is the source of truth; these helpers exist for previews and display.
 * Units: APR/ratios in bps (10_000 = 100%), YEAR = 365 days, price = USD per BTC with 18 decimals,
 * collateral = native BTC wei (18 dec), stablecoins valued at exactly $1.
 */
export const BPS = 10_000n;
export const YEAR = 365n * 24n * 60n * 60n;
export const WAD = 10n ** 18n;
export const MAX_UINT256 = 2n ** 256n - 1n;

const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

/** ceil(outstanding * aprBps * dt / (YEAR * BPS)) — matches LoanManager accrual (rounded up, lender's favour). */
export function accrueInterest(outstandingPrincipal: bigint, aprBps: bigint | number, dtSeconds: bigint | number): bigint {
  const dt = BigInt(dtSeconds);
  if (dt <= 0n || outstandingPrincipal === 0n) return 0n;
  return ceilDiv(outstandingPrincipal * BigInt(aprBps) * dt, YEAR * BPS);
}

export interface LoanLike {
  outstandingPrincipal: bigint;
  accruedInterest: bigint;
  aprBps: number | bigint;
  lastAccrual: bigint | number;
}

/** Mirrors LoanManager.owedAt(loanId, at). */
export function owedAt(loan: LoanLike, atSeconds: bigint | number) {
  const at = BigInt(atSeconds);
  const last = BigInt(loan.lastAccrual);
  const extra = at > last ? accrueInterest(loan.outstandingPrincipal, loan.aprBps, at - last) : 0n;
  const interest = loan.accruedInterest + extra;
  return { principal: loan.outstandingPrincipal, interest, total: loan.outstandingPrincipal + interest };
}

/** Interest for a full term on a fresh loan (display estimate for listings). */
export function termInterest(principal: bigint, aprBps: number | bigint, durationSeconds: number | bigint) {
  return accrueInterest(principal, aprBps, durationSeconds);
}

/** USD value with 18 decimals of a stablecoin amount with `decimals` decimals. */
export function assetToUsd(amount: bigint, decimals: number): bigint {
  return amount * 10n ** BigInt(18 - decimals);
}

/** USD value (18 dec) of `collateralWei` BTC at `price` (18 dec). floor. */
export function collateralUsd(collateralWei: bigint, price: bigint): bigint {
  return (collateralWei * price) / WAD;
}

/** CR in bps = collateral * price * BPS / (WAD * debtUsd), one floor. MAX_UINT256 when debt is 0. Mirrors _cr / quoteCollateralRatio. */
export function collateralRatioBps(collateralWei: bigint, price: bigint, debtAmount: bigint, decimals: number): bigint {
  const debtUsd = assetToUsd(debtAmount, decimals);
  if (debtUsd === 0n) return MAX_UINT256;
  return (collateralWei * price * BPS) / (WAD * debtUsd);
}

/** Mirrors maxBorrow: floor(collateral * price * BPS / (WAD * crBps)) converted back to asset decimals (floor). */
export function maxBorrow(collateralWei: bigint, price: bigint, crBps: bigint | number, decimals: number): bigint {
  const usd = (collateralWei * price * BPS) / (WAD * BigInt(crBps));
  return usd / 10n ** BigInt(18 - decimals);
}

/** Mirrors minCollateral: ceil(debtUsd * crBps / BPS * 1e18 / price). */
export function minCollateral(amount: bigint, price: bigint, crBps: bigint | number, decimals: number): bigint {
  const debtUsd = assetToUsd(amount, decimals);
  return ceilDiv(debtUsd * BigInt(crBps) * WAD, BPS * price);
}

/** Collateral share for a fill. Mirrors LoanMarketplace._takeFromRequest: partial shares round UP, capped at what is left. */
export function fillCollateralShare(req: { collateral: bigint; collateralRemaining: bigint; amount: bigint; filled: bigint }, fill: bigint) {
  if (fill === req.amount - req.filled) return req.collateralRemaining;
  const share = ceilDiv(req.collateral * fill, req.amount);
  return share > req.collateralRemaining ? req.collateralRemaining : share;
}

/** Liquidation split. Mirrors LiquidationEngine.previewLiquidation. */
export function liquidationSplit(debtAmount: bigint, decimals: number, collateralWei: bigint, price: bigint, bonusBps: bigint | number) {
  const debtUsd = assetToUsd(debtAmount, decimals);
  const debtBtc = ceilDiv(debtUsd * WAD, price);
  const withBonus = (debtBtc * (BPS + BigInt(bonusBps))) / BPS;
  const lenderCollateral = withBonus < collateralWei ? withBonus : collateralWei;
  return { debtBtc, lenderCollateral, borrowerCollateral: collateralWei - lenderCollateral };
}

/** Liquidation price: BTC price (18 dec) at which CR == liquidationCrBps. */
export function liquidationPrice(debtAmount: bigint, decimals: number, collateralWei: bigint, liquidationCrBps: bigint | number) {
  if (collateralWei === 0n) return 0n;
  return (assetToUsd(debtAmount, decimals) * BigInt(liquidationCrBps) * WAD) / (BPS * collateralWei);
}
