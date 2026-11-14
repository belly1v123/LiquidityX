"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";
import { collateralManagerAbi, liquidationEngineAbi, liquidityXVaultAbi, loanManagerAbi } from "@/lib/abi";
import type { ActivityDTO, LoanStatus } from "@/lib/api-types";
import { activeChainId, getDeployment, PRICE_SOURCE_LABEL } from "@/lib/chain";
import { collateralUsd, liquidationPrice, MAX_UINT256, owedAt } from "@/lib/finance";
import {
  formatAmount,
  formatApr,
  formatBtc,
  formatCountdown,
  formatCr,
  formatDate,
  formatDateTime,
  formatDuration,
  formatUsd,
  parseAmount,
  percentOf,
  toInputString,
} from "@/lib/format";
import { useLoanDetail } from "@/hooks/use-api";
import { useNow } from "@/hooks/use-now";
import { useFreeCollateral, useOraclePrice, useRiskParams, useTokenBalance, useVaultPosition } from "@/hooks/use-protocol";
import { phaseLabel, useTx } from "@/hooks/use-tx";
import { assetMeta, crTone, LoanStatusLabel, PriceLine } from "../domain";
import { NotDeployedNotice } from "../deployment-gate";
import { checkAmount, MaxButton } from "../forms";
import { Button, ButtonLink } from "../ui/button";
import { AmountInput, Field, useFieldId } from "../ui/field";
import { AddressLink, EmptyState, Figure, Notice, Row, Section, Skeleton, Status, TxHashLink } from "../ui/misc";
import { Segmented } from "../ui/tabs";
import { activityLabel } from "../activity/activity-labels";

const STATUS: Record<number, LoanStatus> = { 1: "active", 2: "repaid", 3: "liquidated" };
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function LoanView({ id }: { id: string }) {
  const d = getDeployment();
  const valid = /^\d+$/.test(id) && BigInt(id) > 0n;
  const loanId = valid ? BigInt(id) : 0n;
  const { address } = useAccount();
  const now = useNow(1000);
  const { risk } = useRiskParams();
  const price = useOraclePrice();

  const chain = useReadContract({
    address: d?.contracts.loans,
    abi: loanManagerAbi,
    functionName: "getLoan",
    args: [loanId],
    chainId: activeChainId,
    query: { enabled: !!d && valid, refetchInterval: 20_000 },
  });
  const health = useReadContract({
    address: d?.contracts.liquidation,
    abi: liquidationEngineAbi,
    functionName: "health",
    args: [loanId],
    chainId: activeChainId,
    query: { enabled: !!d && valid && chain.data?.status === 1, refetchInterval: 20_000 },
  });
  const api = useLoanDetail(valid ? id : undefined);

  if (!d) {
    return (
      <Frame title={`Loan #${id}`}>
        <NotDeployedNotice />
      </Frame>
    );
  }
  if (!valid || (chain.data && chain.data.status === 0)) {
    return (
      <Frame title="Loan not found">
        <EmptyState title={`There is no loan #${id}.`} action={<ButtonLink href="/portfolio" variant="secondary">Go to portfolio</ButtonLink>}>
          Loan numbers start at 1. Check the link, or find your loans on your portfolio.
        </EmptyState>
      </Frame>
    );
  }
  if (chain.isLoading || !chain.data) {
    return (
      <Frame title={`Loan #${id}`}>
        {chain.error ? (
          <Notice tone="danger" title="Couldn't read this loan" action={<Button size="sm" variant="secondary" onClick={() => chain.refetch()}>Retry</Button>}>
            {(chain.error as Error).message.split("\n")[0]}
          </Notice>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <Skeleton className="h-72 w-full rounded-lg" />
            <Skeleton className="h-72 w-full rounded-lg" />
          </div>
        )}
      </Frame>
    );
  }

  const L = chain.data;
  const meta = assetMeta(L.asset);
  const f = (v: bigint) => formatAmount(v, meta.decimals);
  let status = STATUS[L.status] ?? "active";
  if (status === "active" && now && now > Number(L.maturity)) status = "overdue";
  const active = L.status === 1;
  const isBorrower = same(address, L.borrower);
  const isLender = same(address, L.lender);

  // Live estimate, ticking client-side. The contract recomputes the exact figure at repayment.
  const owed = active && now ? owedAt(L, now) : { principal: L.outstandingPrincipal, interest: L.accruedInterest, total: L.outstandingPrincipal + L.accruedInterest };
  const crBps = health.data ? health.data[0] : null;
  const reason = health.data ? health.data[1] : 0;
  const priceOk = health.data ? health.data[2] : price.ok;
  const liq = active ? liquidationPrice(owed.total, meta.decimals, L.collateral, risk.liquidationCrBps) : null;
  const collUsd = price.price ? collateralUsd(L.collateral, price.price) : null;
  const graceEnd = Number(L.maturity) + risk.gracePeriod;
  const repaidPct = percentOf(L.principalRepaid, L.principal);

  return (
    <Frame
      title={`Loan #${id}`}
      status={<LoanStatusLabel status={status} liquidatable={reason === 1 ? "undercollateralized" : reason === 2 ? "overdue" : "none"} />}
      subtitle={
        <>
          <span className="num">{f(L.principal)} {meta.symbol}</span> at <span className="num">{formatApr(L.aprBps)}</span> for{" "}
          {formatDuration(Number(L.maturity - L.start))}. Lender <AddressLink address={L.lender} you={isLender} />, borrower{" "}
          <AddressLink address={L.borrower} you={isBorrower} />.
        </>
      }
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Section>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-6 px-4 py-5 sm:grid-cols-3 sm:px-5">
              <Figure
                size="lg"
                className="col-span-2 sm:col-span-1"
                label={active ? "Owed now (estimate)" : "Owed"}
                value={
                  <>
                    {active ? formatAmount(owed.total, meta.decimals, { maxDp: 6, minDp: Math.min(6, meta.decimals) }) : f(owed.total)}{" "}
                    <span className="text-base text-ink-3">{meta.symbol}</span>
                  </>
                }
                sub={active ? "Ticks every second" : status === "repaid" ? "Repaid in full" : "Closed by liquidation"}
              />
              <Figure label="Principal outstanding" value={f(owed.principal)} sub={meta.symbol} />
              <Figure label="Interest unpaid" value={f(owed.interest)} sub={`${meta.symbol}, paid ${f(L.interestPaid)} so far`} />
              <Figure
                label="Collateral"
                value={`${formatBtc(L.collateral)} BTC`}
                sub={!active ? (status === "repaid" ? "Returned to the borrower" : "Split on liquidation") : collUsd ? `${formatUsd(collUsd)} now` : undefined}
              />
              <Figure
                label="Collateral ratio"
                value={
                  active && crBps !== null ? (
                    <Status tone={crTone(crBps, risk.liquidationCrBps, risk.minInitialCrBps)} className="text-lg">
                      {formatCr(crBps)}
                    </Status>
                  ) : (
                    "-"
                  )
                }
                sub={active ? `Liquidation below ${formatCr(risk.liquidationCrBps)}` : undefined}
              />
              <Figure
                label={active ? (now > Number(L.maturity) ? "Overdue by" : "Due in") : "Closed"}
                value={
                  active
                    ? now
                      ? now > Number(L.maturity)
                        ? formatCountdown(now, Number(L.maturity))
                        : formatCountdown(Number(L.maturity), now)
                      : "…"
                    : formatDate(Number(L.closedAt))
                }
                sub={active ? formatDateTime(Number(L.maturity)) : undefined}
              />
            </dl>
            <div className="border-t border-line px-4 py-4 sm:px-5">
              <div className="flex items-baseline justify-between text-xs text-ink-3">
                <span>Principal repaid</span>
                <span className="num text-ink-2">
                  {f(L.principalRepaid)} of {f(L.principal)} {meta.symbol}
                </span>
              </div>
              <div
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
                role="progressbar"
                aria-label="Principal repaid"
                aria-valuenow={Math.round(repaidPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${repaidPct}%` }} />
              </div>
            </div>
          </Section>

          {active && (reason !== 0 || (crBps !== null && crBps < BigInt(Math.round((risk.liquidationCrBps + risk.minInitialCrBps) / 2)))) && (
            <Notice tone={reason !== 0 ? "danger" : "warning"} role="alert" title={reason === 1 ? "Below the liquidation line" : reason === 2 ? "Past the grace period" : "Getting close to the liquidation line"}>
              {reason === 1 && <>The collateral ratio is under {formatCr(risk.liquidationCrBps)}. The lender can liquidate now. Repaying part of the loan raises the ratio.</>}
              {reason === 2 && <>The loan was due {formatDate(Number(L.maturity))} and the grace period has ended. The lender can liquidate now.</>}
              {reason === 0 && liq && <>It would be liquidated if BTC falls below {formatUsd(liq)}. Repaying part of it gives more room.</>}
            </Notice>
          )}

          <Section title="Terms">
            <dl className="grid gap-x-8 px-4 py-3 text-sm sm:grid-cols-2 sm:px-5">
              <Row label="APR (fixed)">{formatApr(L.aprBps)}</Row>
              <Row label="Started">{formatDateTime(Number(L.start))}</Row>
              <Row label="Due">{formatDateTime(Number(L.maturity))}</Row>
              <Row label="Grace period ends">{formatDateTime(graceEnd)}</Row>
              <Row label="Liquidation price">{liq ? formatUsd(liq) : "-"}</Row>
              <Row label="From">
                {L.offerId > 0n ? `Offer #${L.offerId}` : ""}
                {L.offerId > 0n && L.requestId > 0n ? ", " : ""}
                {L.requestId > 0n ? `Request #${L.requestId}` : ""}
              </Row>
            </dl>
            <div className="border-t border-line px-4 py-3 sm:px-5">
              <PriceLine />
              {!priceOk && <p className="mt-1 text-xs text-warning">Liquidation is on hold until the {PRICE_SOURCE_LABEL} updates. Repayment still works.</p>}
            </div>
          </Section>

          <History items={api.data?.activity} loading={api.isLoading} error={api.error as Error | null} asset={L.asset} />
        </div>

        <div className="order-first space-y-6 lg:order-none lg:sticky lg:top-20">
          {isBorrower && active && <RepayPanel loanId={loanId} loan={L} />}
          {isBorrower && !active && <BorrowerClosedPanel />}
          {isLender && active && reason !== 0 && <LiquidatePanel loanId={loanId} asset={L.asset} />}
          {isLender && <LenderVaultPanel asset={L.asset} />}
          {!isBorrower && !isLender && (
            <Notice title={address ? "You're not part of this loan" : "Connect to act on this loan"}>
              The borrower can repay here and the lender can withdraw or liquidate. Everyone can follow its progress.
            </Notice>
          )}
        </div>
      </div>
    </Frame>
  );
}

function Frame({ title, status, subtitle, children }: { title: string; status?: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <nav aria-label="Breadcrumb" className="mb-3 text-xs text-ink-3">
        <Link href="/portfolio" className="hover:text-ink">Portfolio</Link> <span aria-hidden>/</span> <span>{title}</span>
      </nav>
      <div className="pb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {status}
        </div>
        {subtitle && <p className="mt-1.5 max-w-[80ch] text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

type LoanTuple = {
  asset: Address;
  outstandingPrincipal: bigint;
  accruedInterest: bigint;
  aprBps: number;
  lastAccrual: bigint;
};

function RepayPanel({ loanId, loan }: { loanId: bigint; loan: LoanTuple }) {
  const d = getDeployment()!;
  const meta = assetMeta(loan.asset);
  const now = useNow(5000);
  const wallet = useTokenBalance(loan.asset);
  const tx = useTx();
  const id = useFieldId("repay");
  const [mode, setMode] = useState<"full" | "part">("full");
  const [raw, setRaw] = useState("");
  const owedNow = now ? owedAt(loan, now).total : loan.outstandingPrincipal + loan.accruedInterest;
  // Full repayment approves what will be owed 10 minutes from now; the contract only pulls the exact amount.
  const fullApproval = now ? owedAt(loan, now + 600).total : 0n;
  const amount = mode === "full" ? (fullApproval > 0n ? fullApproval : null) : parseAmount(raw, meta.decimals);
  const error =
    mode === "part"
      ? checkAmount({
          amount,
          raw,
          decimals: meta.decimals,
          symbol: meta.symbol,
          balance: wallet.data,
          max: owedNow,
          maxLabel: "What you owe",
        })
      : wallet.data !== undefined && wallet.data < owedNow
        ? `Not enough ${meta.symbol}. You have ${formatAmount(wallet.data, meta.decimals)}, this needs ${formatAmount(owedNow, meta.decimals)}.`
        : null;

  const submit = async () => {
    if (!amount) return;
    await tx.run({
      label: mode === "full" ? `Repay loan #${loanId} in full` : `Repay ${formatAmount(amount, meta.decimals)} ${meta.symbol}`,
      approve: { token: loan.asset, spender: d.contracts.vault, amount, symbol: meta.symbol, decimals: meta.decimals },
      call: {
        address: d.contracts.loans,
        abi: loanManagerAbi,
        functionName: "repay",
        args: [loanId, mode === "full" ? MAX_UINT256 : amount],
      },
      errorContext: { symbol: meta.symbol, decimals: meta.decimals },
      successMessage: mode === "full" ? "Loan repaid. Your BTC is in your free balance, ready to withdraw." : "Repayment received.",
    });
    setRaw("");
  };

  return (
    <Section title="Repay" description="Interest is paid first, then principal. Any amount, any time.">
      <div className="space-y-4 px-4 py-5 sm:px-5">
        <Segmented
          label="Repayment"
          className="w-full"
          value={mode}
          onChange={setMode}
          options={[
            { value: "full", label: "In full" },
            { value: "part", label: "Part" },
          ]}
        />
        {mode === "full" ? (
          <dl className="text-sm">
            <Row label="Owed now" strong>
              {formatAmount(owedNow, meta.decimals)} {meta.symbol}
            </Row>
            <Row label="Approval (10 min buffer)">
              {formatAmount(fullApproval, meta.decimals)} {meta.symbol}
            </Row>
            <Row label="In your wallet">{wallet.data !== undefined ? `${formatAmount(wallet.data, meta.decimals)} ${meta.symbol}` : "…"}</Row>
          </dl>
        ) : (
          <Field
            label="Amount"
            htmlFor={id}
            error={error}
            aside={wallet.data !== undefined ? <>Wallet {formatAmount(wallet.data, meta.decimals)}<MaxButton onClick={() => setRaw(toInputString(wallet.data! < owedNow ? wallet.data! : owedNow, meta.decimals))} /></> : null}
          >
            <AmountInput id={id} value={raw} onChange={(e) => setRaw(e.target.value)} suffix={meta.symbol} invalid={!!error} />
          </Field>
        )}
        {mode === "full" && error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <Button className="w-full" size="lg" onClick={submit} loading={tx.busy} disabled={!amount || !!error}>
          {phaseLabel(tx.phase, mode === "full" ? "Repay in full" : "Repay")}
        </Button>
        <p className="text-xs text-ink-3">You approve the exact amount for the vault first. LiquidityX never asks for unlimited approval.</p>
      </div>
    </Section>
  );
}

function BorrowerClosedPanel() {
  const d = getDeployment()!;
  const free = useFreeCollateral();
  const tx = useTx();
  const amount = free.data ?? 0n;
  return (
    <Section title="Your BTC" description="Collateral returned from your loans waits in your free balance.">
      <div className="space-y-4 px-4 py-5 sm:px-5">
        <Figure label="Free to withdraw" value={`${formatBtc(amount)} BTC`} />
        <Button
          className="w-full"
          onClick={() =>
            tx.run({
              label: `Withdraw ${formatBtc(amount)} BTC`,
              call: { address: d.contracts.collateral, abi: collateralManagerAbi, functionName: "withdrawCollateral", args: [amount] },
              successMessage: `${formatBtc(amount)} BTC sent to your wallet.`,
            })
          }
          loading={tx.busy}
          disabled={amount === 0n}
        >
          {phaseLabel(tx.phase, amount === 0n ? "Nothing to withdraw" : `Withdraw ${formatBtc(amount)} BTC`)}
        </Button>
      </div>
    </Section>
  );
}

function LenderVaultPanel({ asset }: { asset: Address }) {
  const d = getDeployment()!;
  const meta = assetMeta(asset);
  const pos = useVaultPosition(asset);
  const free = useFreeCollateral();
  const tx = useTx();
  const avail = pos.data?.available ?? 0n;
  const btc = free.data ?? 0n;
  return (
    <Section title="Your lender balance" description="Repayments land here straight away.">
      <div className="space-y-4 px-4 py-5 sm:px-5">
        <dl className="grid grid-cols-2 gap-4">
          <Figure label="Available" value={formatAmount(avail, meta.decimals)} sub={meta.symbol} />
          <Figure label="Interest earned" value={formatAmount(pos.data?.interestEarned ?? 0n, meta.decimals)} sub={`${meta.symbol}, all time`} />
        </dl>
        <Button
          className="w-full"
          variant="secondary"
          disabled={avail === 0n}
          loading={tx.busy}
          onClick={() =>
            tx.run({
              label: `Withdraw ${formatAmount(avail, meta.decimals)} ${meta.symbol}`,
              call: { address: d.contracts.vault, abi: liquidityXVaultAbi, functionName: "withdraw", args: [asset, avail] },
              errorContext: { symbol: meta.symbol, decimals: meta.decimals },
              successMessage: `${formatAmount(avail, meta.decimals)} ${meta.symbol} sent to your wallet.`,
            })
          }
        >
          {phaseLabel(tx.phase, avail === 0n ? "Nothing to withdraw" : `Withdraw ${formatAmount(avail, meta.decimals)} ${meta.symbol}`)}
        </Button>
        {btc > 0n && (
          <p className="text-xs text-ink-2">
            You also have {formatBtc(btc)} free BTC from liquidations. <Link href="/borrow" className="underline">Withdraw it on the Borrow page</Link>.
          </p>
        )}
      </div>
    </Section>
  );
}

function LiquidatePanel({ loanId, asset }: { loanId: bigint; asset: Address }) {
  const d = getDeployment()!;
  const meta = assetMeta(asset);
  const tx = useTx();
  const preview = useReadContract({
    address: d.contracts.liquidation,
    abi: liquidationEngineAbi,
    functionName: "previewLiquidation",
    args: [loanId],
    chainId: activeChainId,
    query: { refetchInterval: 15_000 },
  });
  const p = preview.data;
  return (
    <Section title="Liquidate" description="This loan is eligible. You're paid in BTC from its collateral.">
      <div className="space-y-4 px-4 py-5 sm:px-5">
        {preview.error ? (
          <p className="text-sm text-warning">Can&apos;t preview right now: the BTC price may be stale.</p>
        ) : (
          <dl className="text-sm">
            <Row label="Debt">{p ? `${formatAmount(p[0], meta.decimals)} ${meta.symbol}` : "…"}</Row>
            <Row label="You receive" strong>{p ? `${formatBtc(p[1])} BTC` : "…"}</Row>
            <Row label="Returned to borrower">{p ? `${formatBtc(p[2])} BTC` : "…"}</Row>
          </dl>
        )}
        <Button
          variant="danger"
          className="w-full"
          loading={tx.busy}
          disabled={!p}
          onClick={() =>
            tx.run({
              label: `Liquidate loan #${loanId}`,
              call: { address: d.contracts.liquidation, abi: liquidationEngineAbi, functionName: "liquidate", args: [loanId] },
              successMessage: "Loan liquidated. The BTC is in your free balance on the Borrow page.",
            })
          }
        >
          {phaseLabel(tx.phase, "Liquidate")}
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------

function History({ items, loading, error, asset }: { items?: ActivityDTO[]; loading: boolean; error: Error | null; asset: string }) {
  const meta = assetMeta(asset);
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => b.timestamp - a.timestamp), [items]);
  return (
    <Section title="History">
      {loading ? (
        <div className="space-y-3 px-5 py-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : error ? (
        <p className="px-5 py-5 text-sm text-ink-2">History isn&apos;t available right now. The figures above are read straight from the contracts.</p>
      ) : !sorted.length ? (
        <p className="px-5 py-5 text-sm text-ink-2">No events indexed yet. They appear a few seconds after each transaction.</p>
      ) : (
        <ol className="divide-y divide-line">
          {sorted.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5">
              <span className="text-ink">
                {activityLabel(a.kind)}
                {a.amount && a.kind !== "loan_repaid" && <span className="num text-ink-2"> · {formatAmount(a.amount, meta.decimals)} {meta.symbol}</span>}
                {a.btcAmount && <span className="num text-ink-2"> · {formatBtc(a.btcAmount)} BTC</span>}
              </span>
              <span className="flex items-baseline gap-3 text-xs text-ink-3">
                <span className="num">{formatDateTime(a.timestamp)}</span>
                <TxHashLink hash={a.txHash} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
