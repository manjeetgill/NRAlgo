/** Provider-neutral history boundary for research and charts; never accepts client candles or URLs. */
import { z } from "zod";

export const historicalRequestSchema = z
  .object({
    market: z.enum(["cash", "options"]),
    stockCode: z.string().trim().toUpperCase().min(1).max(40),
    instrument: z.string().regex(/^\d{1,15}$/),
    expiryDate: z.iso.date().optional(),
    right: z.enum(["call", "put"]).optional(),
    strikePrice: z.number().positive().optional(),
    from: z.iso.date(),
    to: z.iso.date(),
    interval: z.enum(["1minute", "5minute", "day"]),
  })
  .strict()
  .superRefine((input, context) => {
    const days = (Date.parse(input.to) - Date.parse(input.from)) / 86400000 + 1;
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    if (
      days < 1 ||
      days > (input.interval === "day" ? 180 : 30) ||
      input.to > today ||
      (input.interval === "day" && input.to === today)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Choose an ordered range: at most 180 days for completed daily history, or 30 days for intraday history. Daily history must end before today (IST).",
      });
    }
    if (
      input.market === "options" &&
      (!input.expiryDate || !input.right || !input.strikePrice)
    ) {
      context.addIssue({
        code: "custom",
        message: "Select an exact option contract.",
      });
    }
    if (
      input.market === "cash" &&
      (input.expiryDate || input.right || input.strikePrice !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cash history cannot include option metadata.",
      });
    }
  });
export type HistoricalRequest = z.infer<typeof historicalRequestSchema>;
export type HistoryInterval = HistoricalRequest["interval"];

const candleSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  open: z.number().finite().positive().max(100000000),
  high: z.number().finite().positive().max(100000000),
  low: z.number().finite().positive().max(100000000),
  close: z.number().finite().positive().max(100000000),
  volume: z.number().finite().nonnegative().nullable(),
  openInterest: z.number().finite().nonnegative().nullable(),
});
export type MarketCandle = z.infer<typeof candleSchema>;

/** Validate every adapter equally. Keep gaps, reject duplicates/out-of-range rows; never pad or sort bad history. */
export function validateHistoricalCandles(
  input: HistoricalRequest,
  raw: unknown,
): MarketCandle[] {
  const candles = z.array(candleSchema).max(20000).parse(raw);
  let previous = -Infinity,
    previousDay = "";
  for (const candle of candles) {
    const time = Date.parse(candle.timestamp);
    const day = new Date(time + 19800000).toISOString().slice(0, 10);
    const intervalMilliseconds =
      input.interval === "1minute"
        ? 60000
        : input.interval === "5minute"
          ? 300000
          : null;
    const sameIntradayBucket =
      intervalMilliseconds !== null &&
      Math.floor(time / intervalMilliseconds) ===
        Math.floor(previous / intervalMilliseconds);
    if (
      time <= previous ||
      day < input.from ||
      day > input.to ||
      time > Date.now() ||
      (input.interval === "day" && day === previousDay) ||
      (intervalMilliseconds !== null &&
        (time % intervalMilliseconds !== 0 || sameIntradayBucket)) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.high < candle.low
    ) {
      throw new Error("Invalid, duplicate or out-of-range broker candles.");
    }
    previous = time;
    previousDay = day;
  }
  return candles;
}
