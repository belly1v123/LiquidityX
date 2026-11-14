import { Skeleton } from "./ui/misc";

/** Route-level loading shell: same frame as real pages so nothing jumps when content arrives. */
export function PageSkeleton({ rows = 6, aside = false }: { rows?: number; aside?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 sm:px-6 lg:py-10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      <div className={aside ? "mt-8 grid gap-6 lg:grid-cols-[1fr_1.4fr]" : "mt-8"}>
        {aside && <Skeleton className="h-72 w-full rounded-lg" />}
        <div className="space-y-3 rounded-lg border border-line p-5">
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
