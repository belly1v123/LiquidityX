import type { ActivityKind } from "@/lib/api-types";

const LABELS: Record<ActivityKind, string> = {
  deposit: "Deposited",
  withdraw: "Withdrew",
  offer_created: "Offer posted",
  offer_cancelled: "Offer cancelled",
  request_created: "Request posted",
  request_cancelled: "Request cancelled",
  matched: "Matched",
  loan_activated: "Loan opened",
  repayment: "Repayment",
  loan_repaid: "Repaid in full",
  collateral_deposited: "BTC deposited",
  collateral_withdrawn: "BTC withdrawn",
  collateral_released: "BTC released",
  liquidated: "Liquidated",
};

export const activityLabel = (k: ActivityKind | string) => LABELS[k as ActivityKind] ?? k;
export const ACTIVITY_KINDS = Object.keys(LABELS) as ActivityKind[];
