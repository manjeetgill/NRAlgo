/**
 * Browser boundary for operator-imported market data: instrument schemas and validated daily reads.
 * Shared by pickers and research screens; preserves source, identity and adjustment metadata.
 * Missing history is not synthesized and this module performs no backtest calculations.
 */
import { z } from "zod";
import { requestApiJson } from "./api";
import { validateHistoryDataset, type HistoryDataset } from "./market-history";

export const storedInstrumentSchema = z.object({
  id: z.string().min(1).max(120),
  symbol: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  kind: z.enum(["equity", "index"]),
  series: z.string().max(10),
  exchange: z.literal("NSE"),
  first_day: z.iso.date(),
  last_day: z.iso.date(),
  candle_count: z.number().int().positive(),
});
export const storedInstrumentSearchSchema = z.object({
  items: z.array(storedInstrumentSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type StoredInstrument = z.infer<typeof storedInstrumentSchema>;
export type StoredInstrumentSearch = z.infer<
  typeof storedInstrumentSearchSchema
>;

const storedCandleSchema = z.object({
  day: z.iso.date(),
  open: z.number().positive().finite(),
  high: z.number().positive().finite(),
  low: z.number().positive().finite(),
  close: z.number().positive().finite(),
  volume: z.number().nonnegative().finite().nullable(),
  source: z.string().min(1),
  imported_at: z.union([z.string(), z.date()]),
});
const storedHistorySchema = z.object({
  instrument: storedInstrumentSchema
    .omit({ first_day: true, last_day: true, candle_count: true })
    .nullable(),
  candles: z.array(storedCandleSchema).max(10000),
  adjustment: z.enum(["unknown", "unadjusted"]),
  sources: z.array(z.string()),
  interval: z.literal("day"),
  fetchedAt: z.string().datetime(),
});

/** Fetch one explicit range from stored data and preserve its stable identity in the report manifest. */
export async function fetchStoredDailyHistory(
  instrument: StoredInstrument,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<HistoryDataset> {
  const request = {
    market: "cash" as const,
    stockCode: instrument.symbol,
    instrument: instrument.id,
    from,
    to,
    interval: "day" as const,
  };
  const result = storedHistorySchema.parse(
    await requestApiJson(
      `/eod/candles?id=${encodeURIComponent(instrument.id)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      "GET",
      undefined,
      undefined,
      30000,
      signal,
    ),
  );
  if (!result.instrument || result.instrument.id !== instrument.id) {
    throw new Error("Stored instrument is unavailable.");
  }
  const dataset: HistoryDataset = {
    source: result.sources.join(", ") || "Stored historical dataset",
    instrument: {
      masterToken: instrument.id,
      market: "cash",
      symbol: instrument.symbol,
      name: instrument.name,
      instrument: instrument.id,
      lotSize: 1,
    },
    request,
    candles: result.candles.map(
      /** Daily timestamps use an explicit IST offset and are never inferred from browser locale. */ (
        candle,
      ) => ({
        timestamp: `${candle.day}T00:00:00+05:30`,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        openInterest: null,
      }),
    ),
    fetchedAt: result.fetchedAt,
    adjustmentPolicy:
      result.adjustment === "unknown"
        ? "Adjustment policy unknown; verify the stored dataset before relying on returns."
        : "Stored prices are unadjusted.",
    coverage: `${instrument.first_day} to ${instrument.last_day}`,
  };
  return validateHistoryDataset(dataset, request);
}
