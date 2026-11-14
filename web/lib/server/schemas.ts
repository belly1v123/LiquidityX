import "server-only";
import { z } from "zod";
import { zAddress, zId, zInt, zOrder, zPage, zUint } from "./http";

const APR = zInt(0, 65_535);
const DURATION = zInt(0, 4_294_967_295);

export const offersQuery = z
  .object({
    asset: zAddress.optional(),
    status: z.enum(["open", "filled", "cancelled", "expired"]).optional(),
    lender: zAddress.optional(),
    minApr: APR.optional(),
    maxApr: APR.optional(),
    minAmount: zUint.optional(),
    maxAmount: zUint.optional(),
    maxDuration: DURATION.optional(),
    sort: z.enum(["apr", "amount", "duration", "expiry", "created"]).default("created"),
    order: zOrder.optional(),
    ...zPage,
  })
  ;

export const requestsQuery = z
  .object({
    asset: zAddress.optional(),
    status: z.enum(["open", "partially_filled", "filled", "cancelled", "expired"]).optional(),
    borrower: zAddress.optional(),
    minApr: APR.optional(),
    maxApr: APR.optional(),
    minAmount: zUint.optional(),
    maxAmount: zUint.optional(),
    maxDuration: DURATION.optional(),
    minCr: zInt(0, 10_000_000).optional(),
    sort: z.enum(["apr", "amount", "duration", "expiry", "created", "cr"]).default("created"),
    order: zOrder.optional(),
    ...zPage,
  })
  ;

export const loansQuery = z
  .object({
    address: zAddress.optional(),
    role: z.enum(["lender", "borrower", "any"]).default("any"),
    status: z.enum(["active", "overdue", "repaid", "liquidated"]).optional(),
    ...zPage,
  })
  ;

export const activityQuery = z
  .object({
    address: zAddress.optional(),
    loanId: zId.optional(),
    offerId: zId.optional(),
    requestId: zId.optional(),
    kind: z
      .enum([
        "deposit", "withdraw", "offer_created", "offer_cancelled", "request_created", "request_cancelled", "matched",
        "loan_activated", "repayment", "loan_repaid", "collateral_deposited", "collateral_withdrawn",
        "collateral_released", "liquidated",
      ])
      .optional(),
    ...zPage,
  })
  ;

export const matchesQuery = z.object({ requestId: zId });
export const forOfferQuery = z.object({ offerId: zId });
export const idParam = zId;
export const addressParam = zAddress;
