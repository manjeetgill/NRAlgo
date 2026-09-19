/**
 * Normalized NSE F&O end-of-day option history.
 *
 * Import is operator-only. Public application routes may read these tables, but
 * no browser can upload or rewrite market history. Zero-trade OHLC fields are
 * preserved and a contract is accepted only when close or settlement is positive.
 */
import { z } from "zod";
import type { Store } from "./database.js";

const optionInstrumentSchema = z
  .object({
    id: z.string().min(1).max(180),
    underlying: z.string().regex(/^[A-Z0-9&_.-]{1,40}$/),
    expiryDate: z.iso.date(),
    right: z.enum(["call", "put"]),
    strikePrice: z.number().positive().finite().max(1_000_000),
    exchange: z.literal("NSE"),
  })
  .strict();

const optionCandleSchema = z
  .object({
    day: z.iso.date(),
    open: z.number().nonnegative().finite(),
    high: z.number().nonnegative().finite(),
    low: z.number().nonnegative().finite(),
    close: z.number().nonnegative().finite(),
    settlement: z.number().nonnegative().finite().nullable(),
    volume: z.number().int().nonnegative().safe().nullable(),
    openInterest: z.number().int().nonnegative().safe().nullable(),
    changeOpenInterest: z.number().int().safe().nullable(),
    lotSize: z.number().int().positive().max(1_000_000).nullable(),
    underlyingPrice: z.number().positive().finite().nullable(),
    source: z.string().min(1).max(240),
  })
  .strict()
  .refine((row) => row.close > 0 || (row.settlement ?? 0) > 0, {
    message: "Option close and settlement cannot both be zero.",
  })
  .refine(
    (row) =>
      row.open === 0 ||
      row.high === 0 ||
      row.low === 0 ||
      (row.high >= Math.max(row.open, row.close, row.low) &&
        row.low <= Math.min(row.open, row.close)),
    { message: "Invalid traded option OHLC range." },
  );

export type StoredOptionInstrument = z.infer<typeof optionInstrumentSchema>;
export type StoredOptionCandle = z.infer<typeof optionCandleSchema>;

/** Validate and bulk-upsert one exchange-day file without one transaction per contract. */
export async function importOptionEodDailyData(store: Store, input: unknown) {
  const entries = z
    .array(
      z
        .object({
          instrument: optionInstrumentSchema,
          candle: optionCandleSchema,
        })
        .strict(),
    )
    .min(1)
    .max(20_000)
    .parse(input);
  const identities = entries.map(
    ({ instrument, candle }) => `${instrument.id}\u0000${candle.day}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("Duplicate option contract/date in import batch.");
  }
  const instruments = [
    ...new Map(
      entries.map(({ instrument }) => [instrument.id, instrument]),
    ).values(),
  ].map((instrument) => ({
    id: instrument.id,
    underlying: instrument.underlying,
    expiry_date: instrument.expiryDate,
    option_right: instrument.right,
    strike_price: instrument.strikePrice,
    exchange: instrument.exchange,
  }));
  const candles = entries.map(({ instrument, candle }) => ({
    instrument_id: instrument.id,
    day: candle.day,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    settlement: candle.settlement,
    volume: candle.volume,
    open_interest: candle.openInterest,
    change_open_interest: candle.changeOpenInterest,
    lot_size: candle.lotSize,
    underlying_price: candle.underlyingPrice,
    source: candle.source,
  }));
  await store.transaction(async (query) => {
    await query(
      `INSERT INTO option_eod_instruments(id,underlying,expiry_date,option_right,strike_price,exchange)
       SELECT id,underlying,expiry_date,option_right,strike_price,exchange
       FROM jsonb_to_recordset($1::jsonb) AS row(id text,underlying text,expiry_date date,option_right text,strike_price numeric,exchange text)
       ON CONFLICT(id) DO UPDATE SET underlying=EXCLUDED.underlying,expiry_date=EXCLUDED.expiry_date,option_right=EXCLUDED.option_right,strike_price=EXCLUDED.strike_price,exchange=EXCLUDED.exchange`,
      [JSON.stringify(instruments)],
    );
    await query(
      `INSERT INTO option_eod_candles(instrument_id,day,open,high,low,close,settlement,volume,open_interest,change_open_interest,lot_size,underlying_price,source)
       SELECT instrument_id,day,open,high,low,close,settlement,volume,open_interest,change_open_interest,lot_size,underlying_price,source
       FROM jsonb_to_recordset($1::jsonb) AS row(instrument_id text,day date,open numeric,high numeric,low numeric,close numeric,settlement numeric,volume bigint,open_interest bigint,change_open_interest bigint,lot_size integer,underlying_price numeric,source text)
       ON CONFLICT(instrument_id,day) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,settlement=EXCLUDED.settlement,volume=EXCLUDED.volume,open_interest=EXCLUDED.open_interest,change_open_interest=EXCLUDED.change_open_interest,lot_size=EXCLUDED.lot_size,underlying_price=EXCLUDED.underlying_price,source=EXCLUDED.source,imported_at=NOW()`,
      [JSON.stringify(candles)],
    );
  });
  return entries.length;
}

/** Validate and atomically upsert one bounded daily batch. Re-import is idempotent. */
export async function importOptionEodData(
  store: Store,
  instrument: unknown,
  rows: unknown,
) {
  const contract = optionInstrumentSchema.parse(instrument);
  const candles = z.array(optionCandleSchema).min(1).max(1000).parse(rows);
  if (new Set(candles.map((row) => row.day)).size !== candles.length) {
    throw new Error("Duplicate option dates in import batch.");
  }
  await store.transaction(async (query) => {
    await query(
      "INSERT INTO option_eod_instruments(id,underlying,expiry_date,option_right,strike_price,exchange) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET underlying=EXCLUDED.underlying,expiry_date=EXCLUDED.expiry_date,option_right=EXCLUDED.option_right,strike_price=EXCLUDED.strike_price,exchange=EXCLUDED.exchange",
      [
        contract.id,
        contract.underlying,
        contract.expiryDate,
        contract.right,
        contract.strikePrice,
        contract.exchange,
      ],
    );
    for (const candle of candles) {
      await query(
        "INSERT INTO option_eod_candles(instrument_id,day,open,high,low,close,settlement,volume,open_interest,change_open_interest,lot_size,underlying_price,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(instrument_id,day) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,settlement=EXCLUDED.settlement,volume=EXCLUDED.volume,open_interest=EXCLUDED.open_interest,change_open_interest=EXCLUDED.change_open_interest,lot_size=EXCLUDED.lot_size,underlying_price=EXCLUDED.underlying_price,source=EXCLUDED.source,imported_at=NOW()",
        [
          contract.id,
          candle.day,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.settlement,
          candle.volume,
          candle.openInterest,
          candle.changeOpenInterest,
          candle.lotSize,
          candle.underlyingPrice,
          candle.source,
        ],
      );
    }
  });
}

/** Return one real exchange session's expiries at or before the replay cutoff. */
export async function readOptionEodExpiries(
  store: Store,
  userInput: { underlying: string; asOf?: string },
) {
  const cutoff = userInput.asOf ?? "9999-12-31";
  return store.transaction(async (query) => {
    const [session] = await query<{ day: string }>(
      "SELECT MAX(c.day)::text AS day FROM option_eod_candles c JOIN option_eod_instruments i ON i.id=c.instrument_id WHERE i.underlying=$1 AND c.day<=$2::date",
      [userInput.underlying, cutoff],
    );
    if (!session?.day) {
      return null;
    }
    const rows = await query<{ expiry_date: string }>(
      "SELECT DISTINCT i.expiry_date::text FROM option_eod_instruments i JOIN option_eod_candles c ON c.instrument_id=i.id WHERE i.underlying=$1 AND c.day=$2::date AND i.expiry_date>=c.day ORDER BY 1",
      [userInput.underlying, session.day],
    );
    return { day: session.day, expiries: rows.map((row) => row.expiry_date) };
  });
}

/** Read one paged historical chain. Missing bid/ask is explicit because bhavcopy is EOD OHLC. */
export async function readOptionEodChain(
  store: Store,
  input: {
    underlying: string;
    expiryDate: string;
    offset: number;
    asOf?: string;
  },
) {
  const metadata = await readOptionEodExpiries(store, input);
  if (!metadata || !metadata.expiries.includes(input.expiryDate)) {
    return null;
  }
  const rows = await store.transaction((query) =>
    query<{
      id: string;
      option_right: "call" | "put";
      strike_price: number;
      close: number;
      settlement: number | null;
      volume: number | null;
      open_interest: number | null;
      lot_size: number | null;
      underlying_price: number | null;
      source: string;
      total: number;
    }>(
      `SELECT i.id,i.option_right,i.strike_price,c.close,c.settlement,c.volume,c.open_interest,c.lot_size,c.underlying_price,c.source,COUNT(*) OVER()::int AS total
       FROM option_eod_instruments i JOIN option_eod_candles c ON c.instrument_id=i.id
       WHERE i.underlying=$1 AND i.expiry_date=$2::date AND c.day=$3::date
       ORDER BY i.strike_price,i.option_right LIMIT 50 OFFSET $4`,
      [input.underlying, input.expiryDate, metadata.day, input.offset],
    ),
  );
  const total = Number(rows[0]?.total ?? 0);
  const observedAt = Date.parse(`${metadata.day}T15:30:00+05:30`);
  return {
    items: rows.map((row) => ({
      masterToken: `stored:${row.id}:${metadata.day}`,
      instrument: row.id,
      symbol: input.underlying,
      name: `${input.underlying} ${input.expiryDate} ${row.strike_price} ${row.option_right}`,
      market: "options" as const,
      lotSize: row.lot_size ?? 0,
      option: {
        expiryDate: input.expiryDate,
        right: row.option_right,
        strikePrice: Number(row.strike_price),
        lotSize: row.lot_size ?? 0,
      },
      price: Number(row.close) > 0 ? Number(row.close) : Number(row.settlement),
      bid: null,
      ask: null,
      openInterest:
        row.open_interest === null ? null : Number(row.open_interest),
      volume: row.volume === null ? null : Number(row.volume),
      change: null,
      stale: true,
      tickAt: observedAt,
    })),
    expiries: metadata.expiries,
    total,
    nextOffset: input.offset + rows.length < total ? input.offset + 50 : null,
    source: "NSE F&O bhavcopy",
    receivedAt: observedAt,
    observedAt,
    pageOffset: input.offset,
    dataMode: "historical" as const,
    sessionDay: metadata.day,
    underlyingPrice:
      rows.find((row) => Number(row.underlying_price) > 0)?.underlying_price ??
      null,
    warning:
      "End-of-day exchange observations; bid/ask depth and intraday movement are unavailable.",
  };
}
