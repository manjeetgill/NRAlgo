/** Broker-neutral saved-research contracts shared by APIs and calculation adapters.
 * This module validates definitions only; it contains no pricing, simulation or execution.
 */
import { z } from "zod";

const clock = z.string().regex(/^(09|1[0-5]):[0-5][0-9]$/);

export const researchLegSchema = z
  .object({
    stockCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9 &_.-]{1,30}$/),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().int().min(1).max(10000),
    dataInstrumentId: z
      .string()
      .regex(/^NSE:[A-Z0-9_.-]{1,10}:[A-Z0-9_.-]{1,80}$/)
      .optional(),
    expiryDate: z.iso.date().optional(),
    right: z.enum(["call", "put"]).optional(),
    strikePrice: z.number().positive().max(1000000).optional(),
  })
  .strict();

export const researchStrategySchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    name: z.string().trim().min(3).max(80),
    broker: z.literal("kotak").default("kotak"),
    market: z.enum(["cash", "options"]),
    legs: z.array(researchLegSchema).min(1).max(4),
    capital: z.number().min(100).max(10000000),
    marginReserve: z.number().min(0).max(10000000),
    entryTime: clock,
    exitTime: clock,
    stopLoss: z.number().positive().max(10000000),
    targetProfit: z.number().positive().max(10000000),
    slippageBps: z.number().min(0).max(500),
    feePerOrder: z.number().min(0).max(10000),
  })
  .strict()
  .superRefine((strategy, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      strategy.entryTime < "09:15" ||
      strategy.exitTime > "15:25" ||
      strategy.entryTime >= strategy.exitTime
    ) {
      invalid("Use an entry before exit within 09:15–15:25 IST.");
    }
    if (
      strategy.market === "cash" &&
      (strategy.legs.length !== 1 || strategy.legs[0].side !== "buy")
    ) {
      invalid("Cash research supports one long-only leg.");
    }
    if (
      strategy.market === "options" &&
      strategy.legs.some(
        (leg) => !leg.expiryDate || !leg.right || !leg.strikePrice,
      )
    ) {
      invalid("Every options leg needs expiry, call/put and strike.");
    }
    if (
      strategy.market === "cash" &&
      strategy.legs.some(
        (leg) => leg.expiryDate || leg.right || leg.strikePrice,
      )
    ) {
      invalid("Cash legs cannot contain option fields.");
    }
    if (
      strategy.market === "options" &&
      strategy.legs.some((leg) => leg.dataInstrumentId)
    ) {
      invalid("Options legs cannot use a stored cash/index instrument ID.");
    }
    if (
      strategy.market === "options" &&
      strategy.legs.some((leg) => leg.side === "sell") &&
      strategy.marginReserve <= 0
    ) {
      invalid("Short-option research requires an assumed margin reserve.");
    }
    if (strategy.marginReserve > strategy.capital) {
      invalid("Assumed margin exceeds capital.");
    }
    const identities = strategy.legs.map(
      (leg) =>
        `${leg.stockCode}:${leg.expiryDate}:${leg.right}:${leg.strikePrice}`,
    );
    if (new Set(identities).size !== identities.length) {
      invalid("Combine duplicate contracts into one leg.");
    }
  });

export type ResearchStrategy = z.infer<typeof researchStrategySchema>;
