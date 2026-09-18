/** Explicit two-leg policy for live orchestration. Broker calls are never atomic across legs.
 * The only supported orphan policy currently is cancel remaining orders, halt and require
 * a human-approved unwind. Automatic liquidation needs a separately reviewed risk policy.
 */
import { z } from "zod";
import {
  orderIntentSchema,
  type BrokerOrder,
  type LimitQuote,
} from "./contracts.js";

export const spreadPlanSchema = z
  .object({
    hedge: orderIntentSchema,
    exposure: orderIntentSchema,
    maxSlippageBps: z.number().int().min(0).max(500),
    legDeadlineMs: z.number().int().min(100).max(60000),
    orphanPolicy: z.literal("cancel_and_require_manual_unwind"),
    createdAt: z.number().int().positive(),
  })
  .strict()
  .refine(
    (plan) => plan.hedge.side === "buy" && plan.exposure.side === "sell",
    "Hedge-first requires buy protection before sell exposure",
  );
export type SpreadPlan = z.infer<typeof spreadPlanSchema>;

/** Compute a bounded LIMIT for the exposure leg. Reject stale quotes and adverse movement
 * outside the strategy's explicit budget. Never switch to an unbounded market order.
 */
export function boundedExposureLimit(
  plan: SpreadPlan,
  quote: LimitQuote,
  now: number,
) {
  const reference = plan.exposure.limitPaise;
  if (
    !Number.isSafeInteger(quote.pricePaise) ||
    quote.pricePaise <= 0 ||
    !Number.isSafeInteger(quote.observedAt) ||
    now - quote.observedAt > 1000 ||
    quote.observedAt > now
  ) {
    throw new Error("Exposure quote is stale or invalid");
  }
  const worstAcceptable = Math.ceil(
    reference * (1 - plan.maxSlippageBps / 10000),
  );
  if (quote.pricePaise < worstAcceptable) {
    throw new Error("Exposure leg exceeds slippage budget");
  }
  return Math.max(worstAcceptable, quote.pricePaise);
}

/** Record exact known fills for an operator's unwind workflow, not an instruction to send
 * opposite orders blindly. Broker positions must be rechecked before manual remediation.
 */
export function describeOrphanExposure(orders: BrokerOrder[]) {
  return orders
    .filter((order) => order.filledQuantity > 0)
    .map((order) => ({
      instrument: order.instrument,
      filledSide: order.side,
      filledQuantity: order.filledQuantity,
      action: "Verify broker position and approve an unwind manually",
    }));
}
