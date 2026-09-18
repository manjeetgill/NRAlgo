/** Broker-neutral contracts for the isolated LIVE execution subsystem.
 * Only the separately authorized live control plane can construct a real execution adapter.
 * Prices and money are integer paise, quantities are exchange units, timestamps are Unix ms.
 */
import { z } from "zod";

const money = z.number().int().safe().nonnegative();
export const orderIntentSchema = z
  .object({
    key: z.string().min(1).max(100),
    instrument: z.string().min(1).max(100),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().int().positive().max(1000000),
    limitPaise: money.positive(),
    reduceOnly: z.boolean().optional(),
  })
  .strict();
export type OrderIntent = z.infer<typeof orderIntentSchema>;
export const riskLimitsSchema = z
  .object({
    maxReservedPaise: money.positive(),
    maxGrossExposurePaise: money.positive(),
    maxPositionUnits: z.number().int().positive(),
    maxDailyLossPaise: money.positive(),
    maxOrdersPerMinute: z.number().int().positive().max(60),
    fundsDriftTolerancePaise: money,
  })
  .strict();
export type RiskLimits = z.infer<typeof riskLimitsSchema>;
export const brokerOrderSchema = z
  .object({
    brokerOrderId: z.string().min(1),
    clientOrderKey: z.string().min(1),
    instrument: z.string().min(1),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().int().positive(),
    status: z.enum([
      "acknowledged",
      "open",
      "partially_filled",
      "filled",
      "cancelled",
      "rejected",
    ]),
    filledQuantity: z.number().int().nonnegative(),
    // Cumulative actual cash movement, including fees; adapters must normalize segment accounting.
    cashDeltaPaise: z.number().int().safe(),
  })
  .strict();
export type BrokerOrder = z.infer<typeof brokerOrderSchema>;
export const brokerSnapshotSchema = z
  .object({
    capturedAt: z.number().int().positive(),
    sessionHealthy: z.boolean(),
    complete: z.boolean(),
    orders: z.array(brokerOrderSchema).max(10000),
    positions: z.record(z.string(), z.number().int().safe()),
    availablePaise: money,
    // Cash ledger balance, NOT marked-to-market portfolio equity; fills move cash, not equity.
    cashBalancePaise: money,
    grossExposurePaise: money,
    dailyPnlPaise: z.number().int().safe(),
  })
  .strict();
export type BrokerSnapshot = z.infer<typeof brokerSnapshotSchema>;
export type OrderState =
  "reserved" | "submitting" | "unknown" | "blocked" | BrokerOrder["status"];
export const terminalStates: ReadonlySet<OrderState> = new Set([
  "blocked",
  "filled",
  "cancelled",
  "rejected",
]);
export const maximumSnapshotAgeMs = 5000;
export interface LimitQuote {
  pricePaise: number;
  observedAt: number;
}

/** Only adapters know broker auth/codes/rate limits. Snapshot must include complete order/trade
 * history for this execution account, positions, funds and session health. Unprovable order
 * correlation is a hard failure, never a guessed match by symbol/quantity/time.
 * Implementations must honor abort signals; aborting cannot undo an accepted order.
 */
export interface ExecutionBrokerAdapter {
  readonly accountBinding: string;
  placeOrder(intent: OrderIntent, signal: AbortSignal): Promise<BrokerOrder>;
  cancelOrder(brokerOrderId: string, signal: AbortSignal): Promise<void>;
  getSnapshot(signal: AbortSignal): Promise<BrokerSnapshot>;
  getCancellationOrders?(signal: AbortSignal): Promise<BrokerOrder[]>;
  getQuote(
    instrument: string,
    side: OrderIntent["side"],
    signal: AbortSignal,
  ): Promise<LimitQuote>;
}

/** A documented definitive rejection means no order was accepted. All other submission
 * exceptions, malformed acknowledgements and timeouts have UNKNOWN outcomes.
 */
export class DefinitiveOrderRejection extends Error {}

/** Bound network work even if an adapter ignores abort. Its late result is never retried;
 * reconciliation must discover any late broker-side acceptance or fill.
 */
export async function withBrokerDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds = 1500,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Broker response deadline exceeded"));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
