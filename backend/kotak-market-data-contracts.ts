/** Validates market-data requests and converts Kotak responses into safe display data.
 * Explorer data is indicative and is never passed to live execution.
 * Source: Kotak-Neo/Kotak-Neo/docs/market-data-apis (reviewed 2026-09-18).
 */
import { z } from "zod";

export const quoteFilters = [
  "all",
  "52W",
  "scrip_details",
  "circuit_limits",
  "ohlc",
  "oi",
  "depth",
  "ltp",
] as const;
export const historyIntervals = [
  "1min",
  "3min",
  "5min",
  "10min",
  "15min",
  "30min",
  "60min",
  "D",
  "W",
] as const;
const quoteSegment = z.enum(["nse_cm", "bse_cm", "nse_fo", "bse_fo", "cde_fo"]);
const token = z.string().regex(/^\d{1,15}$/);
const instrument = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9 &_.-]+$/);
export const quoteInstrument = z
  .object({ exchange: quoteSegment, instrument })
  .strict()
  .refine(
    (row) =>
      ["nse_cm", "bse_cm"].includes(row.exchange) ||
      token.safeParse(row.instrument).success,
    "Derivative instruments require a pSymbol token.",
  );
const derivativeQuery = {
  exchange: z.enum(["nse_fo", "bse_fo", "mcx_fo"]),
  underlying: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[A-Za-z0-9 &_.-]+$/),
  instrumentType: z.enum(["option", "fut"]).default("option"),
};
export const marketRequestSchema = z
  .discriminatedUnion("operation", [
    z.object({ operation: z.literal("instruments") }).strict(),
    z
      .object({
        operation: z.literal("quotes"),
        instruments: z.array(quoteInstrument).min(1).max(50),
        filter: z.enum(quoteFilters).default("all"),
      })
      .strict(),
    z.object({ operation: z.literal("expiries"), ...derivativeQuery }).strict(),
    z
      .object({
        operation: z.literal("chain"),
        ...derivativeQuery,
        expiry: z.iso.date().optional(),
        count: z.number().int().min(10).max(100).multipleOf(10).default(40),
      })
      .strict(),
    z
      .object({
        operation: z.literal("history"),
        exchange: z.enum(["nse_cm", "nse_fo", "bse_cm", "bse_fo"]),
        instrument: token,
        from: z.iso.date(),
        to: z.iso.date(),
        interval: z.enum(historyIntervals),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (
      input.operation === "quotes" &&
      new Set(
        input.instruments.map((row) => `${row.exchange}|${row.instrument}`),
      ).size !== input.instruments.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate quote instruments." });
    }
    if (input.operation !== "history") {
      return;
    }
    const limits = {
      "1min": 30,
      "3min": 30,
      "5min": 30,
      "10min": 60,
      "15min": 60,
      "30min": 90,
      "60min": 90,
      D: 180,
      W: 180,
    };
    const days = (Date.parse(input.to) - Date.parse(input.from)) / 86400000 + 1;
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    if (days < 1 || days > limits[input.interval] || input.to > today) {
      ctx.addIssue({
        code: "custom",
        message: `History requires an ordered, non-future range of at most ${limits[input.interval]} calendar days.`,
      });
    }
  });
export type MarketRequest = z.infer<typeof marketRequestSchema>;

/** Translate validated UI names into documented wire names. No client can supply a URL/path. */
export function buildKotakMarketDataPath(input: MarketRequest): string {
  switch (input.operation) {
    case "instruments":
      return "/script-details/1.0/masterscrip/file-paths";
    case "quotes": {
      const instrumentNames = input.instruments.map((instrument) => {
        return `${instrument.exchange}|${instrument.instrument}`;
      });
      const encodedInstruments = encodeURIComponent(instrumentNames.join(","));
      return `/script-details/1.0/quotes/neosymbol/${encodedInstruments}/${input.filter}`;
    }
    case "history": {
      const query = new URLSearchParams({
        neosymbol: `${input.exchange}|${input.instrument}`,
        fromdate: input.from,
        todate: input.to,
        interval: input.interval,
      });
      return `/market-data/1.0/historical/details?${query}`;
    }
    default: {
      const query = new URLSearchParams({
        exchange: input.exchange,
        underlying: input.underlying,
        instrument_type: input.instrumentType,
      });
      if (input.operation === "chain") {
        if (input.expiry) {
          query.set("expiry", input.expiry);
        }
        query.set("count", String(input.count));
      }
      if (input.operation === "chain") {
        return `/market-data/1.0/watchlist/option-chain?${query}`;
      }
      return `/market-data/1.0/watchlist/expiries?${query}`;
    }
  }
}

const numeric = z
  .union([
    z.number().finite(),
    z
      .string()
      .trim()
      .regex(/^-?\d+(?:\.\d+)?$/),
  ])
  .transform(Number)
  .refine(
    (value) =>
      Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER,
  );
const nullableNumber = numeric.nullish().transform((value) => value ?? null);
/** Accept success spelling/case variants without treating arbitrary status values as success. */
export const kotakHistoryStatus = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["success", "ok"]).optional(),
);
const label = z.string().max(160);
// Explicit field lists are intentional. They are easier to compare with Kotak's docs,
// and Zod removes every unlisted field, including accidental credential/debug fields.
const orderBookLevelSchema = z.object({
  price: nullableNumber,
  quantity: nullableNumber,
  orders: nullableNumber,
});
const quoteRow = z.object({
  exchange: quoteSegment,
  exchange_token: z
    .union([label, z.number().int().nonnegative()])
    .transform(String),
  display_symbol: label.optional(),
  lstup_time: nullableNumber,
  ltp: nullableNumber,
  last_traded_quantity: nullableNumber,
  total_buy: nullableNumber,
  total_sell: nullableNumber,
  last_volume: nullableNumber,
  change: nullableNumber,
  per_change: nullableNumber,
  year_high: nullableNumber,
  year_low: nullableNumber,
  open_int: nullableNumber,
  oi: nullableNumber,
  upper_circuit: nullableNumber,
  lower_circuit: nullableNumber,
  lot_size: nullableNumber,
  tick_size: nullableNumber,
  ohlc: z
    .object({
      open: nullableNumber,
      high: nullableNumber,
      low: nullableNumber,
      close: nullableNumber,
    })
    .optional(),
  depth: z
    .object({
      buy: z.array(orderBookLevelSchema).max(5),
      sell: z.array(orderBookLevelSchema).max(5),
    })
    .optional(),
});
const masterFiles = new Map([
  ["transformed-v1/nse_cm-v1.csv", "nse_cm"],
  ["transformed-v1/bse_cm-v1.csv", "bse_cm"],
  ["transformed/nse_fo.csv", "nse_fo"],
  ["transformed/bse_fo.csv", "bse_fo"],
  ["transformed/cde_fo.csv", "cde_fo"],
  ["transformed/mcx_fo.csv", "mcx_fo"],
  ["transformed/nse_com.csv", "nse_com"],
]);
/** Discovery links point only to dated Kotak master CSVs. They contain no auth credentials. */
function parseInstrumentMasterFiles(raw: unknown) {
  const paths = z
    .object({
      data: z.object({ filesPaths: z.array(z.string()).min(1).max(20) }),
    })
    .parse(raw).data.filesPaths;
  const files = paths.map((url) => {
    const match =
      /^https:\/\/lapi\.kotaksecurities\.com\/wso2-scripmaster\/v1\/prod\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(
        url,
      );
    const exchange = match && masterFiles.get(match[2]);
    if (!match || !exchange || !z.iso.date().safeParse(match[1]).success) {
      throw new Error("Unsupported instrument file.");
    }
    return { exchange, date: match[1], url };
  });
  if (new Set(files.map((file) => file.exchange)).size !== files.length) {
    throw new Error("Duplicate instrument files.");
  }
  return { files };
}

/** Reject mismatched identities and invalid candles; missing OI remains null, not zero. */
export function parseKotakMarketDataResponse(
  input: MarketRequest,
  raw: unknown,
) {
  switch (input.operation) {
    case "instruments":
      return parseInstrumentMasterFiles(raw);
    case "quotes":
      return parseQuoteSnapshots(input.instruments, raw);
    case "expiries":
      return parseContractExpiries(input.exchange, input.underlying, raw);
    case "history":
      return parseHistoricalCandles(input, raw);
    case "chain":
      return parseOptionAndFuturesChain(input, raw);
  }
}

/** Match every returned quote to a requested instrument. Partial responses report missing
 * instruments explicitly; a successful HTTP response alone does not mean prices are current.
 */
function parseQuoteSnapshots(
  instruments: { exchange: string; instrument: string }[],
  raw: unknown,
) {
  const rows = z.array(quoteRow).max(50).parse(raw);
  const requested = new Set(
    instruments.map((row) => `${row.exchange}|${row.instrument}`),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.exchange}|${row.exchange_token}`;
    if (!requested.has(key) || seen.has(key)) {
      throw new Error("Quote identity mismatch.");
    }
    seen.add(key);
  }
  return {
    quotes: rows.map((row) => ({
      ...row,
      stale:
        row.lstup_time === null ||
        Date.now() - row.lstup_time * 1000 > 15000 ||
        row.lstup_time * 1000 > Date.now() + 5000,
    })),
    missing: [...requested].filter((key) => !seen.has(key)),
  };
}

/** Verify the broker answered for the requested underlying before returning sorted dates. */
function parseContractExpiries(
  exchange: string,
  underlying: string,
  raw: unknown,
) {
  const result = z
    .object({
      exchange: z.literal(exchange),
      underlying: z.literal(underlying),
      expiries: z.array(z.iso.date()).max(500),
    })
    .parse(raw);
  return { ...result, expiries: [...new Set(result.expiries)].sort() };
}

/** Convert positional broker candles to named fields. Reject gaps in ordering, invalid prices
 * and dates outside the request. Missing open interest is allowed by Kotak's current API.
 */
function parseHistoricalCandles(
  input: { from: string; to: string; interval: string },
  raw: unknown,
) {
  const result = z
    .object({
      // Some data hosts omit the envelope echoes. The exact request still owns
      // this response; validate all candles and reject explicit errors/mismatches.
      status: kotakHistoryStatus,
      interval: z.literal(input.interval).optional(),
      data: z.object({
        candles: z
          .array(
            z.tuple([
              z.string(),
              numeric,
              numeric,
              numeric,
              numeric,
              nullableNumber,
              nullableNumber.optional(),
            ]),
          )
          .max(20000),
      }),
    })
    .parse(raw);
  let previous = -Infinity;
  const candles = result.data.candles.map(
    ([timestamp, open, high, low, close, volume, openInterest]) => {
      if (
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(
          timestamp,
        ) ||
        !z.iso.date().safeParse(timestamp.slice(0, 10)).success
      ) {
        throw new Error("Invalid candle time.");
      }
      const epoch = Date.parse(
        timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
      );
      if (!Number.isFinite(epoch) || epoch <= previous) {
        throw new Error("Unordered or invalid candles.");
      }
      const day = new Date(epoch + 19800000).toISOString().slice(0, 10);
      if (
        day < input.from ||
        day > input.to ||
        low < 0 ||
        low > Math.min(open, close) ||
        high < Math.max(open, close) ||
        high < low ||
        (volume !== null && volume < 0) ||
        (openInterest !== null &&
          openInterest !== undefined &&
          openInterest < 0)
      ) {
        throw new Error("Invalid candle range or values.");
      }
      previous = epoch;
      return {
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        openInterest: openInterest ?? null,
      };
    },
  );
  return {
    interval: input.interval,
    candles,
    coverage: "Active contracts only; empty history is not synthetic data.",
  };
}

/** Options and futures have different documented response fields. Keep those differences here
 * so UI callers receive validated records without knowing how to validate broker messages.
 */
function parseOptionAndFuturesChain(
  input: {
    exchange: string;
    underlying: string;
    instrumentType: "option" | "fut";
    expiry?: string;
  },
  raw: unknown,
) {
  const common = z.object({
    mktLot: numeric,
    multiplier: numeric,
    unlSymbol: z.literal(input.underlying),
    exSeg: z.literal(input.exchange),
    expiryDt: z.iso.date().nullable(),
  });
  const option = z.object({
    instrument: z.object({
      neoSymbol: label,
      symbol: label,
      optionType: z.enum(["CE", "PE"]),
      strikePrice: numeric,
      moneyness: label.optional(),
    }),
    quote: z.object({
      ltp: nullableNumber,
      open: nullableNumber,
      high: nullableNumber,
      low: nullableNumber,
      prevClose: nullableNumber,
      close: nullableNumber,
      volume: nullableNumber,
    }),
    openInterest: z.object({
      current: nullableNumber,
      previous: nullableNumber,
      change: nullableNumber,
      changePct: nullableNumber,
    }),
  });
  const future = z.object({
    inst: z.object({
      neoSymbol: label,
      symbol: label,
      expiryDt: z.string().regex(/^\d{2}-[A-Z]{3}-\d{4}$/),
    }),
    quote: z.object({
      ltp: nullableNumber,
      o: nullableNumber,
      h: nullableNumber,
      l: nullableNumber,
      c: nullableNumber,
      pc: nullableNumber,
      vol: nullableNumber,
    }),
    oi: z.object({
      cur: nullableNumber,
      prev: nullableNumber,
      chg: nullableNumber,
      chgPct: nullableNumber,
    }),
  });
  const chain = z
    .object({
      data: z.object({
        common_data: common,
        call: z.array(option).max(100),
        put: z.array(option).max(100),
        fut: z.array(future).max(100).optional(),
      }),
    })
    .parse(raw).data;
  if (input.expiry && chain.common_data.expiryDt !== input.expiry) {
    throw new Error("Chain expiry mismatch.");
  }
  if (
    input.instrumentType === "option" &&
    (chain.common_data.expiryDt === null || chain.fut?.length)
  ) {
    throw new Error("Unexpected option chain.");
  }
  if (
    input.instrumentType === "fut" &&
    (chain.call.length || chain.put.length || !chain.fut)
  ) {
    throw new Error("Unexpected futures chain.");
  }
  for (const row of chain.fut || []) {
    const [day, month, year] = row.inst.expiryDt.split("-");
    const monthNumber =
      [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ].indexOf(month) + 1;
    const expiry = `${year}-${String(monthNumber).padStart(2, "0")}-${day}`;
    if (
      !z.iso.date().safeParse(expiry).success ||
      (input.expiry && expiry !== input.expiry)
    ) {
      throw new Error("Invalid futures expiry.");
    }
  }
  const seen = new Set<string>();
  for (const call of chain.call) {
    if (call.instrument.optionType !== "CE") {
      throw new Error("Chain side mismatch.");
    }
  }
  for (const put of chain.put) {
    if (put.instrument.optionType !== "PE") {
      throw new Error("Chain side mismatch.");
    }
  }
  const contractSymbols: string[] = [];
  for (const call of chain.call) {
    contractSymbols.push(call.instrument.neoSymbol);
  }
  for (const put of chain.put) {
    contractSymbols.push(put.instrument.neoSymbol);
  }
  for (const future of chain.fut || []) {
    contractSymbols.push(future.inst.neoSymbol);
  }
  for (const symbol of contractSymbols) {
    if (
      !new RegExp(`^${input.exchange}\\|\\d{1,15}$`).test(symbol) ||
      seen.has(symbol)
    ) {
      throw new Error("Chain token mismatch.");
    }
    seen.add(symbol);
  }
  return {
    ...chain,
    observedAt: null,
    indicative: true,
    note: "This API does not provide an exchange timestamp or executable bid/ask.",
  };
}
