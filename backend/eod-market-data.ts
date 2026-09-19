/** Shared, read-only daily market data. Import is operator-only, never an HTTP write. */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";
const instrumentSchema = z
  .object({
    id: z.string().min(1).max(120),
    symbol: z.string().min(1).max(60),
    name: z.string().min(1).max(160),
    kind: z.enum(["equity", "index"]),
    series: z.string().max(10),
    exchange: z.literal("NSE"),
  })
  .strict();
const candleSchema = z
  .object({
    day: z.iso.date(),
    open: z.number().positive().finite(),
    high: z.number().positive().finite(),
    low: z.number().positive().finite(),
    close: z.number().positive().finite(),
    volume: z.number().nonnegative().finite().nullable(),
    source: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (v) =>
      v.high >= Math.max(v.open, v.close, v.low) &&
      v.low <= Math.min(v.open, v.close),
    "Invalid OHLC range",
  );
export type StoredInstrument = z.infer<typeof instrumentSchema>;
export type StoredDailyCandle = z.infer<typeof candleSchema>;

/** Resolve one exact stored candle for research; symbol matching prevents stale ID reuse. */
export async function readStoredDailyCandle(
  store: Store,
  instrumentId: string,
  symbol: string,
  day: string,
) {
  return store.transaction(async (query) => {
    const [row] = await query<
      StoredDailyCandle & { instrument_id: string; symbol: string }
    >(
      "SELECT c.instrument_id,i.symbol,c.day::text AS day,c.open,c.high,c.low,c.close,c.volume,c.source FROM eod_candles c JOIN eod_instruments i ON i.id=c.instrument_id WHERE c.instrument_id=$1 AND i.symbol=$2 AND c.day=$3",
      [instrumentId, symbol, day],
    );
    return row ?? null;
  });
}

/** Idempotent normalized import boundary for the future equity/index file downloader. */
export async function importEodData(
  store: Store,
  instrument: unknown,
  rows: unknown,
  options: { preserveExisting?: boolean } = {},
) {
  const info = instrumentSchema.parse(instrument);
  const bars = z.array(candleSchema).min(1).max(10000).parse(rows);
  if (new Set(bars.map((bar) => bar.day)).size !== bars.length) {
    throw new Error("Duplicate dates in import batch");
  }
  await store.transaction(async (query) => {
    await query(
      "INSERT INTO eod_instruments(id,symbol,name,kind,series,exchange) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,kind=EXCLUDED.kind,series=EXCLUDED.series,exchange=EXCLUDED.exchange",
      [info.id, info.symbol, info.name, info.kind, info.series, info.exchange],
    );
    for (let offset = 0; offset < bars.length; offset += 500) {
      const batch = bars.slice(offset, offset + 500);
      const values = batch
        .map(
          (_, index) =>
            `(${Array.from({ length: 9 }, (_, column) => `$${index * 9 + column + 1}`).join(",")})`,
        )
        .join(",");
      await query(
        `INSERT INTO eod_candles(instrument_id,day,open,high,low,close,volume,source,imported_at) VALUES ${values} ON CONFLICT(instrument_id,day) ${options.preserveExisting ? "DO NOTHING" : "DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,source=EXCLUDED.source,imported_at=NOW()"}`,
        batch.flatMap((bar) => [
          info.id,
          bar.day,
          bar.open,
          bar.high,
          bar.low,
          bar.close,
          bar.volume,
          bar.source,
          new Date().toISOString(),
        ]),
      );
    }
  });
}

/** App login required, broker login not required. Only imported instruments are advertised. */
export function registerEodRoutes(app: Express, store: Store) {
  app.get("/api/eod/instruments", async (req, res) => {
    const { q, offset } = z
      .object({
        q: z.string().trim().min(2).max(60),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const rows = await store.transaction((query) =>
      query(
        "SELECT i.id,i.symbol,i.name,i.kind,i.series,i.exchange,MIN(c.day)::text AS first_day,MAX(c.day)::text AS last_day,COUNT(*)::int AS candle_count FROM eod_instruments i JOIN eod_candles c ON c.instrument_id=i.id WHERE strpos(upper(i.symbol),upper($1))>0 OR strpos(upper(i.name),upper($1))>0 GROUP BY i.id,i.symbol,i.name,i.kind,i.series,i.exchange ORDER BY i.symbol,i.id LIMIT 51 OFFSET $2",
        [q, offset],
      ),
    );
    res.json({
      items: rows.slice(0, 50),
      nextOffset: rows.length > 50 ? offset + 50 : null,
    });
  });
  app.get("/api/eod/candles", async (req, res) => {
    const { id, from, to } = z
      .object({
        id: z.string().min(1).max(120),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
      })
      .refine((input) => !input.from || !input.to || input.from <= input.to, {
        message: "Stored history start must not be after its end.",
      })
      .parse(req.query);
    const result = await store.transaction(async (query) => {
      const [instrument] = await query(
        "SELECT id,symbol,name,kind,series,exchange FROM eod_instruments WHERE id=$1",
        [id],
      );
      const candles = await query(
        "SELECT day::text AS day,open,high,low,close,volume,source,imported_at FROM eod_candles WHERE instrument_id=$1 AND ($2::date IS NULL OR day >= $2::date) AND ($3::date IS NULL OR day <= $3::date) ORDER BY day ASC LIMIT 10001",
        [id, from ?? null, to ?? null],
      );
      if (candles.length > 10000) {
        throw Object.assign(new Error("Stored history range is too large."), {
          status: 422,
          detail:
            "Choose a shorter stored-history range (maximum 10,000 sessions).",
        });
      }
      return {
        instrument: instrument ?? null,
        candles,
        adjustment: candles.some((bar) =>
          String(bar.source).startsWith("local-dataset:"),
        )
          ? "unknown"
          : "unadjusted",
        sources: [
          ...new Set(
            candles.map((bar) =>
              String(bar.source).startsWith("local-dataset:")
                ? "Stored historical dataset"
                : String(bar.source),
            ),
          ),
        ],
        interval: "day",
        fetchedAt: new Date().toISOString(),
      };
    });
    res.json(result);
  });
}
