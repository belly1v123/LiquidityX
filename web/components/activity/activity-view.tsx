"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import type { ActivityDTO } from "@/lib/api-types";
import { getDeployment } from "@/lib/chain";
import { formatAgo, formatAmount, formatBtc, formatDateTime } from "@/lib/format";
import { useActivity } from "@/hooks/use-api";
import { useNow } from "@/hooks/use-now";
import { assetMeta } from "../domain";
import { NotDeployedNotice } from "../deployment-gate";
import { Button } from "../ui/button";
import { DataTable, Pagination, type Column } from "../ui/data-table";
import { Select } from "../ui/field";
import { AddressLink, EmptyState, Notice, TxHashLink } from "../ui/misc";
import { Segmented } from "../ui/tabs";
import { ACTIVITY_KINDS, activityLabel } from "./activity-labels";

const PAGE_SIZE = 25;

function Ref({ a }: { a: ActivityDTO }) {
  if (a.loanId) return <Link href={`/loans/${a.loanId}`} className="text-ink hover:underline">Loan #{a.loanId}</Link>;
  if (a.offerId) return <span className="text-ink-2">Offer #{a.offerId}</span>;
  if (a.requestId) return <span className="text-ink-2">Request #{a.requestId}</span>;
  return <span className="text-ink-3">-</span>;
}

export function ActivityView() {
  const { address } = useAccount();
  const [who, setWho] = useState<"all" | "me">("all");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const now = useNow(30_000);
  const q = useActivity({ address: who === "me" ? address : undefined, kind: kind || undefined, page, pageSize: PAGE_SIZE });
  const me = (x?: string | null) => !!address && !!x && x.toLowerCase() === address.toLowerCase();

  const cols: Column<ActivityDTO>[] = [
    {
      key: "when",
      header: "When",
      cell: (a) => (
        <span title={formatDateTime(a.timestamp)} className="num text-ink-2">
          {now ? formatAgo(a.timestamp, now) : formatDateTime(a.timestamp)}
        </span>
      ),
    },
    { key: "event", header: "Event", cell: (a) => <span className="text-ink">{activityLabel(a.kind)}</span> },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (a) => {
        const m = assetMeta(a.asset);
        // loan_repaid carries total interest, not a transfer; the Repayment row beside it has the amount.
        if (a.kind === "loan_repaid") return <span className="text-ink-3">-</span>;
        if (a.amount) return <span>{formatAmount(a.amount, m.decimals)} <span className="text-ink-3">{m.symbol}</span></span>;
        if (a.btcAmount) return <span>{formatBtc(a.btcAmount)} <span className="text-ink-3">BTC</span></span>;
        return <span className="text-ink-3">-</span>;
      },
    },
    { key: "ref", header: "For", cell: (a) => <Ref a={a} /> },
    { key: "account", header: "Account", cell: (a) => <AddressLink address={a.account} you={me(a.account)} /> },
    { key: "tx", header: "Transaction", cell: (a) => <TxHashLink hash={a.txHash} /> },
  ];

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Activity</h1>
        <p className="mt-1.5 text-sm text-ink-2">Every LiquidityX transaction, newest first. Each links to the Mezo testnet explorer.</p>
      </div>
      <NotDeployedNotice className="mb-6" />
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Segmented
          label="Whose activity"
          value={who}
          onChange={(v) => {
            setWho(v);
            setPage(1);
          }}
          options={[
            { value: "all", label: "Everyone" },
            { value: "me", label: "Just me" },
          ]}
        />
        <Select
          aria-label="Event type"
          className="h-9 w-auto min-w-40 text-sm"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All events</option>
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {activityLabel(k)}
            </option>
          ))}
        </Select>
      </div>
      {who === "me" && !address ? (
        <EmptyState title="Connect a wallet to see your own activity" />
      ) : (
        <div className="rounded-lg border border-line">
          {q.error ? (
            <div className="p-4">
              <Notice tone="danger" title="Couldn't load activity" action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>
                {(q.error as Error).message}
              </Notice>
            </div>
          ) : (
            <DataTable
              caption="Activity"
              columns={cols}
              rows={getDeployment() ? q.data?.items : []}
              rowKey={(a) => a.id}
              loading={q.isLoading}
              skeletonRows={8}
              mobileTitle={(a) => (
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-ink">{activityLabel(a.kind)}</span>
                  <span className="num text-xs text-ink-3">{now ? formatAgo(a.timestamp, now) : ""}</span>
                </span>
              )}
              empty={<EmptyState title="Nothing here yet">{getDeployment() ? "Transactions show up a few seconds after they confirm." : "Activity appears once the contracts are deployed."}</EmptyState>}
            />
          )}
          {q.data && <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />}
        </div>
      )}
    </div>
  );
}
