"use client";
/**
 * Typed TanStack Query hooks for the LiquidityX HTTP API (docs/API.md, shapes in lib/api-types.ts).
 * Every key starts with "api" so one invalidation refreshes all indexed data after a transaction.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  ActivityDTO,
  ConfigResponse,
  LoanDTO,
  MatchSuggestion,
  OfferDTO,
  Paged,
  PortfolioResponse,
  PriceResponse,
  RequestDTO,
  StatsResponse,
} from "@/lib/api-types";
import { getDeployment } from "@/lib/chain";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

export async function apiGet<T>(path: string, params?: Params, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const url = qs.size ? `${path}?${qs}` : path;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "network", "Couldn't reach the LiquidityX server.");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {}
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const apiKey = (...parts: unknown[]) => ["api", ...parts] as const;
const deployed = () => getDeployment() !== null;

export function useApiConfig() {
  return useQuery({
    queryKey: apiKey("config"),
    queryFn: ({ signal }) => apiGet<ConfigResponse>("/api/config", undefined, signal),
    staleTime: 60_000,
  });
}

export function useStats() {
  return useQuery({
    queryKey: apiKey("stats"),
    queryFn: ({ signal }) => apiGet<StatsResponse>("/api/stats", undefined, signal),
    enabled: deployed(),
    refetchInterval: 30_000,
  });
}

export function useApiPrice() {
  return useQuery({
    queryKey: apiKey("price"),
    queryFn: ({ signal }) => apiGet<PriceResponse>("/api/price", undefined, signal),
    refetchInterval: 30_000,
  });
}

export interface ListingFilters {
  asset?: string;
  status?: string;
  lender?: string;
  borrower?: string;
  minApr?: number;
  maxApr?: number;
  minAmount?: string;
  maxAmount?: string;
  maxDuration?: number;
  minCr?: number;
  sort?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function useOffers(filters: ListingFilters, enabled = true) {
  return useQuery({
    queryKey: apiKey("offers", filters),
    queryFn: ({ signal }) => apiGet<Paged<OfferDTO>>("/api/offers", { ...filters }, signal),
    enabled: enabled && deployed(),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
}

export function useRequests(filters: ListingFilters, enabled = true) {
  return useQuery({
    queryKey: apiKey("requests", filters),
    queryFn: ({ signal }) => apiGet<Paged<RequestDTO>>("/api/requests", { ...filters }, signal),
    enabled: enabled && deployed(),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });
}

export function useLoans(params: { address?: string; role?: "lender" | "borrower" | "any"; status?: string; page?: number; pageSize?: number }, enabled = true) {
  return useQuery({
    queryKey: apiKey("loans", params),
    queryFn: ({ signal }) => apiGet<Paged<LoanDTO>>("/api/loans", { ...params }, signal),
    enabled: enabled && deployed(),
    placeholderData: keepPreviousData,
  });
}

export function useLoanDetail(id: string | undefined) {
  return useQuery({
    queryKey: apiKey("loan", id),
    queryFn: ({ signal }) => apiGet<{ loan: LoanDTO; activity: ActivityDTO[] }>(`/api/loans/${id}`, undefined, signal),
    enabled: !!id && deployed(),
    refetchInterval: 30_000,
  });
}

export function useMatches(requestId: string | undefined) {
  return useQuery({
    queryKey: apiKey("matches", requestId),
    queryFn: ({ signal }) => apiGet<MatchSuggestion>("/api/matches", { requestId }, signal),
    enabled: !!requestId && deployed(),
  });
}

export interface OfferMatches {
  offerId: string;
  requests: { requestId: string; amount: string; collateralShare: string; crBps: string }[];
}
export function useOfferMatches(offerId: string | undefined) {
  return useQuery({
    queryKey: apiKey("matches-for-offer", offerId),
    queryFn: ({ signal }) => apiGet<OfferMatches>("/api/matches/for-offer", { offerId }, signal),
    enabled: !!offerId && deployed(),
  });
}

export function useActivity(params: { address?: string; loanId?: string; offerId?: string; requestId?: string; kind?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: apiKey("activity", params),
    queryFn: ({ signal }) => apiGet<Paged<ActivityDTO>>("/api/activity", { ...params }, signal),
    enabled: deployed(),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function usePortfolio(address: string | undefined) {
  return useQuery({
    queryKey: apiKey("portfolio", address),
    queryFn: ({ signal }) => apiGet<PortfolioResponse>(`/api/portfolio/${address}`, undefined, signal),
    enabled: !!address && deployed(),
    refetchInterval: 30_000,
  });
}
