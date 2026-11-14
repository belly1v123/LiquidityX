"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { collateralManagerAbi, loanMarketplaceAbi } from "@/lib/abi";
import { COLLATERAL_LABEL, getDeployment, UNLISTED_ASSET_NOTE } from "@/lib/chain";
import { collateralRatioBps, liquidationPrice, maxBorrow, minCollateral, termInterest } from "@/lib/finance";
import {
  formatAmount,
  formatApr,
  formatBtc,
  formatCr,
  formatDate,
  formatDuration,
  formatUsd,
  parseAmount,
  percentToBps,
  toInputString,
  unixNow,
} from "@/lib/format";
import { useAssets, useFreeCollateral, useNativeBalance, useOraclePrice, usePaused, useRiskParams, type AssetLive } from "@/hooks/use-protocol";
import { phaseLabel, useTx } from "@/hooks/use-tx";
import { useNow } from "@/hooks/use-now";
import { crTone, PriceLine } from "../domain";
import { checkAmount, checkBtc, checkDuration, DurationInput, MaxButton, useDurationState } from "../forms";
import { NotDeployedNotice, PausedNotice } from "../deployment-gate";
import { Button } from "../ui/button";
import { AmountInput, Field, Input, useFieldId } from "../ui/field";
import { Figure, Notice, Row, Section, Status } from "../ui/misc";
import { Segmented } from "../ui/tabs";

// ---------------------------------------------------------------------------------------------

function CollateralPanel() {
  const d = getDeployment();
  const { address } = useAccount();
  const free = useFreeCollateral();
  const wallet = useNativeBalance();
  const tx = useTx();
  const [raw, setRaw] = useState("");
  const id = useFieldId("wd");
  const amount = parseAmount(raw, 18);
  const error = checkBtc(amount, raw, { balance: address ? free.data : undefined });
  const submit = async () => {
    if (!d || !amount) return;
    const r = await tx.run({
      label: `Withdraw ${formatBtc(amount)} BTC`,
      call: { address: d.contracts.collateral, abi: collateralManagerAbi, functionName: "withdrawCollateral", args: [amount] },
      successMessage: `${formatBtc(amount)} BTC sent to your wallet.`,
    });
    if (r) setRaw("");
  };
  return (
    <Section title="Your BTC" description={`Collateral is ${COLLATERAL_LABEL}, the chain's native coin.`}>
      <div className="px-4 py-5 sm:px-5">
        <PriceLine />
        <dl className="mt-5 grid grid-cols-2 gap-4">
          <Figure label="In your wallet" value={address ? (wallet.data ? formatBtc(wallet.data.value) : "…") : "-"} sub="BTC" />
          <Figure label="Free in LiquidityX" value={address ? (free.data !== undefined ? formatBtc(free.data) : d ? "…" : "0") : "-"} sub="BTC, withdrawable" />
        </dl>
      </div>
      <div className="space-y-4 border-t border-line px-4 py-5 sm:px-5">
        <p className="text-xs text-ink-2">
          BTC comes back here when a loan is repaid, a request is cancelled, or a liquidation leaves some over.
        </p>
        <Field
          label="Withdraw free BTC"
          htmlFor={id}
          error={error}
          aside={free.data ? <MaxButton onClick={() => setRaw(toInputString(free.data!, 18))} /> : null}
        >
          <AmountInput id={id} value={raw} onChange={(e) => setRaw(e.target.value)} suffix="BTC" invalid={!!error} />
        </Field>
        <Button variant="secondary" className="w-full" onClick={submit} loading={tx.busy} disabled={!d || !amount || !!error}>
          {phaseLabel(tx.phase, "Withdraw to wallet")}
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function RequestForm({ asset }: { asset: AssetLive }) {
  const d = getDeployment();
  const { address } = useAccount();
  const { risk } = useRiskParams();
  const price = useOraclePrice();
  const free = useFreeCollateral();
  const wallet = useNativeBalance();
  const paused = usePaused();
  const tx = useTx();
  const ids = { amt: useFieldId("amt"), col: useFieldId("col"), apr: useFieldId("apr"), dur: useFieldId("dur"), exp: useFieldId("exp") };

  const [raw, setRaw] = useState("");
  const [collRaw, setCollRaw] = useState("");
  const [apr, setApr] = useState("8");
  const dur = useDurationState(30);
  const [expDays, setExpDays] = useState("7");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const now = useNow(60_000);

  const amount = parseAmount(raw, asset.decimals);
  const coll = parseAmount(collRaw, 18);
  const aprBps = percentToBps(apr);
  const expSecs = Number(expDays) > 0 ? Math.round(Number(expDays) * 86400) : null;
  const freeBal = free.data ?? 0n;
  const usable = (wallet.data?.value ?? 0n) + freeBal;
  const fromWallet = coll !== null && coll > freeBal ? coll - freeBal : 0n;

  const p = price.price;
  const cr = coll && amount && p ? collateralRatioBps(coll, p, amount, asset.decimals) : null;
  const max = coll && p ? maxBorrow(coll, p, risk.minInitialCrBps, asset.decimals) : null;
  const need = amount && p ? minCollateral(amount, p, risk.minInitialCrBps, asset.decimals) : null;
  const interest = amount && aprBps && dur.seconds ? termInterest(amount, aprBps, dur.seconds) : null;
  const liq = coll && amount ? liquidationPrice(amount + (interest ?? 0n), asset.decimals, coll, risk.liquidationCrBps) : null;
  const drop = liq && p ? Number(((p - liq) * 10_000n) / p) / 100 : null;

  const errors = {
    amount: checkAmount({
      amount,
      raw,
      decimals: asset.decimals,
      symbol: asset.symbol,
      min: asset.minLoan,
      max: asset.maxLoan,
      maxLabel: "The largest request",
    }),
    coll:
      checkBtc(coll, collRaw, { balance: address ? usable : undefined, max: risk.maxCollateralPerLoan }) ??
      (need && coll && coll < need ? `Not enough collateral. ${formatAmount(amount!, asset.decimals)} ${asset.symbol} needs at least ${formatBtc(need)} BTC (${formatCr(risk.minInitialCrBps)}).` : null),
    apr:
      aprBps === null
        ? "Enter a percentage with at most 2 decimals."
        : aprBps < risk.minAprBps || aprBps > risk.maxAprBps
          ? `APR must be between ${formatApr(risk.minAprBps)} and ${formatApr(risk.maxAprBps)}.`
          : null,
    dur: checkDuration(dur.seconds, risk.minDuration, risk.maxDuration),
    exp:
      expSecs === null
        ? "Enter how many days the request stays open."
        : expSecs > risk.maxListingLifetime
          ? `Requests can stay open up to ${formatDuration(risk.maxListingLifetime)}.`
          : null,
  };
  const valid = !!amount && !!coll && Object.values(errors).every((e) => !e);
  const thin = cr !== null && cr < BigInt(risk.minInitialCrBps + 2000);

  const submit = async () => {
    if (!d || !amount || !coll || aprBps === null || !dur.seconds || !expSecs) return;
    const expiry = BigInt(unixNow() + expSecs);
    const r = await tx.run({
      label: `Request ${formatAmount(amount, asset.decimals)} ${asset.symbol}`,
      call: {
        address: d.contracts.marketplace,
        abi: loanMarketplaceAbi,
        functionName: "createRequest",
        args: [asset.address, amount, aprBps, dur.seconds, coll, expiry],
        value: fromWallet,
      },
      errorContext: { symbol: asset.symbol, decimals: asset.decimals },
      successMessage: "Request posted. Lenders can fund it now.",
    });
    if (r) {
      setRaw("");
      setCollRaw("");
      setStep("edit");
    }
  };

  const preview = (
    <dl className="text-sm">
      <Row label="Collateral ratio">{cr !== null ? <Status tone={crTone(cr, risk.liquidationCrBps, risk.minInitialCrBps)}>{formatCr(cr)}</Status> : "-"}</Row>
      <Row label={`Most you can borrow at ${formatCr(risk.minInitialCrBps)}`}>{max !== null ? `${formatAmount(max, asset.decimals)} ${asset.symbol}` : "-"}</Row>
      <Row label="Liquidated if BTC falls below">
        {liq ? (
          <>
            {formatUsd(liq)}
            {drop !== null && drop > 0 && <span className="ml-1 text-ink-3">({drop.toFixed(1)}% below now)</span>}
          </>
        ) : (
          "-"
        )}
      </Row>
      <Row label="Interest at your max APR">{interest !== null ? `${formatAmount(interest, asset.decimals)} ${asset.symbol}` : "-"}</Row>
      <Row label="Repay at most" strong>
        {interest !== null && amount ? `${formatAmount(amount + interest, asset.decimals)} ${asset.symbol}` : "-"}
      </Row>
    </dl>
  );

  if (step === "review" && valid && amount && coll && aprBps !== null && dur.seconds && expSecs) {
    return (
      <Section title="Review your request" description="Your BTC is locked when you post. Cancel any time before it fills to get it back.">
        <dl className="border-b border-line px-4 py-4 text-sm sm:px-5">
          <Row label="Borrow">{formatAmount(amount, asset.decimals)} {asset.symbol}</Row>
          <Row label="Lock">{formatBtc(coll)} BTC</Row>
          <Row label="Most APR you'll pay">{formatApr(aprBps)}</Row>
          <Row label="Term">{formatDuration(dur.seconds)}</Row>
          <Row label="Request expires">{now ? formatDate(now + expSecs) : "…"}</Row>
          <Row label="BTC sent from wallet">{formatBtc(fromWallet)} BTC</Row>
        </dl>
        <div className="px-4 py-3 sm:px-5">{preview}</div>
        <div className="flex gap-2 border-t border-line px-4 py-4 sm:px-5">
          <Button variant="secondary" onClick={() => setStep("edit")} disabled={tx.busy}>
            Back
          </Button>
          <Button className="flex-1" onClick={submit} loading={tx.busy} disabled={paused || !price.ok}>
            {phaseLabel(tx.phase, "Post request")}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Request a loan" description="Lock BTC, name the most APR you'll pay, and lenders fill it in one or more parts.">
      <form
        className="grid gap-5 px-4 py-5 sm:grid-cols-2 sm:px-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setStep("review");
        }}
      >
        <Field
          label="Borrow"
          htmlFor={ids.amt}
          error={errors.amount}
          aside={max ? <MaxButton onClick={() => setRaw(toInputString(max, asset.decimals, 2))}>Max {formatAmount(max, asset.decimals)}</MaxButton> : null}
        >
          <AmountInput id={ids.amt} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={asset.symbol} invalid={!!errors.amount} />
        </Field>
        <Field
          label="BTC to lock"
          htmlFor={ids.col}
          error={errors.coll}
          hint={freeBal > 0n ? `Uses your ${formatBtc(freeBal)} free BTC first.` : undefined}
          aside={
            need ? (
              <MaxButton onClick={() => setCollRaw(toInputString((need * 125n) / 100n, 18, 8))}>Use {formatBtc((need * 125n) / 100n)}</MaxButton>
            ) : null
          }
        >
          <AmountInput id={ids.col} value={collRaw} onChange={(e) => setCollRaw(e.target.value)} suffix="BTC" invalid={!!errors.coll} />
        </Field>
        <Field label="Most APR you'll pay" htmlFor={ids.apr} error={errors.apr}>
          <Input id={ids.apr} inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} suffix="%" invalid={!!errors.apr} />
        </Field>
        <Field label="Term" htmlFor={ids.dur} error={errors.dur}>
          <DurationInput id={ids.dur} state={dur} invalid={!!errors.dur} />
        </Field>
        <Field label="Request stays open for" htmlFor={ids.exp} error={errors.exp}>
          <Input id={ids.exp} inputMode="decimal" value={expDays} onChange={(e) => setExpDays(e.target.value)} suffix="days" invalid={!!errors.exp} />
        </Field>
        <div className="rounded-lg bg-surface px-4 py-2 sm:col-span-2">{preview}</div>
        {thin && (
          <Notice tone="warning" className="sm:col-span-2">
            This is close to the minimum. A small BTC price drop could put it near liquidation. Lock more BTC for headroom.
          </Notice>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" size="lg" className="w-full" disabled={!d || !valid || paused || !asset.enabled || !price.ok}>
            Review request
          </Button>
          <p className="mt-2 text-xs text-ink-3">
            Want a loan now instead? <Link href="/marketplace?tab=offers" className="text-ink underline underline-offset-2">Take an open offer</Link>.
          </p>
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function BorrowView() {
  const { assets } = useAssets();
  const [assetAddr, setAssetAddr] = useState<Address>(assets[0].address);
  const asset = assets.find((a) => a.address === assetAddr) ?? assets[0];
  const paused = usePaused();
  const deployed = !!getDeployment();
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Borrow</h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-ink-2">Borrow stablecoins against BTC at a fixed rate. Your BTC comes back when you repay.</p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <Segmented label="Asset" value={asset.address} onChange={setAssetAddr} options={assets.map((a) => ({ value: a.address, label: a.symbol }))} />
          {!asset.officiallyListed && <p className="text-xs text-warning">{asset.symbol}: {UNLISTED_ASSET_NOTE}.</p>}
          {deployed && !asset.enabled && <p className="text-xs text-ink-3">{asset.symbol} isn&apos;t enabled for loans right now.</p>}
        </div>
      </div>
      <div className="space-y-6">
        <NotDeployedNotice />
        <PausedNotice paused={paused} />
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
          <div className="order-2 lg:order-1">
            <CollateralPanel />
          </div>
          <div className="order-1 lg:order-2">
            <RequestForm asset={asset} key={asset.address} />
          </div>
        </div>
      </div>
    </div>
  );
}
