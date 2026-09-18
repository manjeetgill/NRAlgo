/** Non-executing shadow planner. Deliberately has no broker adapter, SDK, DB writer or OMS
 * dependency: a configuration flag cannot turn a shadow evaluation into a real submission.
 * Feed recorded or read-only normalized snapshots here to inspect intended decisions.
 */
import { evaluateLiveRisk, type RiskContext } from "./risk.js";
import type { OrderIntent } from "./contracts.js";

/** Return a would-submit plan or a risk rejection. This function cannot place/cancel orders. */
export function planShadowOrder(intent: OrderIntent, context: RiskContext) {
  try {
    return {
      decision: "would_submit" as const,
      intent: structuredClone(intent),
      reservedPaise: evaluateLiveRisk(intent, context),
    };
  } catch (error) {
    return {
      decision: "rejected" as const,
      reason: error instanceof Error ? error.message : "Risk rejected",
    };
  }
}
