/** Strict result validation for durable Python backtest jobs; no calculation runs in React. */
import { z } from "zod";
import type { HistoryDataset } from "@/lib/market-history";
import { historyDay } from "@/lib/market-history";
/** Browser bar shape only; Python remains the calculation authority. */
export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const finite = z.number().finite();
const settingsSchema = z
  .object({
    template: z.enum(["ema", "rsi", "breakout"]),
    first: z.number().int(),
    second: z.number().int(),
    capital: finite,
    allocation: finite,
    stop: finite,
    target: finite,
    fee: finite,
    slippage: finite,
  })
  .strict();
export type BacktestSettings = z.infer<typeof settingsSchema>;
export const backtestReportSchema = z
  .object({
    settings: settingsSchema,
    source: z.literal("historical daily OHLC"),
    from: z.iso.date(),
    to: z.iso.date(),
    endingEquity: finite,
    returnPercent: finite,
    drawdownPercent: finite.nonnegative(),
    winRate: finite.nullable(),
    profitFactor: finite.nullable(),
    totalFees: finite.nonnegative(),
    skippedEntries: z.number().int().nonnegative(),
    equity: z.array(z.object({ date: z.iso.date(), value: finite }).strict()),
    trades: z.array(
      z
        .object({
          signalDate: z.iso.date(),
          entryDate: z.iso.date(),
          exitDate: z.iso.date(),
          quantity: z.number().int().positive(),
          entry: finite.positive(),
          exit: finite.positive(),
          pnl: finite,
          entryFee: finite.nonnegative(),
          exitFee: finite.nonnegative(),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    manifest: z
      .object({
        schemaVersion: z.literal(3),
        engineVersion: z.string().min(1),
        templateId: z.enum(["ema", "rsi", "breakout"]),
        templateVersion: z.string().min(1),
        datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
        configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
        provider: z.string().min(1),
        request: z.object({
          market: z.literal("cash"),
          stockCode: z.string(),
          instrument: z.string(),
          from: z.iso.date(),
          to: z.iso.date(),
          interval: z.literal("day"),
        }),
        fetchedAt: z.string().datetime(),
        rowCount: z.number().int().min(60).max(10000),
        timeframe: z.literal("1d"),
        source: z.literal("Stored historical database"),
        provenance: z.string().min(1),
        adjustmentPolicy: z.string().min(1),
        storage: z.literal("Owner-scoped PostgreSQL calculation job"),
        createdAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();
export type BacktestReport = z.infer<typeof backtestReportSchema>;

/** Convert validated stored history for display only; Python re-reads the authoritative dataset. */
export function dailyBarsFromHistory(dataset: HistoryDataset): DailyBar[] {
  if (dataset.request.interval !== "day" || dataset.request.market !== "cash") {
    throw new Error("This backtest requires stored daily cash-equity history.");
  }
  const bars = dataset.candles.map(({ timestamp, open, high, low, close }) => ({
    date: historyDay(0, Date.parse(timestamp)),
    open,
    high,
    low,
    close,
  }));
  if (bars.length < 60 || bars.length > 10000) {
    throw new Error("Requires 60–10,000 daily candles.");
  }
  return bars;
}

/** Validate form settings before creating a server-side job. */
export function backtestSettingsPayload(settings: BacktestSettings) {
  return settingsSchema.parse(settings);
}
