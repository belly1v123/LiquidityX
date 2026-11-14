"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { useAccount } from "wagmi";
import type { OfferDTO, RequestDTO } from "@/lib/api-types";
import { loanMarketplaceAbi } from "@/lib/abi";
import { assetByAddress, getAssets, getDeployment, MUSD, UNLISTED_ASSET_NOTE } from "@/lib/chain";
import { formatAmount, formatApr, formatBtc, formatCountdown, formatCr, formatDate, formatDuration, parseAmount, percentToBps } from "@/lib/format";
import { useOffers, useRequests, useStats, type ListingFilters } from "@/hooks/use-api";
import { useNow } from "@/hooks/use-now";
import { useRiskParams } from "@/hooks/use-protocol";
import { useTx } from "@/hooks/use-tx";
import { Amount, AssetName, assetMeta, crTone, OfferStatusLabel, RequestStatusLabel } from "../domain";
import { NotDeployedNotice } from "../deployment-gate";
import { Button, ButtonLink } from "../ui/button";
import { DataTable, Pagination, type Column, type SortState } from "../ui/data-table";
import { Input, Select } from "../ui/field";
import { AddressLink, EmptyState, Figure, Notice, Skeleton, Status } from "../ui/misc";
import { Tabs } from "../ui/tabs";
import { BorrowFromOfferSheet, FundRequestSheet, MatchOfferSheet, MatchRequestSheet } from "./sheets";

type Tab = "requests" | "offers" | "mine";
const PAGE_SIZE = 20;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ---------------------------------------------------------------------------------------------

function Summary() {
  const stats = useStats();
  const deployed = !!getDeployment();
  const s = stats.data;
  const musd = s?.perAsset.find((a) => same(a.asset, MUSD.address));
  const value = (v: React.ReactNode) => (!deployed ? "-" : stats.isLoading ? <Skeleton className="mt-1 h-6 w-24" /> : v);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
      <Figure label="Available to borrow" value={value(s ? `${formatAmount(musd?.totalReserved ?? "0", 18, { compact: true })} MUSD` : "-")} sub="Reserved in open offers" />
      <Figure label="Average offer APR" value={value(s ? formatApr(s.avgOfferAprBps) : "-")} sub="Weighted by size" />
      <Figure label="Active loans" value={value(s ? s.activeLoans.toLocaleString("en-US") : "-")} sub={s ? `${s.totalLoans} all time` : undefined} />
      <Figure label="BTC locked" value={value(s ? `${formatBtc(s.btcLocked, { maxDp: 4 })} BTC` : "-")} sub="In requests and loans" />
      {stats.error && <p className="col-span-full text-xs text-danger">Couldn&apos;t load market totals. They&apos;ll retry shortly.</p>}
    </dl>
  );
}

// ---------------------------------------------------------------------------------------------

interface FilterState {
  asset: string;
  status: string;
  minApr: string;
  maxApr: string;
  minAmount: string;
  maxAmount: string;
  maxDays: string;
  minCr: string;
}
const EMPTY: FilterState = { asset: "", status: "active", minApr: "", maxApr: "", minAmount: "", maxAmount: "", maxDays: "", minCr: "" };

function toApi(f: FilterState, tab: Tab): ListingFilters {
  const dec = getAssets().find((a) => same(a.address, f.asset))?.decimals ?? 18;
  const amt = (s: string) => {
    const v = parseAmount(s, dec);
    return v !== null && v > 0n ? v.toString() : undefined;
  };
  const bps = (s: string) => (s.trim() ? percentToBps(s) ?? undefined : undefined);
  const days = Number(f.maxDays);
  return {
    asset: f.asset || undefined,
    status: f.status === "active" ? (tab === "offers" ? "open" : undefined) : f.status || undefined,
    minApr: bps(f.minApr),
    maxApr: bps(f.maxApr),
    minAmount: amt(f.minAmount),
    maxAmount: amt(f.maxAmount),
    maxDuration: f.maxDays.trim() && days > 0 ? Math.round(days * 86400) : undefined,
    minCr: tab === "requests" && f.minCr.trim() ? percentToBps(f.minCr) ?? undefined : undefined,
  };
}

function Filters({ tab, value, onChange }: { tab: Tab; value: FilterState; onChange: (f: FilterState) => void }) {
  const [open, setOpen] = useState(false);
  const set = (k: keyof FilterState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [k]: e.target.value });
  const active = Object.entries(value).filter(([k, v]) => v && !(k === "status" && v === "active")).length;
  const statuses =
    tab === "offers"
      ? [["active", "Open"], ["", "Any status"], ["filled", "Filled"], ["cancelled", "Cancelled"], ["expired", "Expired"]]
      : [["active", "Open or part-filled"], ["", "Any status"], ["open", "Open"], ["partially_filled", "Partly filled"], ["filled", "Filled"], ["cancelled", "Cancelled"], ["expired", "Expired"]];
  const small = "h-9 text-sm";
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Asset" className={`${small} w-auto min-w-28`} value={value.asset} onChange={set("asset")}>
          <option value="">All assets</option>
          {getAssets().map((a) => (
            <option key={a.address} value={a.address}>
              {a.symbol}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" className={`${small} w-auto min-w-36`} value={value.status} onChange={set("status")}>
          {statuses.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="md" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="more-filters">
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
          More filters{active > 0 && <span className="num text-ink-3">({active})</span>}
        </Button>
        {active > 0 && (
          <Button variant="ghost" size="md" onClick={() => onChange(EMPTY)}>
            Clear
          </Button>
        )}
      </div>
      {open && (
        <div id="more-filters" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MiniField label="APR from (%)"><Input className={small} inputMode="decimal" value={value.minApr} onChange={set("minApr")} /></MiniField>
          <MiniField label="APR to (%)"><Input className={small} inputMode="decimal" value={value.maxApr} onChange={set("maxApr")} /></MiniField>
          <MiniField label="Size from"><Input className={small} inputMode="decimal" value={value.minAmount} onChange={set("minAmount")} /></MiniField>
          <MiniField label="Size to"><Input className={small} inputMode="decimal" value={value.maxAmount} onChange={set("maxAmount")} /></MiniField>
          <MiniField label="Term up to (days)"><Input className={small} inputMode="decimal" value={value.maxDays} onChange={set("maxDays")} /></MiniField>
          {tab === "requests" && (
            <MiniField label="Collateral ratio from (%)"><Input className={small} inputMode="decimal" value={value.minCr} onChange={set("minCr")} /></MiniField>
          )}
        </div>
      )}
    </div>
  );
}

function MiniField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-2">
      {label}
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------------------------

function useListingColumns(now: number) {
  const { risk } = useRiskParams();
  const { address } = useAccount();
  const requestCols: Column<RequestDTO>[] = [
    { key: "id", header: "Request", cell: (r) => <span className="text-ink-2">#{r.id}</span>, mobileHidden: true },
    {
      key: "amount",
      header: "Unfilled",
      sort: "amount",
      align: "right",
      cell: (r) => (
        <span className="inline-flex flex-col items-start md:items-end">
          <Amount value={BigInt(r.amount) - BigInt(r.filled)} asset={r.asset} />
          <UnlistedNote asset={r.asset} />
          {BigInt(r.filled) > 0n && (
            <span className="text-2xs text-ink-3">of {formatAmount(r.amount, assetMeta(r.asset).decimals)}</span>
          )}
        </span>
      ),
    },
    { key: "apr", header: "Max APR", sort: "apr", align: "right", cell: (r) => formatApr(r.maxAprBps) },
    { key: "term", header: "Term", sort: "duration", align: "right", cell: (r) => formatDuration(r.duration) },
    { key: "collateral", header: "Collateral", align: "right", cell: (r) => `${formatBtc(r.collateralRemaining, { maxDp: 5 })} BTC` },
    {
      key: "cr",
      header: "CR now",
      sort: "cr",
      align: "right",
      cell: (r) =>
        r.crBps ? <Status tone={crTone(BigInt(r.crBps), risk.liquidationCrBps, risk.minInitialCrBps)} className="justify-end">{formatCr(r.crBps)}</Status> : <span className="text-ink-3">-</span>,
    },
    { key: "expiry", header: "Expires", sort: "expiry", align: "right", cell: (r) => <Expiry ts={r.expiry} now={now} /> },
    { key: "status", header: "Status", cell: (r) => <RequestStatusLabel status={r.status} />, mobileHidden: true },
    { key: "who", header: "Borrower", cell: (r) => <AddressLink address={r.borrower} you={same(r.borrower, address)} /> },
  ];
  const offerCols: Column<OfferDTO>[] = [
    { key: "id", header: "Offer", cell: (o) => <span className="text-ink-2">#{o.id}</span>, mobileHidden: true },
    {
      key: "amount",
      header: "Available",
      sort: "amount",
      align: "right",
      cell: (o) => (
        <span className="inline-flex flex-col items-start md:items-end">
          <Amount value={o.remaining} asset={o.asset} />
          <UnlistedNote asset={o.asset} />
          {o.remaining !== o.amount && <span className="text-2xs text-ink-3">of {formatAmount(o.amount, assetMeta(o.asset).decimals)}</span>}
        </span>
      ),
    },
    { key: "apr", header: "APR", sort: "apr", align: "right", cell: (o) => <span className="font-medium text-ink">{formatApr(o.aprBps)}</span> },
    { key: "term", header: "Longest term", sort: "duration", align: "right", cell: (o) => formatDuration(o.maxDuration) },
    { key: "cr", header: "Min. collateral", align: "right", cell: (o) => formatCr(Math.max(o.minCrBps, risk.minInitialCrBps)) },
    { key: "expiry", header: "Expires", sort: "expiry", align: "right", cell: (o) => <Expiry ts={o.expiry} now={now} /> },
    { key: "status", header: "Status", cell: (o) => <OfferStatusLabel status={o.status} />, mobileHidden: true },
    { key: "who", header: "Lender", cell: (o) => <AddressLink address={o.lender} you={same(o.lender, address)} /> },
  ];
  return { requestCols, offerCols };
}

function UnlistedNote({ asset }: { asset: string }) {
  const m = assetByAddress(asset);
  if (!m || m.officiallyListed) return null;
  return <span className="text-2xs text-warning">{UNLISTED_ASSET_NOTE}</span>;
}

function Expiry({ ts, now }: { ts: number; now: number }) {
  if (!now) return <span className="text-ink-3">{formatDate(ts)}</span>;
  if (ts <= now) return <span className="text-warning">Expired</span>;
  return <span title={formatDate(ts)}>in {formatCountdown(ts, now)}</span>;
}

const isOpenRequest = (r: RequestDTO) => r.status === "open" || r.status === "partially_filled";

// ---------------------------------------------------------------------------------------------

export function MarketplaceView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (["requests", "offers", "mine"].includes(params.get("tab") ?? "") ? params.get("tab") : "requests") as Tab;
  const setTab = (t: Tab) => {
    const p = new URLSearchParams(params);
    p.set("tab", t);
    router.replace(`${pathname}?${p}`, { scroll: false });
    setPage(1);
  };

  const { address } = useAccount();
  const now = useNow(30_000);
  const [filters, setFilters] = useState<FilterState>(EMPTY);
  const [sort, setSort] = useState<SortState>({ sort: "created", order: "desc" });
  const [page, setPage] = useState(1);
  const api = useMemo(() => toApi(filters, tab), [filters, tab]);

  const requests = useRequests({ ...api, sort: sort.sort, order: sort.order, page, pageSize: PAGE_SIZE }, tab === "requests");
  const offers = useOffers({ ...api, sort: sort.sort === "cr" ? "created" : sort.sort, order: sort.order, page, pageSize: PAGE_SIZE }, tab === "offers");
  const myRequests = useRequests({ borrower: address, sort: "created", order: "desc", pageSize: 100 }, tab === "mine" && !!address);
  const myOffers = useOffers({ lender: address, sort: "created", order: "desc", pageSize: 100 }, tab === "mine" && !!address);

  const [fund, setFund] = useState<RequestDTO | null>(null);
  const [match, setMatch] = useState<RequestDTO | null>(null);
  const [borrow, setBorrow] = useState<OfferDTO | null>(null);
  const [matchOffer, setMatchOffer] = useState<OfferDTO | null>(null);

  const { requestCols, offerCols } = useListingColumns(now);
  const tx = useTx();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const d = getDeployment();

  const cancel = async (kind: "offer" | "request", id: string) => {
    if (!d) return;
    setCancelling(`${kind}-${id}`);
    await tx.run({
      label: `Cancel ${kind} #${id}`,
      call: {
        address: d.contracts.marketplace,
        abi: loanMarketplaceAbi,
        functionName: kind === "offer" ? "cancelOffer" : "cancelRequest",
        args: [BigInt(id)],
      },
      successMessage: kind === "offer" ? `Offer #${id} cancelled. The MUSD is available in your vault again.` : `Request #${id} cancelled. Your BTC is back in your free balance.`,
    });
    setCancelling(null);
  };

  const reqRows = requests.data?.items.filter((r) => filters.status !== "active" || isOpenRequest(r));
  const onSort = (s: SortState) => {
    setSort(s);
    setPage(1);
  };
  const onFilters = (f: FilterState) => {
    setFilters(f);
    setPage(1);
  };

  const errorBlock = (q: { error: unknown; refetch: () => void }) =>
    q.error ? (
      <div className="p-4">
        <Notice tone="danger" title="Couldn't load listings" action={<Button size="sm" variant="secondary" onClick={() => q.refetch()}>Retry</Button>}>
          {(q.error as Error).message}
        </Notice>
      </div>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Marketplace</h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-ink-2">Every open offer and request, with live collateral ratios. Fund a request, take an offer, or match the two.</p>
        </div>
        <div className="flex gap-2">
          <ButtonLink href="/lend" variant="secondary">Create offer</ButtonLink>
          <ButtonLink href="/borrow">Request loan</ButtonLink>
        </div>
      </div>
      <NotDeployedNotice className="mb-6" />
      <Summary />

      <div className="mt-8">
        <Tabs
          idBase="market"
          label="Listings"
          value={tab}
          onChange={setTab}
          items={[
            { value: "requests", label: "Borrow requests", count: tab === "requests" ? requests.data?.total : undefined },
            { value: "offers", label: "Lend offers", count: tab === "offers" ? offers.data?.total : undefined },
            { value: "mine", label: "My listings" },
          ]}
        />
        <div id="market-panel" role="tabpanel" aria-labelledby={`market-tab-${tab}`}>
          {tab !== "mine" && <Filters tab={tab} value={filters} onChange={onFilters} />}

          {tab === "requests" && (
            <div className="rounded-lg border border-line">
              {errorBlock(requests) ?? (
                <DataTable
                  caption="Borrow requests"
                  columns={requestCols}
                  rows={d ? reqRows : []}
                  rowKey={(r) => r.id}
                  loading={requests.isLoading}
                  sort={sort}
                  onSort={onSort}
                  mobileTitle={(r) => (
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium text-ink">Request #{r.id} <span className="font-normal text-ink-3"><AssetName address={r.asset} /></span></span>
                      <RequestStatusLabel status={r.status} />
                    </span>
                  )}
                  actions={(r) =>
                    isOpenRequest(r) && (!now || r.expiry > now) ? (
                      same(r.borrower, address) ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => setMatch(r)}>Match</Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setMatch(r)}>Match</Button>
                          <Button size="sm" onClick={() => setFund(r)}>Fund</Button>
                        </>
                      )
                    ) : null
                  }
                  empty={
                    <EmptyState title={d ? "No requests match" : "No listings yet"}>
                      {d ? "Try fewer filters, or post the first request yourself." : "Listings appear here once the contracts are deployed."}
                    </EmptyState>
                  }
                />
              )}
              {requests.data && <Pagination page={page} pageSize={PAGE_SIZE} total={requests.data.total} onPage={setPage} />}
            </div>
          )}

          {tab === "offers" && (
            <div className="rounded-lg border border-line">
              {errorBlock(offers) ?? (
                <DataTable
                  caption="Lend offers"
                  columns={offerCols}
                  rows={d ? offers.data?.items : []}
                  rowKey={(o) => o.id}
                  loading={offers.isLoading}
                  sort={sort}
                  onSort={onSort}
                  mobileTitle={(o) => (
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium text-ink">Offer #{o.id} <span className="font-normal text-ink-3"><AssetName address={o.asset} /></span></span>
                      <OfferStatusLabel status={o.status} />
                    </span>
                  )}
                  actions={(o) =>
                    o.status === "open" && (!now || o.expiry > now) && !same(o.lender, address) ? (
                      <Button size="sm" onClick={() => setBorrow(o)}>Borrow</Button>
                    ) : null
                  }
                  empty={
                    <EmptyState title={d ? "No offers match" : "No listings yet"}>
                      {d ? "Try fewer filters, or post the first offer." : "Listings appear here once the contracts are deployed."}
                    </EmptyState>
                  }
                />
              )}
              {offers.data && <Pagination page={page} pageSize={PAGE_SIZE} total={offers.data.total} onPage={setPage} />}
            </div>
          )}

          {tab === "mine" && (
            <div className="mt-5 space-y-8">
              {!address ? (
                <EmptyState title="Connect a wallet to see your listings">Your offers and requests show up here with cancel and match actions.</EmptyState>
              ) : (
                <>
                  <div>
                    <h2 className="mb-3 text-sm font-semibold text-ink">Your offers</h2>
                    <div className="rounded-lg border border-line">
                      {errorBlock(myOffers) ?? (
                        <DataTable
                          caption="Your offers"
                          columns={offerCols.filter((c) => c.key !== "who")}
                          rows={d ? myOffers.data?.items : []}
                          rowKey={(o) => o.id}
                          loading={myOffers.isLoading}
                          skeletonRows={2}
                          mobileTitle={(o) => (
                            <span className="flex items-center justify-between gap-3">
                              <span className="font-medium text-ink">Offer #{o.id}</span>
                              <OfferStatusLabel status={o.status} />
                            </span>
                          )}
                          actions={(o) =>
                            o.status === "open" || o.status === "expired" ? (
                              <>
                                {o.status === "open" && <Button size="sm" variant="ghost" onClick={() => setMatchOffer(o)}>Find borrowers</Button>}
                                <Button size="sm" variant="danger" loading={cancelling === `offer-${o.id}`} disabled={tx.busy} onClick={() => cancel("offer", o.id)}>
                                  Cancel
                                </Button>
                              </>
                            ) : null
                          }
                          empty={<EmptyState title="No offers yet" action={<ButtonLink href="/lend" size="sm" variant="secondary">Create offer</ButtonLink>} />}
                        />
                      )}
                    </div>
                  </div>
                  <div>
                    <h2 className="mb-3 text-sm font-semibold text-ink">Your requests</h2>
                    <div className="rounded-lg border border-line">
                      {errorBlock(myRequests) ?? (
                        <DataTable
                          caption="Your requests"
                          columns={requestCols.filter((c) => c.key !== "who")}
                          rows={d ? myRequests.data?.items : []}
                          rowKey={(r) => r.id}
                          loading={myRequests.isLoading}
                          skeletonRows={2}
                          mobileTitle={(r) => (
                            <span className="flex items-center justify-between gap-3">
                              <span className="font-medium text-ink">Request #{r.id}</span>
                              <RequestStatusLabel status={r.status} />
                            </span>
                          )}
                          actions={(r) =>
                            isOpenRequest(r) || r.status === "expired" ? (
                              <>
                                {isOpenRequest(r) && <Button size="sm" variant="ghost" onClick={() => setMatch(r)}>Match</Button>}
                                <Button size="sm" variant="danger" loading={cancelling === `request-${r.id}`} disabled={tx.busy} onClick={() => cancel("request", r.id)}>
                                  Cancel
                                </Button>
                              </>
                            ) : null
                          }
                          empty={<EmptyState title="No requests yet" action={<ButtonLink href="/borrow" size="sm" variant="secondary">Request loan</ButtonLink>} />}
                        />
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-ink-3">
                    Loans you&apos;re part of are on your <Link href="/portfolio" className="underline">portfolio</Link>.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <FundRequestSheet request={fund} onClose={() => setFund(null)} />
      <MatchRequestSheet request={match} onClose={() => setMatch(null)} />
      <BorrowFromOfferSheet offer={borrow} onClose={() => setBorrow(null)} />
      <MatchOfferSheet offer={matchOffer} onClose={() => setMatchOffer(null)} />
    </div>
  );
}
