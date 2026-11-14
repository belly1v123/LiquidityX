"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { OfferDTO, RequestDTO } from "@/lib/api-types";
import { loanMarketplaceAbi } from "@/lib/abi";
import { getDeployment } from "@/lib/chain";
import {
  collateralRatioBps,
  fillCollateralShare,
  liquidationPrice,
  minCollateral,
  termInterest,
} from "@/lib/finance";
import {
  formatAmount,
  formatApr,
  formatBtc,
  formatCr,
  formatDuration,
  formatUsd,
  parseAmount,
  percentToBps,
  shortAddress,
  toInputString,
} from "@/lib/format";
import { useMatches, useOfferMatches } from "@/hooks/use-api";
import { useAssets, useFreeCollateral, useNativeBalance, useOraclePrice, useRiskParams, useVaultPosition } from "@/hooks/use-protocol";
import { phaseLabel, useTx } from "@/hooks/use-tx";
import { assetMeta, crTone } from "../domain";
import { checkAmount, checkBtc, checkDuration, DurationInput, initialTerm, MaxButton, useDurationState } from "../forms";
import { Button } from "../ui/button";
import { AmountInput, Field, Input, useFieldId } from "../ui/field";
import { EmptyState, Notice, Row, Skeleton, Status } from "../ui/misc";
import { Sheet } from "../ui/sheet";

const sameAddr = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------------------------
// Fund a request (lender, from available vault balance, at the request's max APR)
// ---------------------------------------------------------------------------------------------

export function FundRequestSheet({ request, onClose }: { request: RequestDTO | null; onClose: () => void }) {
  return (
    <Sheet open={!!request} onClose={onClose} title={request ? `Fund request #${request.id}` : ""} description="You lend from your available vault balance at an APR you choose, up to the borrower's limit.">
      {request && <FundRequestBody request={request} onDone={onClose} />}
    </Sheet>
  );
}

function FundRequestBody({ request, onDone }: { request: RequestDTO; onDone: () => void }) {
  const d = getDeployment();
  const { address } = useAccount();
  const meta = assetMeta(request.asset);
  const { assets } = useAssets();
  const live = assets.find((a) => sameAddr(a.address, request.asset));
  const { risk } = useRiskParams();
  const price = useOraclePrice();
  const vault = useVaultPosition(request.asset as `0x${string}`);
  const tx = useTx();
  const id = useFieldId("fund");

  const unfilled = BigInt(request.amount) - BigInt(request.filled);
  const [raw, setRaw] = useState(toInputString(unfilled, meta.decimals));
  const amount = parseAmount(raw, meta.decimals);
  const req = {
    amount: BigInt(request.amount),
    filled: BigInt(request.filled),
    collateral: BigInt(request.collateral),
    collateralRemaining: BigInt(request.collateralRemaining),
  };
  const share = amount && amount > 0n && amount <= unfilled ? fillCollateralShare(req, amount) : null;
  const cr = share !== null && amount && price.price ? collateralRatioBps(share, price.price, amount, meta.decimals) : null;
  // The lender picks the APR, up to the borrower's maximum (contract enforces minAprBps <= apr <= maxAprBps).
  const [aprRaw, setAprRaw] = useState(String(request.maxAprBps / 100));
  const aprBps = percentToBps(aprRaw);
  const aprError =
    aprBps === null
      ? "Enter a percentage with at most 2 decimals."
      : aprBps > request.maxAprBps
        ? `The borrower accepts at most ${formatApr(request.maxAprBps)}.`
        : aprBps < risk.minAprBps
          ? `The lowest APR is ${formatApr(risk.minAprBps)}.`
          : null;
  const interest = amount && aprBps !== null ? termInterest(amount, aprBps, request.duration) : null;
  const aprId = useFieldId("fund-apr");

  let error = checkAmount({
    amount,
    raw,
    decimals: meta.decimals,
    symbol: meta.symbol,
    max: unfilled,
    maxLabel: "The unfilled part of this request",
    min: live?.minLoan,
    allowExact: unfilled,
    balance: address ? vault.data?.available : undefined,
    balanceLabel: `available ${meta.symbol} in your vault`,
  });
  if (!error && cr !== null && cr < BigInt(risk.minInitialCrBps)) {
    error = `This fill would be at ${formatCr(cr)}. Loans need at least ${formatCr(risk.minInitialCrBps)} at today's price.`;
  }
  const own = sameAddr(address, request.borrower);

  const submit = async () => {
    if (!d || !amount || aprBps === null || aprError) return;
    const r = await tx.run({
      label: `Fund ${formatAmount(amount, meta.decimals)} ${meta.symbol} at ${formatApr(aprBps)}`,
      call: { address: d.contracts.marketplace, abi: loanMarketplaceAbi, functionName: "fundRequest", args: [BigInt(request.id), amount, aprBps] },
      errorContext: { symbol: meta.symbol, decimals: meta.decimals },
      successMessage: `Loan opened. ${formatAmount(amount, meta.decimals)} ${meta.symbol} sent to the borrower.`,
    });
    if (r) onDone();
  };

  return (
    <div className="space-y-5">
      <dl className="text-sm">
        <Row label="Borrower's max APR">{formatApr(request.maxAprBps)}</Row>
        <Row label="Term">{formatDuration(request.duration)}</Row>
        <Row label="Unfilled">{formatAmount(unfilled, meta.decimals)} {meta.symbol}</Row>
        <Row label="Your available balance">{address ? (vault.data ? `${formatAmount(vault.data.available, meta.decimals)} ${meta.symbol}` : "…") : "Connect a wallet"}</Row>
      </dl>
      <Field
        label={`Amount to lend (${meta.symbol})`}
        htmlFor={id}
        error={error}
        aside={<MaxButton onClick={() => setRaw(toInputString(vault.data && vault.data.available < unfilled ? vault.data.available : unfilled, meta.decimals))} />}
      >
        <AmountInput id={id} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={meta.symbol} invalid={!!error} />
      </Field>
      <Field label="Your APR (fixed for the loan)" htmlFor={aprId} error={aprError}>
        <Input id={aprId} inputMode="decimal" value={aprRaw} onChange={(e) => setAprRaw(e.target.value)} suffix="%" invalid={!!aprError} />
      </Field>
      <dl className="rounded-lg bg-surface px-4 py-2 text-sm">
        <Row label="BTC backing this fill">{share !== null ? `${formatBtc(share)} BTC` : "-"}</Row>
        <Row label="Collateral ratio now">{cr !== null ? <Status tone={crTone(cr, risk.liquidationCrBps, risk.minInitialCrBps)}>{formatCr(cr)}</Status> : "-"}</Row>
        <Row label="Interest if held to term" strong>
          {interest !== null ? `${formatAmount(interest, meta.decimals)} ${meta.symbol}` : "-"}
        </Row>
      </dl>
      {vault.data && amount && vault.data.available < amount && (
        <p className="text-xs text-ink-2">
          Deposit more on the <Link href="/lend" className="text-accent-text underline">Lend page</Link> first.
        </p>
      )}
      {own && <Notice tone="warning">This is your own request. You can&apos;t lend to yourself.</Notice>}
      <Button className="w-full" size="lg" onClick={submit} loading={tx.busy} disabled={!d || !amount || !!error || !!aprError || own || !price.ok}>
        {phaseLabel(tx.phase, "Fund request")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Borrow from an offer (borrower; locks BTC, sends msg.value for the part not already free)
// ---------------------------------------------------------------------------------------------

export function BorrowFromOfferSheet({ offer, onClose }: { offer: OfferDTO | null; onClose: () => void }) {
  return (
    <Sheet open={!!offer} onClose={onClose} title={offer ? `Borrow from offer #${offer.id}` : ""} description="Take this lender's terms in one transaction.">
      {offer && <BorrowFromOfferBody offer={offer} onDone={onClose} />}
    </Sheet>
  );
}

function BorrowFromOfferBody({ offer, onDone }: { offer: OfferDTO; onDone: () => void }) {
  const d = getDeployment();
  const { address } = useAccount();
  const meta = assetMeta(offer.asset);
  const { assets } = useAssets();
  const live = assets.find((a) => sameAddr(a.address, offer.asset));
  const { risk } = useRiskParams();
  const price = useOraclePrice();
  const free = useFreeCollateral();
  const native = useNativeBalance();
  const tx = useTx();
  const ids = { amt: useFieldId("amt"), dur: useFieldId("dur"), col: useFieldId("col") };

  const remaining = BigInt(offer.remaining);
  const [raw, setRaw] = useState(toInputString(remaining, meta.decimals));
  const amount = parseAmount(raw, meta.decimals);
  const dur = useDurationState(...initialTerm(offer.maxDuration));
  const requiredCr = Math.max(offer.minCrBps, risk.minInitialCrBps);
  const minColl = amount && price.price ? minCollateral(amount, price.price, requiredCr, meta.decimals) : null;
  // Suggest 10% above the minimum so a small price move doesn't revert the transaction.
  const suggested = minColl ? (minColl * 110n) / 100n : null;

  const [collRaw, setCollRaw] = useState("");
  const coll = parseAmount(collRaw, 18);
  const freeBal = free.data ?? 0n;
  const fromWallet = coll !== null && coll > freeBal ? coll - freeBal : 0n;

  const amountErr = checkAmount({
    amount,
    raw,
    decimals: meta.decimals,
    symbol: meta.symbol,
    max: remaining,
    maxLabel: "What's left in this offer",
    min: live?.minLoan,
    allowExact: remaining,
  });
  const durErr = checkDuration(dur.seconds, risk.minDuration, offer.maxDuration, "This offer's longest term");
  const collErr = checkBtc(coll, collRaw, {
    max: risk.maxCollateralPerLoan,
    min: minColl ?? undefined,
    balance: native.data ? native.data.value + freeBal : undefined,
  });
  const cr = coll && amount && price.price ? collateralRatioBps(coll, price.price, amount, meta.decimals) : null;
  const interest = amount && dur.seconds ? termInterest(amount, offer.aprBps, dur.seconds) : null;
  const liq = coll && amount ? liquidationPrice(amount + (interest ?? 0n), meta.decimals, coll, risk.liquidationCrBps) : null;
  const own = sameAddr(address, offer.lender);
  const ready = !!d && !!amount && !!coll && !!dur.seconds && !amountErr && !durErr && !collErr && !own && price.ok;

  const submit = async () => {
    if (!d || !amount || !coll || !dur.seconds) return;
    const r = await tx.run({
      label: `Borrow ${formatAmount(amount, meta.decimals)} ${meta.symbol}`,
      call: {
        address: d.contracts.marketplace,
        abi: loanMarketplaceAbi,
        functionName: "borrowFromOffer",
        args: [BigInt(offer.id), amount, dur.seconds, coll],
        value: fromWallet,
      },
      errorContext: { symbol: meta.symbol, decimals: meta.decimals },
      successMessage: `Loan opened. ${formatAmount(amount, meta.decimals)} ${meta.symbol} is in your wallet.`,
    });
    if (r) onDone();
  };

  return (
    <div className="space-y-5">
      <dl className="text-sm">
        <Row label="APR (fixed)">{formatApr(offer.aprBps)}</Row>
        <Row label="Longest term">{formatDuration(offer.maxDuration)}</Row>
        <Row label="Lender's minimum collateral">{formatCr(requiredCr)}</Row>
      </dl>
      <Field label={`Borrow (${meta.symbol})`} htmlFor={ids.amt} error={amountErr} aside={<MaxButton onClick={() => setRaw(toInputString(remaining, meta.decimals))} />}>
        <AmountInput id={ids.amt} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={meta.symbol} invalid={!!amountErr} />
      </Field>
      <Field label="Term" htmlFor={ids.dur} error={durErr}>
        <DurationInput id={ids.dur} state={dur} invalid={!!durErr} />
      </Field>
      <Field
        label="BTC to lock"
        htmlFor={ids.col}
        error={collErr}
        hint={freeBal > 0n ? `Uses your ${formatBtc(freeBal)} free BTC first, the rest comes from your wallet.` : "Sent from your wallet with the transaction."}
        aside={suggested ? <MaxButton onClick={() => setCollRaw(toInputString(suggested, 18, 8))}>Use {formatBtc(suggested)}</MaxButton> : null}
      >
        <AmountInput id={ids.col} value={collRaw} onChange={(e) => setCollRaw(e.target.value)} suffix="BTC" invalid={!!collErr} placeholder={suggested ? toInputString(suggested, 18, 8) : "0.0"} />
      </Field>
      <dl className="rounded-lg bg-surface px-4 py-2 text-sm">
        <Row label="Collateral ratio">{cr !== null ? <Status tone={crTone(cr, risk.liquidationCrBps, risk.minInitialCrBps)}>{formatCr(cr)}</Status> : "-"}</Row>
        <Row label="Liquidated if BTC falls below">{liq ? formatUsd(liq) : "-"}</Row>
        <Row label="Interest over the term">{interest !== null ? `${formatAmount(interest, meta.decimals)} ${meta.symbol}` : "-"}</Row>
        <Row label="Repay at maturity" strong>
          {interest !== null && amount ? `${formatAmount(amount + interest, meta.decimals)} ${meta.symbol}` : "-"}
        </Row>
        <Row label="BTC sent from wallet">{coll ? `${formatBtc(fromWallet)} BTC` : "-"}</Row>
      </dl>
      {own && <Notice tone="warning">This is your own offer. You can&apos;t borrow from yourself.</Notice>}
      {!price.ok && !price.isLoading && <Notice tone="warning">The BTC price is stale, so new loans are paused until it updates.</Notice>}
      <Button className="w-full" size="lg" onClick={submit} loading={tx.busy} disabled={!ready}>
        {phaseLabel(tx.phase, "Borrow")}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Match a request against offers (suggestions from /api/matches, each fill its own tx)
// ---------------------------------------------------------------------------------------------

const EXCLUDE_REASON: Record<string, string> = {
  asset: "different asset",
  apr: "APR above the request's limit",
  duration: "term shorter than this request",
  collateral: "needs more collateral than this request has",
  expired: "expired",
  self: "same wallet as the borrower",
  size: "fill would be below the minimum loan",
  not_open: "no longer open",
};

export function MatchRequestSheet({ request, onClose }: { request: RequestDTO | null; onClose: () => void }) {
  return (
    <Sheet open={!!request} onClose={onClose} title={request ? `Match request #${request.id}` : ""} description="Offers that can fill this request, cheapest first.">
      {request && <MatchRequestBody request={request} />}
    </Sheet>
  );
}

function MatchRequestBody({ request }: { request: RequestDTO }) {
  const d = getDeployment();
  const { address } = useAccount();
  const meta = assetMeta(request.asset);
  const q = useMatches(request.id);
  const tx = useTx();
  const [running, setRunning] = useState<string | null>(null);
  const isBorrower = sameAddr(address, request.borrower);

  const run = async (offerId: string, amount: bigint) => {
    if (!d) return;
    setRunning(offerId);
    await tx.run({
      label: `Fill ${formatAmount(amount, meta.decimals)} ${meta.symbol} from offer #${offerId}`,
      call: {
        address: d.contracts.marketplace,
        abi: loanMarketplaceAbi,
        functionName: "matchOfferAndRequest",
        args: [BigInt(offerId), BigInt(request.id), amount],
      },
      errorContext: { symbol: meta.symbol, decimals: meta.decimals },
      successMessage: `Loan opened from offer #${offerId}.`,
    });
    setRunning(null);
    q.refetch();
  };

  if (q.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return <Notice tone="danger" title="Couldn't load matches" action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>{(q.error as Error)?.message}</Notice>;
  }
  const m = q.data;
  const fmt = (v: string | bigint) => formatAmount(BigInt(v), meta.decimals);
  const total = BigInt(request.amount) - BigInt(request.filled);

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink">
        {m.state === "unmatched" && <>No open offer can fill this request right now.</>}
        {m.state !== "unmatched" && (
          <>
            {m.fills.length === 1 ? "Offer" : "Offers"} {m.fills.map((f) => `#${f.offerId}`).join(" and ")}{" "}
            {m.fills.length === 1 ? "fills" : "fill"} <span className="num font-medium">{fmt(m.fillable)}</span> of{" "}
            <span className="num">{fmt(total)}</span> {meta.symbol}.
            {m.state === "partially_matchable" && (
              <> <span className="num">{fmt(m.unfilled)}</span> {meta.symbol} stays open.</>
            )}
          </>
        )}
      </p>

      {m.fills.length > 0 && (
        <ol className="divide-y divide-line rounded-lg border border-line">
          {m.fills.map((f) => {
            const canRun = isBorrower || sameAddr(address, f.lender);
            return (
              <li key={f.offerId} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">
                    Offer #{f.offerId} <span className="font-normal text-ink-3">· {shortAddress(f.lender)}</span>
                  </p>
                  <p className="num mt-0.5 text-ink-2">
                    {fmt(f.amount)} {meta.symbol} at {formatApr(f.aprBps)}, {formatBtc(f.collateralShare)} BTC, {formatCr(f.crBps)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={canRun ? "primary" : "secondary"}
                  disabled={!canRun || tx.busy}
                  loading={running === f.offerId}
                  onClick={() => run(f.offerId, BigInt(f.amount))}
                  title={canRun ? undefined : "Only the borrower or this offer's lender can run this fill."}
                >
                  Run fill
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {m.fills.length > 0 && !isBorrower && (
        <p className="text-xs text-ink-3">Only the borrower, or the lender of an offer, can run a fill. Each fill is its own transaction and the contract checks every term again.</p>
      )}

      {m.excluded.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-ink-2">Not used</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {m.excluded.map((e) => (
              <li key={e.offerId}>
                Offer #{e.offerId}: {EXCLUDE_REASON[e.reason] ?? e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Match an own offer against open requests
// ---------------------------------------------------------------------------------------------

export function MatchOfferSheet({ offer, onClose }: { offer: OfferDTO | null; onClose: () => void }) {
  return (
    <Sheet open={!!offer} onClose={onClose} title={offer ? `Find borrowers for offer #${offer.id}` : ""} description="Open requests this offer can fill, best rate first.">
      {offer && <MatchOfferBody offer={offer} />}
    </Sheet>
  );
}

function MatchOfferBody({ offer }: { offer: OfferDTO }) {
  const d = getDeployment();
  const meta = assetMeta(offer.asset);
  const q = useOfferMatches(offer.id);
  const tx = useTx();
  const [running, setRunning] = useState<string | null>(null);
  const items = useMemo(() => q.data?.requests ?? [], [q.data]);

  const run = async (requestId: string, amount: bigint) => {
    if (!d) return;
    setRunning(requestId);
    await tx.run({
      label: `Fill request #${requestId}`,
      call: { address: d.contracts.marketplace, abi: loanMarketplaceAbi, functionName: "matchOfferAndRequest", args: [BigInt(offer.id), BigInt(requestId), amount] },
      errorContext: { symbol: meta.symbol, decimals: meta.decimals },
      successMessage: `Loan opened for request #${requestId}.`,
    });
    setRunning(null);
    q.refetch();
  };

  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.error) return <Notice tone="danger" title="Couldn't load requests">{(q.error as Error).message}</Notice>;
  if (!items.length) return <EmptyState title="No requests fit this offer yet">New requests that meet your APR, term and collateral terms will show up here.</EmptyState>;
  return (
    <ol className="divide-y divide-line rounded-lg border border-line">
      {items.map((r) => (
        <li key={r.requestId} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm">
            <p className="font-medium text-ink">Request #{r.requestId}</p>
            <p className="num mt-0.5 text-ink-2">
              {formatAmount(BigInt(r.amount), meta.decimals)} {meta.symbol}, {formatBtc(r.collateralShare)} BTC, {formatCr(r.crBps)}
            </p>
          </div>
          <Button size="sm" loading={running === r.requestId} disabled={tx.busy} onClick={() => run(r.requestId, BigInt(r.amount))}>
            Fill
          </Button>
        </li>
      ))}
    </ol>
  );
}
