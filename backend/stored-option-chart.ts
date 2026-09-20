/** Exact-contract EOD premiums. Never substitute settlement or underlying prices for OHLC. */
import type { Express } from "express";
import { z } from "zod";
import type { Store } from "./database.js";

export async function readStoredOptionChart(store: Store, id: string) {
  return store.transaction(async (query) => {
    const [instrument] = await query<{ id: string; symbol: string }>(
      `SELECT id,underlying || ' ' || expiry_date::text || ' ' || strike_price::text || ' ' || CASE option_right WHEN 'call' THEN 'CE' ELSE 'PE' END AS symbol FROM option_eod_instruments WHERE id=$1`,
      [id],
    );
    const rows = instrument
      ? await query<{
          day: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number | null;
        }>(
          `SELECT day::text,open::float8,high::float8,low::float8,close::float8,volume::float8
       FROM option_eod_candles WHERE instrument_id=$1 ORDER BY day LIMIT 10001`,
          [id],
        )
      : [];
    if (rows.length > 10000) {
      throw Object.assign(
        new Error("Option history exceeds 10,000 sessions."),
        { status: 422 },
      );
    }
    const candles = rows.filter(
      (bar) =>
        [bar.open, bar.high, bar.low, bar.close].every(
          (price) => Number.isFinite(price) && price > 0,
        ) &&
        bar.high >= Math.max(bar.open, bar.close, bar.low) &&
        bar.low <= Math.min(bar.open, bar.close) &&
        (bar.volume === null ||
          (Number.isFinite(bar.volume) && bar.volume >= 0)),
    );
    return {
      instrument: instrument ?? null,
      candles,
      interval: "day" as const,
      adjustment: "unadjusted" as const,
      sources: ["nse-fno-bhavcopy"],
      excludedSessions: rows.length - candles.length,
      gaps: candles.flatMap((bar, index) =>
        index &&
        Date.parse(bar.day) - Date.parse(candles[index - 1].day) > 10 * 86400000
          ? [{ from: candles[index - 1].day, to: bar.day }]
          : [],
      ),
    };
  });
}

/** Mounted behind the app's existing authentication, without requiring broker credentials. */
export function registerStoredOptionCharts(app: Express, store: Store) {
  app.get("/api/eod/option-candles", async (req, res) => {
    const { id } = z
      .object({
        id: z
          .string()
          .max(160)
          .regex(
            /^NSE:FO:[A-Z0-9&_.-]+:\d{4}-\d{2}-\d{2}:(call|put):\d+(?:\.\d+)?$/,
          ),
      })
      .parse(req.query);
    res.json(await readStoredOptionChart(store, id));
  });
}
