"use client";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "./cn";
import { Skeleton } from "./misc";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  /** API sort key; makes the header a sort button. */
  sort?: string;
  align?: "left" | "right";
  className?: string;
  /** Hide in the stacked mobile layout (e.g. the action column, rendered separately). */
  mobileHidden?: boolean;
}

export interface SortState {
  sort: string;
  order: "asc" | "desc";
}

/**
 * Table on md+, stacked definition lists on phones. Same columns drive both, so they never drift.
 * Rows keep a fixed min height and loading shows skeleton rows of the same shape (no layout shift).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  sort,
  onSort,
  caption,
  actions,
  mobileTitle,
  skeletonRows = 5,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: React.ReactNode;
  sort?: SortState;
  onSort?: (s: SortState) => void;
  caption: string;
  actions?: (row: T) => React.ReactNode;
  mobileTitle?: (row: T) => React.ReactNode;
  skeletonRows?: number;
}) {
  const showSkeleton = loading && !rows?.length;
  const toggle = (key: string) => {
    if (!onSort) return;
    if (sort?.sort === key) onSort({ sort: key, order: sort.order === "asc" ? "desc" : "asc" });
    else onSort({ sort: key, order: key === "apr" ? "asc" : "desc" });
  };

  return (
    <div>
      {/* md+ table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-xs text-ink-3">
              {columns.map((c) => {
                const active = sort?.sort === c.sort && c.sort;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort!.order === "asc" ? "ascending" : "descending") : undefined}
                    className={cn("whitespace-nowrap px-3 py-2.5 font-normal first:pl-4 last:pr-4 sm:first:pl-5", c.align === "right" && "text-right", c.className)}
                  >
                    {c.sort && onSort ? (
                      <button
                        type="button"
                        onClick={() => toggle(c.sort!)}
                        className={cn("inline-flex items-center gap-1 rounded-sm hover:text-ink", active && "text-ink", c.align === "right" && "flex-row-reverse")}
                      >
                        {c.header}
                        {active ? (
                          sort!.order === "asc" ? <ArrowUp className="size-3" strokeWidth={2} /> : <ArrowDown className="size-3" strokeWidth={2} />
                        ) : (
                          <span className="size-3" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {actions && (
                <th scope="col" className="px-3 py-2.5 pr-4 text-right font-normal sm:pr-5">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {showSkeleton
              ? Array.from({ length: skeletonRows }).map((_, i) => (
                  <tr key={i} className="h-14 border-b border-line last:border-0">
                    {columns.map((c) => (
                      <td key={c.key} className="px-3 first:pl-4 sm:first:pl-5">
                        <Skeleton className={cn("h-3.5 w-16", c.align === "right" && "ml-auto")} />
                      </td>
                    ))}
                    {actions && <td />}
                  </tr>
                ))
              : rows?.map((r) => (
                  <tr key={rowKey(r)} className="h-14 border-b border-line transition-colors last:border-0 hover:bg-surface">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn("whitespace-nowrap px-3 py-2 align-middle first:pl-4 sm:first:pl-5", c.align === "right" && "num text-right", c.className)}
                      >
                        {c.cell(r)}
                      </td>
                    ))}
                    {actions && (
                      <td className="px-3 py-2 pr-4 text-right sm:pr-5">
                        <div className="flex justify-end gap-1.5">{actions(r)}</div>
                      </td>
                    )}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>

      {/* phones */}
      <ul className="divide-y divide-line md:hidden" aria-label={caption}>
        {showSkeleton
          ? Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="space-y-3 px-4 py-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </li>
            ))
          : rows?.map((r) => (
              <li key={rowKey(r)} className="px-4 py-4">
                {mobileTitle && <div className="mb-3 text-sm">{mobileTitle(r)}</div>}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                  {columns
                    .filter((c) => !c.mobileHidden)
                    .map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="text-xs text-ink-3">{c.header}</dt>
                        <dd className="num mt-0.5 truncate">{c.cell(r)}</dd>
                      </div>
                    ))}
                </dl>
                {actions && <div className="mt-3 flex flex-wrap gap-2">{actions(r)}</div>}
              </li>
            ))}
      </ul>

      {!showSkeleton && rows && rows.length === 0 && empty}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-ink-3 sm:px-5">
      <span className="num">
        {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="h-8 rounded-md border border-line px-3 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="h-8 rounded-md border border-line px-3 text-ink-2 hover:bg-surface-2 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
