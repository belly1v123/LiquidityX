"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { liquidityXVaultAbi, loanMarketplaceAbi } from "@/lib/abi";
import { getDeployment, UNLISTED_ASSET_NOTE } from "@/lib/chain";
import { termInterest } from "@/lib/finance";
import { formatAmount, formatApr, formatCr, formatDate, formatDuration, parseAmount, percentToBps, toInputString, unixNow } from "@/lib/format";
import { useAssets, usePaused, useRiskParams, useTokenBalance, useVaultPosition, type AssetLive } from "@/hooks/use-protocol";
import { phaseLabel, useTx } from "@/hooks/use-tx";
import { useNow } from "@/hooks/use-now";
import { checkAmount, checkDuration, DurationInput, MaxButton, useDurationState } from "../forms";
import { NotDeployedNotice, PausedNotice } from "../deployment-gate";
import { Button } from "../ui/button";
import { AmountInput, Field, Input, useFieldId } from "../ui/field";
import { Figure, Notice, Row, Section } from "../ui/misc";
import { Segmented } from "../ui/tabs";

function AssetPicker({ assets, value, onChange }: { assets: AssetLive[]; value: Address; onChange: (a: Address) => void }) {
  return (
    <Segmented
      label="Asset"
      value={value}
      onChange={onChange}
      options={assets.map((a) => ({ value: a.address, label: a.symbol }))}
    />
  );
}

function AssetNote({ asset, deployed }: { asset: AssetLive; deployed: boolean }) {
  return (
    <>
      {!asset.officiallyListed && <p className="text-xs text-warning">{asset.symbol}: {UNLISTED_ASSET_NOTE}.</p>}
      {deployed && !asset.enabled && <p className="text-xs text-ink-3">{asset.symbol} isn&apos;t enabled for lending right now.</p>}
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function VaultPanel({ asset }: { asset: AssetLive }) {
  const d = getDeployment();
  const { address } = useAccount();
  const pos = useVaultPosition(asset.address);
  const wallet = useTokenBalance(asset.address);
  const paused = usePaused();
  const tx = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [raw, setRaw] = useState("");
  const id = useFieldId("vault");
  const amount = parseAmount(raw, asset.decimals);
  const f = (v: bigint | undefined) => (v === undefined ? (address ? "…" : "-") : formatAmount(v, asset.decimals));

  const limit = mode === "deposit" ? wallet.data : pos.data?.available;
  const error = checkAmount({
    amount,
    raw,
    decimals: asset.decimals,
    symbol: asset.symbol,
    balance: address ? limit : undefined,
    balanceLabel: mode === "deposit" ? `${asset.symbol} in your wallet` : `available ${asset.symbol}`,
  });

  const submit = async () => {
    if (!d || !amount) return;
    const r = await tx.run(
      mode === "deposit"
        ? {
            label: `Deposit ${formatAmount(amount, asset.decimals)} ${asset.symbol}`,
            approve: { token: asset.address, spender: d.contracts.vault, amount, symbol: asset.symbol, decimals: asset.decimals },
            call: { address: d.contracts.vault, abi: liquidityXVaultAbi, functionName: "deposit", args: [asset.address, amount] },
            errorContext: { symbol: asset.symbol, decimals: asset.decimals },
            successMessage: `Deposited ${formatAmount(amount, asset.decimals)} ${asset.symbol}. It's available for offers now.`,
          }
        : {
            label: `Withdraw ${formatAmount(amount, asset.decimals)} ${asset.symbol}`,
            call: { address: d.contracts.vault, abi: liquidityXVaultAbi, functionName: "withdraw", args: [asset.address, amount] },
            errorContext: { symbol: asset.symbol, decimals: asset.decimals },
            successMessage: `Withdrew ${formatAmount(amount, asset.decimals)} ${asset.symbol} to your wallet.`,
          },
    );
    if (r) setRaw("");
  };

  const blocked = mode === "deposit" && (paused || !asset.enabled);
  return (
    <Section title="Your vault" description="Offers are funded from your available balance.">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 px-4 py-5 sm:px-5">
        <Figure label="Available" value={`${f(pos.data?.available)}`} sub={asset.symbol} />
        <Figure label="Reserved in offers" value={f(pos.data?.reserved)} sub={asset.symbol} />
        <Figure label="Lent out" value={f(pos.data?.lent)} sub={asset.symbol} />
        <Figure label="Interest earned" value={f(pos.data?.interestEarned)} sub={`${asset.symbol}, all time`} />
      </dl>
      <div className="space-y-4 border-t border-line px-4 py-5 sm:px-5">
        <Segmented
          label="Vault action"
          className="w-full"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setRaw("");
          }}
          options={[
            { value: "deposit", label: "Deposit" },
            { value: "withdraw", label: "Withdraw" },
          ]}
        />
        <Field
          label={mode === "deposit" ? "Amount to deposit" : "Amount to withdraw"}
          htmlFor={id}
          error={error}
          aside={
            address && limit !== undefined ? (
              <>
                {mode === "deposit" ? "Wallet" : "Available"} {formatAmount(limit, asset.decimals)}
                <MaxButton onClick={() => setRaw(toInputString(limit, asset.decimals))} />
              </>
            ) : null
          }
        >
          <AmountInput id={id} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={asset.symbol} invalid={!!error} />
        </Field>
        <Button className="w-full" onClick={submit} loading={tx.busy} disabled={!d || !amount || !!error || blocked}>
          {phaseLabel(tx.phase, mode === "deposit" ? "Deposit" : "Withdraw")}
        </Button>
        {mode === "deposit" && (
          <p className="text-xs text-ink-3">You approve the exact amount, then deposit. Two wallet prompts the first time.</p>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function OfferForm({ asset }: { asset: AssetLive }) {
  const d = getDeployment();
  const { address } = useAccount();
  const { risk } = useRiskParams();
  const pos = useVaultPosition(asset.address);
  const paused = usePaused();
  const tx = useTx();
  const ids = { amt: useFieldId("amt"), apr: useFieldId("apr"), dur: useFieldId("dur"), cr: useFieldId("cr"), exp: useFieldId("exp") };

  const [raw, setRaw] = useState("");
  const [apr, setApr] = useState("6");
  const dur = useDurationState(30);
  // null until the user types: follows the live protocol minimum without an effect.
  const [crInput, setCr] = useState<string | null>(null);
  const cr = crInput ?? String(risk.minInitialCrBps / 100);
  const [expDays, setExpDays] = useState("7");
  const [step, setStep] = useState<"edit" | "review">("edit");
  const now = useNow(60_000);

  const amount = parseAmount(raw, asset.decimals);
  const aprBps = percentToBps(apr);
  const crBps = percentToBps(cr);
  const expSecs = Number(expDays) > 0 ? Math.round(Number(expDays) * 86400) : null;

  const errors = {
    amount: checkAmount({
      amount,
      raw,
      decimals: asset.decimals,
      symbol: asset.symbol,
      min: asset.minLoan,
      max: asset.maxLoan,
      maxLabel: "The largest offer",
      balance: address && pos.data ? pos.data.available : undefined,
      balanceLabel: `available ${asset.symbol} in your vault`,
    }),
    apr:
      aprBps === null
        ? "Enter a percentage with at most 2 decimals."
        : aprBps < risk.minAprBps || aprBps > risk.maxAprBps
          ? `APR must be between ${formatApr(risk.minAprBps)} and ${formatApr(risk.maxAprBps)}.`
          : null,
    dur: checkDuration(dur.seconds, risk.minDuration, risk.maxDuration),
    cr:
      crBps === null
        ? "Enter a percentage."
        : crBps < risk.minInitialCrBps
          ? `At least ${formatCr(risk.minInitialCrBps)}, the protocol minimum.`
          : crBps > 65_535
            ? "At most 655%."
            : null,
    exp:
      expSecs === null
        ? "Enter how many days the offer stays open."
        : expSecs > risk.maxListingLifetime
          ? `Offers can stay open up to ${formatDuration(risk.maxListingLifetime)}.`
          : null,
  };
  const valid = !!amount && Object.values(errors).every((e) => !e);
  const interest = amount && aprBps && dur.seconds ? termInterest(amount, aprBps, dur.seconds) : null;
  const short = address && pos.data && amount && amount > pos.data.available ? amount - pos.data.available : null;

  const submit = async () => {
    if (!d || !amount || aprBps === null || crBps === null || !dur.seconds || !expSecs) return;
    const expiry = BigInt(unixNow() + expSecs);
    const r = await tx.run({
      label: `Post offer: ${formatAmount(amount, asset.decimals)} ${asset.symbol} at ${formatApr(aprBps)}`,
      call: {
        address: d.contracts.marketplace,
        abi: loanMarketplaceAbi,
        functionName: "createOffer",
        args: [asset.address, amount, aprBps, dur.seconds, crBps, expiry],
      },
      errorContext: { symbol: asset.symbol, decimals: asset.decimals },
      successMessage: "Offer posted. Borrowers can take it now.",
    });
    if (r) {
      setRaw("");
      setStep("edit");
    }
  };

  if (step === "review" && valid && amount && aprBps !== null && crBps !== null && dur.seconds && expSecs) {
    return (
      <Section title="Review your offer" description="Funds are reserved from your vault until the offer fills, expires or you cancel it.">
        <dl className="px-4 py-4 text-sm sm:px-5">
          <Row label="Amount">{formatAmount(amount, asset.decimals)} {asset.symbol}</Row>
          <Row label="APR (fixed)">{formatApr(aprBps)}</Row>
          <Row label="Longest term">{formatDuration(dur.seconds)}</Row>
          <Row label="Minimum collateral">{formatCr(crBps)}</Row>
          <Row label="Expires">{now ? formatDate(now + expSecs) : "…"}</Row>
          <Row label="Interest if fully lent for the longest term" strong>
            {interest !== null ? `${formatAmount(interest, asset.decimals)} ${asset.symbol}` : "-"}
          </Row>
        </dl>
        <div className="flex gap-2 border-t border-line px-4 py-4 sm:px-5">
          <Button variant="secondary" onClick={() => setStep("edit")} disabled={tx.busy}>
            Back
          </Button>
          <Button className="flex-1" onClick={submit} loading={tx.busy} disabled={paused}>
            {phaseLabel(tx.phase, "Post offer")}
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <Section title="Create an offer" description="Borrowers who meet your terms can take it straight away.">
      <form
        className="grid gap-5 px-4 py-5 sm:grid-cols-2 sm:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setStep("review");
        }}
        noValidate
      >
        <Field
          className="sm:col-span-2"
          label="Amount"
          htmlFor={ids.amt}
          error={errors.amount}
          hint={asset.minLoan > 0n ? `Between ${formatAmount(asset.minLoan, asset.decimals)} and ${formatAmount(asset.maxLoan, asset.decimals, { compact: true })} ${asset.symbol}.` : undefined}
          aside={
            address && pos.data ? (
              <>
                Available {formatAmount(pos.data.available, asset.decimals)}
                <MaxButton onClick={() => setRaw(toInputString(pos.data!.available, asset.decimals))} />
              </>
            ) : null
          }
        >
          <AmountInput id={ids.amt} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={asset.symbol} invalid={!!errors.amount} />
        </Field>
        <Field label="APR" htmlFor={ids.apr} error={errors.apr}>
          <Input id={ids.apr} inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} suffix="%" invalid={!!errors.apr} />
        </Field>
        <Field label="Longest term" htmlFor={ids.dur} error={errors.dur}>
          <DurationInput id={ids.dur} state={dur} invalid={!!errors.dur} />
        </Field>
        <Field label="Minimum collateral ratio" htmlFor={ids.cr} error={errors.cr} hint={`Protocol minimum is ${formatCr(risk.minInitialCrBps)}.`}>
          <Input id={ids.cr} inputMode="decimal" value={cr} onChange={(e) => setCr(e.target.value)} suffix="%" invalid={!!errors.cr} />
        </Field>
        <Field label="Offer stays open for" htmlFor={ids.exp} error={errors.exp}>
          <Input id={ids.exp} inputMode="decimal" value={expDays} onChange={(e) => setExpDays(e.target.value)} suffix="days" invalid={!!errors.exp} />
        </Field>
        <div className="rounded-lg bg-surface px-4 py-3 text-sm sm:col-span-2">
          <p className="text-ink-2">
            {interest !== null && dur.seconds ? (
              <>
                If fully lent for {formatDuration(dur.seconds)}, you earn{" "}
                <span className="num font-medium text-ink">{formatAmount(interest, asset.decimals)} {asset.symbol}</span>. Borrowers can
                choose shorter terms and repay early; you earn for the time it&apos;s out.
              </>
            ) : (
              "Enter an amount to see what you'd earn."
            )}
          </p>
        </div>
        {short !== null && (
          <p className="text-xs text-ink-2 sm:col-span-2">Deposit {formatAmount(short, asset.decimals)} more {asset.symbol} into your vault first.</p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" size="lg" className="w-full" disabled={!d || !valid || paused || !asset.enabled}>
            Review offer
          </Button>
        </div>
      </form>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

export function LendView() {
  const { assets } = useAssets();
  const [assetAddr, setAssetAddr] = useState<Address>(assets[0].address);
  const asset = assets.find((a) => a.address === assetAddr) ?? assets[0];
  const paused = usePaused();
  const { risk } = useRiskParams();
  const deployed = !!getDeployment();
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Lend</h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-ink-2">
            Deposit stablecoins, then post an offer with your rate and terms. You can also{" "}
            <Link href="/marketplace?tab=requests" className="text-ink underline underline-offset-2">fund an open request</Link> directly.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <AssetPicker assets={assets} value={asset.address} onChange={setAssetAddr} />
          <AssetNote asset={asset} deployed={deployed} />
        </div>
      </div>
      <div className="space-y-6">
        <NotDeployedNotice />
        <PausedNotice paused={paused} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <VaultPanel asset={asset} key={`v-${asset.address}`} />
        <OfferForm asset={asset} key={`o-${asset.address}`} />
      </div>
      </div>
      {deployed && (
        <Notice className="mt-6" title="How you get paid">
          Each repayment lands in your vault&apos;s available balance, interest first. If a loan is liquidated, you receive BTC
          collateral worth the debt plus a {formatApr(risk.liquidationBonusBps)} bonus, in your free BTC balance on the Borrow page.
        </Notice>
      )}
    </div>
  );
}
