/** Research-only cash/options basket model. No broker execution imports are allowed here.
 * One intraday round trip uses real, aligned candles: scheduled fills use opens, and a
 * stop/target observed at a completed close can execute only at the NEXT candle open.
 * This deliberately does not claim tick-level stops, atomic legs, SPAN margin or live fills.
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
    expiryDate: z.iso.date().optional(),
    right: z.enum(["call", "put"]).optional(),
    strikePrice: z.number().positive().max(1000000).optional(),
  })
  .strict();
export const researchStrategySchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    // Keep broker identity explicit so future adapters cannot misinterpret a saved contract.
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
      strategy.legs.some((leg) => leg.side === "sell") &&
      strategy.marginReserve <= 0
    ) {
      invalid(
        "Short-option research requires an explicit assumed margin reserve.",
      );
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
export type ResearchLeg = z.infer<typeof researchLegSchema>;
export interface HistoricalCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface ResearchFill {
  time: number;
  leg: number;
  action: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  reason: string;
}
export interface ResearchPoint {
  time: number;
  pnl: number;
  prices: number[];
  open: boolean;
}
const roundMoney = (value: number) => Math.round(value * 100) / 100;
/** All session dates/times are explicitly IST, independent of the browser/server timezone. */
export function sessionTimestamp(day: string, clockTime: string) {
  return Date.parse(`${day}T${clockTime}:00+05:30`);
}

/** Reject empty, truncated, duplicate, out-of-window, malformed or noncontiguous histories.
 * Missing bars are not forward-filled: stale leg marks can invent attractive spread profits.
 */
export function normalizeHistoricalCandles(
  raw: unknown,
  day: string,
  intervalMinutes: number,
): HistoricalCandle[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length >= 1000) {
    throw new Error("History is empty or potentially truncated.");
  }
  const candles = raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error("Invalid historical candle.");
      }
      const text = String(item.datetime);
      const time = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
        ? Date.parse(text.replace(" ", "T") + "+05:30")
        : /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(text)
          ? Date.parse(text)
          : NaN;
      const values = [item.open, item.high, item.low, item.close].map((value) =>
        Number(value),
      );
      if (
        !Number.isFinite(time) ||
        time < sessionTimestamp(day, "09:15") ||
        time >= sessionTimestamp(day, "15:30") ||
        values.some(
          (price) => !Number.isFinite(price) || price <= 0 || price > 10000000,
        ) ||
        values[1] < Math.max(values[0], values[2], values[3]) ||
        values[2] > Math.min(values[0], values[1], values[3])
      ) {
        throw new Error(
          "Invalid OHLC values or a candle outside the requested IST session.",
        );
      }
      return {
        time,
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
      };
    })
    .sort((a, b) => a.time - b.time);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time !== intervalMinutes * 60000) {
      throw new Error(
        "Historical candles contain duplicate timestamps or gaps. Choose another interval/session.",
      );
    }
  }
  return candles;
}

/** Replay an immutable strategy against complete aligned broker candles; exactly one basket entry.
 * Premium credits never substitute for a real broker margin check. The manually supplied margin
 * reserve is a research assumption only. Fees and slippage are explicit, taxes are excluded.
 */
export function simulateHistoricalBasket(
  input: ResearchStrategy,
  histories: HistoricalCandle[][],
  day: string,
) {
  const strategy = researchStrategySchema.parse(input);
  if (
    histories.length !== strategy.legs.length ||
    histories.some((bars) => !bars.length)
  ) {
    throw new Error("Missing leg history.");
  }
  const timeline = histories[0];
  if (
    histories.some(
      (bars) =>
        bars.length !== timeline.length ||
        bars.some((bar, i) => bar.time !== timeline[i].time),
    )
  ) {
    throw new Error(
      "All legs must have the same candle timeline; incomplete baskets are refused.",
    );
  }
  const entryAt = sessionTimestamp(day, strategy.entryTime),
    exitAt = sessionTimestamp(day, strategy.exitTime);
  if (timeline[0].time > entryAt || timeline.at(-1)!.time < exitAt) {
    throw new Error("History does not cover the requested entry and exit.");
  }
  if (strategy.legs.some((leg) => leg.expiryDate && leg.expiryDate < day)) {
    throw new Error("An options contract expired before this session.");
  }
  let entered = false,
    open = false,
    cashDelta = 0,
    peak = 0,
    drawdown = 0,
    exitReason = "",
    totalFees = 0;
  const fills: ResearchFill[] = [],
    points: ResearchPoint[] = [];
  /** Apply adverse slippage to both sides; every leg is independently charged a fee. */
  function fillBasket(index: number, exiting: boolean, reason: string) {
    const proposed = strategy.legs.map((leg, legIndex) => {
      const action = exiting ? (leg.side === "buy" ? "sell" : "buy") : leg.side;
      const price = roundMoney(
        histories[legIndex][index].open *
          (1 + ((action === "buy" ? 1 : -1) * strategy.slippageBps) / 10000),
      );
      return {
        time: timeline[index].time,
        leg: legIndex,
        action,
        quantity: leg.quantity,
        price,
        fee: strategy.feePerOrder,
        reason,
      } as ResearchFill;
    });
    const debit = proposed.reduce(
      (sum, fill) =>
        sum +
        (fill.action === "buy" ? 1 : -1) * fill.price * fill.quantity +
        fill.fee,
      0,
    );
    if (
      !exiting &&
      Math.max(0, debit) + strategy.marginReserve > strategy.capital
    ) {
      throw new Error(
        "Insufficient simulated capital for premium and assumed margin.",
      );
    }
    cashDelta -= debit;
    totalFees += proposed.reduce((sum, fill) => sum + fill.fee, 0);
    fills.push(...proposed);
  }
  timeline.forEach((bar, index) => {
    if (!entered && bar.time >= entryAt && bar.time < exitAt) {
      fillBasket(index, false, "scheduled entry");
      entered = true;
      open = true;
    } else if (open && (exitReason || bar.time >= exitAt)) {
      fillBasket(index, true, exitReason || "scheduled exit");
      open = false;
    }
    const prices = histories.map((bars) => bars[index].close);
    const pnl = roundMoney(
      cashDelta +
        (open
          ? strategy.legs.reduce(
              (sum, leg, i) =>
                sum + (leg.side === "buy" ? 1 : -1) * leg.quantity * prices[i],
              0,
            )
          : 0),
    );
    peak = Math.max(peak, pnl);
    drawdown = Math.max(drawdown, peak - pnl);
    points.push({ time: bar.time, pnl, prices, open });
    if (open && !exitReason) {
      if (pnl <= -strategy.stopLoss) {
        exitReason = "stop observed at previous close";
      } else if (pnl >= strategy.targetProfit) {
        exitReason = "target observed at previous close";
      }
    }
  });
  if (!entered || open) {
    throw new Error(
      "Requested entry/exit cannot be completed with this history.",
    );
  }
  return {
    source: strategy.broker,
    model: "scheduled-basket-v1",
    day,
    strategy,
    points,
    fills,
    pnl: roundMoney(cashDelta),
    drawdown: roundMoney(drawdown),
    totalFees: roundMoney(totalFees),
    warnings: [
      "One scheduled round trip; no automatic strategy execution.",
      "Stops/targets use candle closes and fill at the next open, not intrabar prices.",
      "Simultaneous leg fills, configurable slippage and fees are assumptions; taxes, liquidity and leg risk are not modeled.",
      ...(strategy.market === "options"
        ? [
            "Quantity means contract units, not lots. Verify historical lot sizes yourself.",
            "Short-option margin is a user assumption, not SPAN or broker-validated buying power.",
          ]
        : []),
    ],
  };
}

export type BacktestResult = ReturnType<typeof simulateHistoricalBasket>;
export interface BacktestBatchDay {
  day: string;
  pnl: number;
  drawdown: number;
  totalFees: number;
  /** Execution fills, not completed round trips (entry and exit count separately). */
  trades: number;
}
export interface BacktestBatchSummary {
  sessions: BacktestBatchDay[];
  sessionsRun: number;
  winningSessions: number;
  losingSessions: number;
  breakEvenSessions: number;
  totalPnl: number;
  totalFees: number;
  worstSessionDrawdown: number;
  averagePnlPerSession: number;
}
/** Summarize isolated daily round trips: no compounding, overnight exposure or continuous
 * multi-day drawdown. Zero-P&L sessions are explicitly separate from winning/losing days.
 */
export function summarizeBacktestBatch(
  results: BacktestResult[],
): BacktestBatchSummary {
  if (!results.length) {
    throw new Error("No completed sessions to summarize.");
  }
  const sessions = results.map((result) => ({
    day: result.day,
    pnl: result.pnl,
    drawdown: result.drawdown,
    totalFees: result.totalFees,
    trades: result.fills.length,
  }));
  const totalPnl = roundMoney(
    sessions.reduce((sum, session) => sum + session.pnl, 0),
  );
  return {
    sessions,
    sessionsRun: sessions.length,
    winningSessions: sessions.filter((session) => session.pnl > 0).length,
    losingSessions: sessions.filter((session) => session.pnl < 0).length,
    breakEvenSessions: sessions.filter((session) => session.pnl === 0).length,
    totalPnl,
    totalFees: roundMoney(
      sessions.reduce((sum, session) => sum + session.totalFees, 0),
    ),
    worstSessionDrawdown: Math.max(
      ...sessions.map((session) => session.drawdown),
    ),
    averagePnlPerSession: roundMoney(totalPnl / sessions.length),
  };
}
