/** Pure LIVE pre-trade risk evaluation. This is not imported by the paper simulator/worker.
 * Call under the account database lock and atomically persist the returned reservation.
 * Conservative notional limits are a test foundation, NOT a derivatives margin/SPAN engine.
 */
import {
  maximumSnapshotAgeMs,
  brokerSnapshotSchema,
  orderIntentSchema,
  riskLimitsSchema,
  type BrokerSnapshot,
  type OrderIntent,
  type RiskLimits,
} from "./contracts.js";

export interface RiskContext {
  snapshot: BrokerSnapshot;
  limits: RiskLimits;
  reservedPaise: number;
  outstandingUnits: Record<string, number>;
  ordersLastMinute: number;
  now: number;
}
/** Reject missing/stale state, losses, exhausted funds, gross exposure, position and rate limits.
 * Opposing pending orders do not net against each other: either can fill independently.
 */
export function evaluateLiveRisk(
  rawIntent: OrderIntent,
  context: RiskContext,
): number {
  const intent = orderIntentSchema.parse(rawIntent),
    limits = riskLimitsSchema.parse(context.limits);
  const snapshot = brokerSnapshotSchema.parse(context.snapshot);
  if (
    !Number.isSafeInteger(context.reservedPaise) ||
    context.reservedPaise < 0 ||
    !Number.isSafeInteger(context.ordersLastMinute) ||
    context.ordersLastMinute < 0 ||
    !Number.isSafeInteger(context.now) ||
    Object.values(context.outstandingUnits).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error("Invalid risk context");
  if (
    !snapshot.complete ||
    !snapshot.sessionHealthy ||
    context.now - snapshot.capturedAt > maximumSnapshotAgeMs ||
    snapshot.capturedAt > context.now
  )
    throw new Error("Fresh complete broker state is required");
  if (snapshot.dailyPnlPaise <= -limits.maxDailyLossPaise)
    throw new Error("Daily loss limit reached");
  const reservation = intent.quantity * intent.limitPaise;
  if (intent.reduceOnly) {
    const position = snapshot.positions[intent.instrument] || 0;
    if (
      (intent.side === "sell" ? position <= 0 : position >= 0) ||
      intent.quantity + (context.outstandingUnits[intent.instrument] || 0) >
        Math.abs(position)
    )
      throw new Error(
        "Reduce-only quantity exceeds unreserved broker position",
      );
    if (context.ordersLastMinute >= limits.maxOrdersPerMinute)
      throw new Error("Order rate limit reached");
    return 0;
  }
  if (
    !Number.isSafeInteger(reservation) ||
    !Number.isSafeInteger(context.reservedPaise + reservation) ||
    !Number.isSafeInteger(
      snapshot.grossExposurePaise + context.reservedPaise + reservation,
    )
  )
    throw new Error("Order notional exceeds safe arithmetic");
  if (
    context.reservedPaise + reservation > limits.maxReservedPaise ||
    context.reservedPaise + reservation > snapshot.availablePaise
  )
    throw new Error("Capital reservation limit reached");
  if (
    snapshot.grossExposurePaise + context.reservedPaise + reservation >
    limits.maxGrossExposurePaise
  )
    throw new Error("Gross exposure limit reached");
  if (
    Math.abs(snapshot.positions[intent.instrument] || 0) +
      (context.outstandingUnits[intent.instrument] || 0) +
      intent.quantity >
    limits.maxPositionUnits
  )
    throw new Error("Position limit reached");
  if (context.ordersLastMinute >= limits.maxOrdersPerMinute)
    throw new Error("Order rate limit reached");
  return reservation;
}
