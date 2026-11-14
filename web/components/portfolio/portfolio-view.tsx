"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import type { ActivityDTO, LoanDTO } from "@/lib/api-types";
import { getDeployment, MUSD } from "@/lib/chain";
import { formatAmount, formatApr, formatBtc, formatCountdown, formatCr, formatDate, formatDateTime } from "@/lib/format";
import { useActivity, usePortfolio } from "@/hooks/use-api";
import { useNow } from "@/hooks/use-now";
import { useFreeCollateral, useRiskParams, useVaultPosition } from "@/hooks/use-protocol";
import { Amount, assetMeta, crTone, LoanStatusLabel } from "../domain";
import { NotDeployedNotice } from "../deployment-gate";
import { Button, ButtonLink } from "../ui/button";
import { DataTable, type Column } from "../ui/data-table";
import { AddressLink, EmptyState, Figure, Notice, Section, Skeleton, Status, TxHashLink } from "../ui/misc";

const isLive = (l: LoanDTO) => l.status === "active" || l.status === "overdue";

function useLoanColumns(role: "lender" | "borrower"): Column<LoanDTO>[] {
  const { risk } = useRiskParams();
  const now = useNow(30_000);
  return [
    { key: "id", header: "Loan", cell: (l) => <Link href={`/loans/${l.id}`} className="font-medium text-ink hover:underline">#{l.id}</Link>, mobileHidden: true },
    { key: "principal", header: "Principal", align: "right", cell: (l) => <Amount value={l.principal} asset={l.asset} /> },
    { key: "apr", header: "APR", align: "right", cell: (l) => formatApr(l.aprBps) },
    { key: "owed", header: "Owed", align: "right", cell: (l) => (isLive(l) ? <Amount value={l.owed.total} asset={l.asset} /> : <span className="text-ink-3">-</span>) },
    {
      key: "cr",
      header: "CR",
      align: "right",
      cell: (l) =>
        isLive(l) && l.crBps ? (
          <Status tone={crTone(BigInt(l.crBps), risk.liquidationCrBps, risk.minInitialCrBps)} className="justify-end">{formatCr(l.crBps)}</Status>
        ) : (
          <span className="text-ink-3">-</span>
        ),
    },
    {
      key: "due",
      header: "Due",
      align: "right",
      cell: (l) => (isLive(l) && now ? (l.maturity > now ? `in ${formatCountdown(l.maturity, now)}` : <span className="text-warning">Overdue</span>) : formatDate(l.maturity)),
    },
    { key: "status", header: "Status", cell: (l) => <LoanStatusLabel status={l.status} liquidatable={l.liquidatable} />, mobileHidden: true },
    { key: "who", header: role === "lender" ? "Borrower" : "Lender", cell: (l) => <AddressLink address={role === "lender" ? l.borrower : l.lender} /> },
  ];
}

function LoansTable({ loans, role, loading }: { loans?: LoanDTO[]; role: "lender" | "borrower"; loading: boolean }) {
  const cols = useLoanColumns(role);
  const router = useRouter();
  const sorted = loans ? [...loans].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.start - a.start) : undefined;
  return (
    <DataTable
      caption={role === "lender" ? "Loans you made" : "Loans you took"}
      columns={cols}
      rows={sorted}
      rowKey={(l) => l.id}
      loading={loading}
      skeletonRows={3}
      mobileTitle={(l) => (
        <span className="flex items-center justify-between">
          <Link href={`/loans/${l.id}`} className="font-medium text-ink underline-offset-2 hover:underline">Loan #{l.id}</Link>
          <LoanStatusLabel status={l.status} liquidatable={l.liquidatable} />
        </span>
      )}
      actions={(l) => (
        <Button size="sm" variant={isLive(l) && role === "borrower" ? "primary" : "secondary"} onClick={() => router.push(`/loans/${l.id}`)}>
          {isLive(l) && role === "borrower" ? "Repay" : "Open"}
        </Button>
      )}
      empty={
        <EmptyState title={role === "lender" ? "No loans made yet" : "No loans taken yet"}>
          {role === "lender" ? (
            <>Post an offer or fund a request on the <Link href="/marketplace" className="underline">marketplace</Link>.</>
          ) : (
            <>Take an offer or post a request on the <Link href="/marketplace?tab=offers" className="underline">marketplace</Link>.</>
          )}
        </EmptyState>
      }
    />
  );
}

export function PortfolioView() {
  const { address } = useAccount();
  const { openConnectModal } = useConnectModal();
  const d = getDeployment();
  const pf = usePortfolio(address);
  const vault = useVaultPosition(MUSD.address);
  const free = useFreeCollateral();
  const repayments = useActivity({ address, kind: "repayment", pageSize: 10 });
  const now = useNow(30_000);
  const { risk } = useRiskParams();

  if (!address) {
    return (
      <Shell>
        <EmptyState title="Connect a wallet to see your portfolio" action={<Button onClick={openConnectModal}>Connect wallet</Button>}>
          Your deposits, loans, collateral and repayments, read live from the contracts.
        </EmptyState>
      </Shell>
    );
  }
  if (!d) {
    return (
      <Shell>
        <NotDeployedNotice />
      </Shell>
    );
  }

  const asLender = pf.data?.loansAsLender;
  const asBorrower = pf.data?.loansAsBorrower;
  const liveBorrow = (asBorrower ?? []).filter(isLive);
  const sum = (xs: LoanDTO[], f: (l: LoanDTO) => string) => xs.reduce((a, l) => a + BigInt(f(l)), 0n);
  // Borrower totals in MUSD units (the only enabled asset at launch); other assets listed per loan.
  const musdLoans = liveBorrow.filter((l) => l.asset.toLowerCase() === MUSD.address.toLowerCase());
  const debt = sum(musdLoans, (l) => l.owed.total);
  const interest = sum(musdLoans, (l) => l.owed.interest);
  const locked = sum(liveBorrow, (l) => l.collateral);
  const worst = liveBorrow.map((l) => (l.crBps ? BigInt(l.crBps) : null)).filter((x): x is bigint => x !== null).sort((a, b) => (a < b ? -1 : 1))[0];
  const next = liveBorrow.map((l) => l.maturity).sort((a, b) => a - b)[0];
  const v = vault.data;
  const supplied = v ? v.available + v.reserved + v.lent : undefined;
  const f = (x: bigint | undefined) => (x === undefined ? <Skeleton className="mt-1 h-6 w-20" /> : formatAmount(x, 18));

  return (
    <Shell>
      {pf.error && (
        <Notice tone="warning" className="mb-6" title="Loan list unavailable">
          Balances below are read from the contracts. Loans will show once the index responds.
        </Notice>
      )}
      <div className="space-y-10">
        <section aria-labelledby="lender-h">
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2 id="lender-h" className="text-lg font-semibold text-ink">Lending</h2>
            <ButtonLink href="/lend" variant="secondary" size="sm">Manage vault</ButtonLink>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-5">
            <Figure label="Supplied" value={f(supplied)} sub="MUSD in total" />
            <Figure label="Available" value={f(v?.available)} sub="Withdrawable" />
            <Figure label="Reserved" value={f(v?.reserved)} sub="Backing open offers" />
            <Figure label="Lent out" value={f(v?.lent)} sub="In active loans" />
            <Figure label="Interest earned" value={f(v?.interestEarned)} sub="All time" />
          </dl>
          <div className="mt-5 rounded-lg border border-line">
            <LoansTable loans={asLender} role="lender" loading={pf.isLoading} />
          </div>
        </section>

        <section aria-labelledby="borrower-h">
          <div className="mb-4 flex items-end justify-between gap-4">
            <h2 id="borrower-h" className="text-lg font-semibold text-ink">Borrowing</h2>
            <ButtonLink href="/borrow" variant="secondary" size="sm">Borrow</ButtonLink>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-5">
            <Figure label="Debt" value={pf.isLoading ? <Skeleton className="mt-1 h-6 w-20" /> : formatAmount(debt, 18)} sub="MUSD owed now" />
            <Figure label="Interest accrued" value={pf.isLoading ? <Skeleton className="mt-1 h-6 w-20" /> : formatAmount(interest, 18)} sub="MUSD unpaid" />
            <Figure label="Collateral locked" value={pf.isLoading ? <Skeleton className="mt-1 h-6 w-20" /> : formatBtc(locked)} sub={`BTC · ${formatBtc(free.data ?? 0n)} free`} />
            <Figure
              label="Lowest health"
              value={worst !== undefined ? <Status tone={crTone(worst, risk.liquidationCrBps, risk.minInitialCrBps)} className="text-lg">{formatCr(worst)}</Status> : "-"}
              sub={`Liquidation below ${formatCr(risk.liquidationCrBps)}`}
            />
            <Figure label="Next due" value={next ? (now ? (next > now ? formatCountdown(next, now) : "Overdue") : "…") : "-"} sub={next ? formatDateTime(next) : "No active loans"} />
          </dl>
          <div className="mt-5 rounded-lg border border-line">
            <LoansTable loans={asBorrower} role="borrower" loading={pf.isLoading} />
          </div>
        </section>

        <Section title="Repayment history" actions={<Link href="/activity" className="text-xs text-ink-2 hover:text-ink">All activity</Link>}>
          <RepaymentList items={repayments.data?.items} loading={repayments.isLoading} />
        </Section>
      </div>
    </Shell>
  );
}

function RepaymentList({ items, loading }: { items?: ActivityDTO[]; loading: boolean }) {
  if (loading) return <div className="space-y-3 px-5 py-5"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-1/2" /></div>;
  if (!items?.length) return <p className="px-5 py-5 text-sm text-ink-2">No repayments yet.</p>;
  return (
    <ol className="divide-y divide-line">
      {items.map((a) => {
        const m = assetMeta(a.asset);
        return (
          <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5">
            <span>
              {a.loanId && <Link href={`/loans/${a.loanId}`} className="font-medium text-ink hover:underline">Loan #{a.loanId}</Link>}
              {a.amount && <span className="num text-ink-2"> · {formatAmount(a.amount, m.decimals)} {m.symbol}</span>}
            </span>
            <span className="flex gap-3 text-xs text-ink-3">
              <span className="num">{formatDateTime(a.timestamp)}</span>
              <TxHashLink hash={a.txHash} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Portfolio</h1>
        <p className="mt-1.5 text-sm text-ink-2">Everything you&apos;ve lent and borrowed, read live from the contracts.</p>
      </div>
      {children}
    </div>
  );
}
