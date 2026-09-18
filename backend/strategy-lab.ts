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
    )
      invalid("Use an entry before exit within 09:15–15:25 IST.");
    if (
      strategy.market === "cash" &&
      (strategy.legs.length !== 1 || strategy.legs[0].side !== "buy")
    )
      invalid("Cash research supports one long-only leg.");
    if (
      strategy.market === "options" &&
      strategy.legs.some(
        (leg) => !leg.expiryDate || !leg.right || !leg.strikePrice,
      )
    )
      invalid("Every options leg needs expiry, call/put and strike.");
    if (
      strategy.market === "cash" &&
      strategy.legs.some(
        (leg) => leg.expiryDate || leg.right || leg.strikePrice,
      )
    )
      invalid("Cash legs cannot contain option fields.");
    if (
      strategy.market === "options" &&
      strategy.legs.some((leg) => leg.side === "sell") &&
      strategy.marginReserve <= 0
    )
      invalid(
        "Short-option research requires an explicit assumed margin reserve.",
      );
    if (strategy.marginReserve > strategy.capital)
      invalid("Assumed margin exceeds capital.");
    const identities = strategy.legs.map(
      (leg) =>
        `${leg.stockCode}:${leg.expiryDate}:${leg.right}:${leg.strikePrice}`,
    );
    if (new Set(identities).size !== identities.length)
      invalid("Combine duplicate contracts into one leg.");
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
  if (!Array.isArray(raw) || raw.length < 2 || raw.length >= 1000)
    throw new Error("History is empty or potentially truncated.");
  const candles = raw
    .map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("Invalid historical candle.");
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
      )
        throw new Error(
          "Invalid OHLC values or a candle outside the requested IST session.",
        );
      return {
        time,
        open: values[0],
        high: values[1],
        low: values[2],
        close: values[3],
      };
    })
    .sort((a, b) => a.time - b.time);
  for (let i = 1; i < candles.length; i++)
    if (candles[i].time - candles[i - 1].time !== intervalMinutes * 60000)
      throw new Error(
        "Historical candles contain duplicate timestamps or gaps. Choose another interval/session.",
      );
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
  )
    throw new Error("Missing leg history.");
  const timeline = histories[0];
  if (
    histories.some(
      (bars) =>
        bars.length !== timeline.length ||
        bars.some((bar, i) => bar.time !== timeline[i].time),
    )
  )
    throw new Error(
      "All legs must have the same candle timeline; incomplete baskets are refused.",
    );
  const entryAt = sessionTimestamp(day, strategy.entryTime),
    exitAt = sessionTimestamp(day, strategy.exitTime);
  if (timeline[0].time > entryAt || timeline.at(-1)!.time < exitAt)
    throw new Error("History does not cover the requested entry and exit.");
  if (strategy.legs.some((leg) => leg.expiryDate && leg.expiryDate < day))
    throw new Error("An options contract expired before this session.");
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
    )
      throw new Error(
        "Insufficient simulated capital for premium and assumed margin.",
      );
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
      if (pnl <= -strategy.stopLoss)
        exitReason = "stop observed at previous close";
      else if (pnl >= strategy.targetProfit)
        exitReason = "target observed at previous close";
    }
  });
  if (!entered || open)
    throw new Error(
      "Requested entry/exit cannot be completed with this history.",
    );
  return {
    source: "icici-breeze" as const,
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
  if (!results.length) throw new Error("No completed sessions to summarize.");
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

/** Build only documented market-data arguments. No order payload or execution capability. */
export function marketDataParameters(
  strategy: ResearchStrategy,
  leg: ResearchLeg,
) {
  return {
    stockCode: leg.stockCode,
    exchangeCode: strategy.market === "cash" ? "NSE" : "NFO",
    productType: strategy.market,
    ...(strategy.market === "options"
      ? {
          expiryDate: `${leg.expiryDate}T00:00:00.000Z`,
          right: leg.right,
          strikePrice: String(leg.strikePrice),
        }
      : {}),
  };
}

/** Timestamp and identity checks keep a stale or wrong contract quote out of a live draft.
 * Missing last-trade timestamps are displayed as stale, never replaced by response-receipt time.
 */
export function normalizeResearchQuote(
  raw: unknown,
  strategy: Pick<ResearchStrategy, "market">,
  leg: ResearchLeg,
) {
  if (!Array.isArray(raw) || raw.length !== 1)
    throw new Error("Expected exactly one quote per contract.");
  const row = raw[0];
  if (!row || typeof row !== "object")
    throw new Error("Invalid quote response.");
  if (
    row.stock_code !== leg.stockCode ||
    row.exchange_code !== (strategy.market === "cash" ? "NSE" : "NFO")
  )
    throw new Error("Quote instrument mismatch.");
  const expiry = String(row.expiry_date || "");
  const expiryDay = /^\d{4}-\d{2}-\d{2}/.test(expiry)
    ? expiry.slice(0, 10)
    : parseBrokerQuoteTime(expiry + " 00:00:00");
  if (
    strategy.market === "options" &&
    (String(row.right).toLowerCase() !== leg.right ||
      Number(row.strike_price) !== leg.strikePrice ||
      (typeof expiryDay === "number"
        ? new Date(expiryDay + 19800000).toISOString().slice(0, 10)
        : expiryDay) !== leg.expiryDate)
  )
    throw new Error("Quote option contract mismatch.");
  const price = Number(row.ltp),
    bid = Number(row.best_bid_price),
    ask = Number(row.best_offer_price);
  if (
    ![price, bid, ask].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 10000000,
    ) ||
    bid > ask
  )
    throw new Error("Quote prices unavailable.");
  const time = parseBrokerQuoteTime(String(row.ltt));
  return {
    stockCode: leg.stockCode,
    price,
    bid,
    ask,
    observedAt: time,
    stale:
      !time ||
      price <= 0 ||
      bid <= 0 ||
      ask <= 0 ||
      Date.now() - time > 60000 ||
      time > Date.now() + 1000,
  };
}

/** Normalize one explicit expiry/right chain. The broker may return only a strike subset;
 * never advertise complete-chain coverage or use its indicative prices as an order preview.
 */
export function normalizeOptionChain(
  raw: unknown,
  stockCode: string,
  expiryDate: string,
  right: "call" | "put",
) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length >= 1000)
    throw new Error("Option chain is empty or potentially truncated.");
  const seen = new Set<number>();
  return raw
    .map((row) => {
      const strikePrice = Number(row?.strike_price);
      if (
        !Number.isFinite(strikePrice) ||
        strikePrice <= 0 ||
        strikePrice > 1000000 ||
        seen.has(strikePrice)
      )
        throw new Error("Invalid or duplicate option-chain contract.");
      seen.add(strikePrice);
      const leg: ResearchLeg = {
        stockCode,
        expiryDate,
        right,
        strikePrice,
        side: "buy",
        quantity: 1,
      };
      const quote = normalizeResearchQuote([row], { market: "options" }, leg);
      const openInterest = Number(row.open_interest || 0),
        volume = Number(row.total_quantity_traded || 0);
      if (
        ![openInterest, volume].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new Error("Invalid option-chain volume/open interest.");
      return { ...leg, ...quote, openInterest, volume };
    })
    .sort((a, b) => a.strikePrice! - b.strikePrice!);
}
/** Parse ICICI's DD-Mmm-YYYY exchange-local timestamps without using the machine timezone. */
function parseBrokerQuoteTime(value: string): number | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    value,
  );
  if (!match) return null;
  const month = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(match[2].toLowerCase());
  if (month < 0) return null;
  return (
    Date.parse(
      `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]}T${match[4]}:${match[5]}:${match[6]}+05:30`,
    ) || null
  );
}
