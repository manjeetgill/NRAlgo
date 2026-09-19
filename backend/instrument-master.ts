/** Read-only, bounded broker instrument catalog. Downloads never receive account tokens.
 * Source: Kotak's authenticated file-path discovery response.
 * Current contract metadata is not a historical lot-size database or a quote freshness signal.
 */
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  tradingDay,
  type InstrumentSelection,
  type MarketDataBroker,
} from "./market-contracts.js";
export const instrumentSearchSchema = z
  .object({
    market: z.enum(["cash", "options"]),
    // Empty browsing is permitted only for Kotak cash by the authenticated route.
    query: z.string().trim().toUpperCase().max(40),
    expiryDate: z.iso.date().optional(),
    underlying: z.string().trim().toUpperCase().min(1).max(40).optional(),
    right: z.enum(["call", "put"]).optional(),
    offset: z.number().int().min(0).max(250000).default(0),
  })
  .strict();
export type InstrumentSearch = z.infer<typeof instrumentSearchSchema>;
export interface CatalogInstrument {
  masterToken: string;
  instrument: string;
  symbol: string;
  name: string;
  market: "cash" | "options";
  lotSize: number;
  tickPaise?: number;
  option?: {
    expiryDate: string;
    right: "call" | "put";
    strikePrice: number;
    lotSize: number;
  };
}
/** Reject redirects, credentials, query strings, lookalike hosts and non-master paths. */
export function validateKotakMasterUrl(
  value: unknown,
  market: "cash" | "options",
) {
  if (typeof value !== "string") {
    throw new Error("Missing master URL");
  }
  const url = new URL(value),
    suffix =
      market === "cash"
        ? "transformed-v1/nse_cm-v1.csv"
        : "transformed/nse_fo.csv";
  if (
    url.origin !== "https://lapi.kotaksecurities.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new RegExp(
      `^/wso2-scripmaster/v1/prod/\\d{4}-\\d{2}-\\d{2}/${suffix.replaceAll(".", "\\.")}$`,
    ).test(url.pathname)
  ) {
    throw new Error("Unsupported master URL");
  }
  const day = url.pathname.split("/")[4];
  if (
    !z.iso.date().safeParse(day).success ||
    day > tradingDay(Date.now()) ||
    Date.parse(tradingDay(Date.now())) - Date.parse(day) > 7 * 86400000
  ) {
    throw new Error("Stale master source");
  }
  return value;
}
/** Fetch public master bytes with TLS, timeout and decompressed HTTP-body limits. */
export async function downloadInstrumentMaster(url: string): Promise<Buffer> {
  validateKotakMasterUrl(
    url,
    url.endsWith("nse_cm-v1.csv") ? "cash" : "options",
  );
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) {
    throw new Error("Instrument master unavailable");
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.length;
      if (bytes > 32 * 1024 * 1024) {
        throw new Error("Master exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
/** Normalize headers rather than column offsets; schema changes fail instead of shifting fields. */
function csvRows(csv: string, required: string[]): Record<string, string>[] {
  const rows = parse<Record<string, string>>(csv, {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    max_record_size: 20000,
    to: 250001,
    columns: (headers: string[]) => {
      const names = headers.map((name) => name.trim().replace(/;$/, ""));
      if (
        new Set(names).size !== names.length ||
        required.some((name) => !names.includes(name))
      ) {
        throw new Error("Unsupported master columns");
      }
      return names;
    },
  });
  if (!rows.length || rows.length > 250000) {
    throw new Error("Empty or oversized instrument master");
  }
  return rows;
}
/** Parse only NSE equity series and listed call/put contracts. Futures/indices are not order tickets. */
export function parseInstrumentCsv(
  broker: MarketDataBroker,
  market: "cash" | "options",
  csv: string,
): CatalogInstrument[] {
  const required = [
    "pSymbol",
    "pExchSeg",
    "pSymbolName",
    "pTrdSymbol",
    "lLotSize",
    ...(market === "options"
      ? [
          "pInstType",
          "pOptionType",
          "lExpiryDate",
          "dStrikePrice",
          "lPrecision",
        ]
      : ["pGroup"]),
  ];
  const instruments: CatalogInstrument[] = [],
    seen = new Set<string>();
  for (const row of csvRows(csv, required)) {
    const options = market === "options",
      token = row.pSymbol;
    if (!/^[1-9]\d{0,14}$/.test(token)) {
      continue;
    }
    if (row.pExchSeg !== (options ? "nse_fo" : "nse_cm")) {
      throw new Error("Wrong master segment");
    }
    if (
      options ? !/^(OPTIDX|OPTSTK)$/.test(row.pInstType) : row.pGroup !== "EQ"
    ) {
      continue;
    }
    const instrument = token,
      symbol = row.pSymbolName;
    const lotSize = Number(row.lLotSize);
    if (
      !/^[A-Z0-9&_.-]{1,30}$/.test(instrument) ||
      !symbol ||
      symbol.length > 40 ||
      !Number.isSafeInteger(lotSize) ||
      lotSize < 1
    ) {
      throw new Error("Invalid contract identity or lot size");
    }
    // Bound quantities accepted by account and research consumers.
    if (lotSize > 10000) {
      continue;
    }
    const value: CatalogInstrument = {
      masterToken: `${broker}:${market}:${token}`,
      instrument,
      symbol,
      name: (row.pTrdSymbol || row.pDesc || symbol).slice(0, 120),
      market,
      lotSize,
      ...(Number.isSafeInteger(Number(row.dTickSize)) &&
      Number(row.dTickSize) > 0
        ? { tickPaise: Number(row.dTickSize) }
        : {}),
    };
    if (options) {
      const right = row.pOptionType;
      if (!["CE", "PE"].includes(right)) {
        throw new Error("Unknown option right");
      }
      // Kotak NSE expiry is a non-Unix epoch: official docs require +315511200, then IST.
      const epoch = Number(row.lExpiryDate);
      if (
        !Number.isSafeInteger(epoch) ||
        epoch <= 0 ||
        Number(row.lPrecision) !== 2
      ) {
        throw new Error("Unsupported Kotak units");
      }
      const expiryDate = tradingDay((epoch + 315511200) * 1000);
      const strikePrice = Number(row.dStrikePrice) / 100;
      if (
        !Number.isFinite(strikePrice) ||
        strikePrice <= 0 ||
        strikePrice > 1000000
      ) {
        throw new Error("Invalid strike");
      }
      value.option = {
        expiryDate,
        right: right === "CE" ? "call" : "put",
        strikePrice,
        lotSize,
      };
    }
    if (seen.has(value.masterToken)) {
      throw new Error("Duplicate master token");
    }
    seen.add(value.masterToken);
    instruments.push(value);
  }
  if (!instruments.length) {
    throw new Error("No supported instruments in master");
  }
  return instruments.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      (a.option?.expiryDate || "").localeCompare(b.option?.expiryDate || "") ||
      (a.option?.strikePrice || 0) - (b.option?.strikePrice || 0) ||
      (a.option?.right || "").localeCompare(b.option?.right || ""),
  );
}
/** Small shared cache contains public contract metadata only; never account tokens or portfolios. */
export class InstrumentCatalog {
  private cache = new Map<
    string,
    { rows: CatalogInstrument[]; fetchedAt: number }
  >();
  private pending = new Map<string, Promise<void>>();
  constructor(
    private download: (
      url: string,
    ) => Promise<Buffer> = downloadInstrumentMaster,
  ) {}
  /** Require both short TTL and same IST date; stale metadata is not usable for selected tickets. */
  private current(key: string) {
    const value = this.cache.get(key);
    return value &&
      Date.now() - value.fetchedAt < 15 * 60000 &&
      tradingDay(value.fetchedAt) === tradingDay(Date.now())
      ? value
      : undefined;
  }
  /** Check master freshness before resolving contracts; stale metadata cannot authorize execution. */
  public isFresh(broker: MarketDataBroker, market: "cash" | "options") {
    return Boolean(this.current(`${broker}:${market}`));
  }
  /** Live execution never trusts client-supplied symbols, tick sizes or lot sizes. */
  public resolveLive(masterToken: string) {
    const match = /^kotak:(cash|options):[1-9]\d{0,14}$/.exec(masterToken);
    const row =
      match &&
      this.current(`kotak:${match[1]}`)?.rows.find(
        (r) => r.masterToken === masterToken,
      );
    if (
      !row ||
      !row.tickPaise ||
      (row.option && row.option.expiryDate < tradingDay(Date.now()))
    ) {
      throw new Error(
        "Reload Kotak master; a current contract with a verified tick size is required",
      );
    }
    return row;
  }
  /** Single-flight downloads prevent simultaneous searches from multiplying large public fetches. */
  public async load(
    broker: MarketDataBroker,
    market: "cash" | "options",
    url?: string,
  ) {
    if (this.isFresh(broker, market)) {
      return;
    }
    const key = `${broker}:${market}`;
    if (this.pending.has(key)) {
      return this.pending.get(key);
    }
    const work = (async () => {
      const data = await this.download(validateKotakMasterUrl(url, market));
      const fetchedAt = Date.now();
      this.cache.set(key, {
        rows: parseInstrumentCsv(broker, market, data.toString("utf8")),
        fetchedAt,
      });
    })();
    this.pending.set(key, work);
    try {
      await work;
    } finally {
      this.pending.delete(key);
    }
  }
  /** Return bounded pages plus expiry facets; master listings do not imply executable quotes. */
  public search(broker: MarketDataBroker, input: InstrumentSearch) {
    const data = this.current(`${broker}:${input.market}`);
    if (!data) {
      throw new Error("Reload instrument search; master cache expired.");
    }
    const matching = data.rows.filter(
      (row) =>
        (!row.option || row.option.expiryDate >= tradingDay(Date.now())) &&
        `${row.symbol} ${row.name} ${row.instrument}`
          .toUpperCase()
          .includes(input.query),
    );
    const underlyings = [...new Set(matching.map((row) => row.symbol))].sort();
    if (input.market === "cash") {
      matching.sort(
        (a, b) =>
          a.symbol.localeCompare(b.symbol) ||
          a.instrument.localeCompare(b.instrument),
      );
    }
    const scoped = matching.filter(
      (row) => !input.underlying || row.symbol === input.underlying,
    );
    const expiries = [
      ...new Set(
        scoped.flatMap((row) => (row.option ? [row.option.expiryDate] : [])),
      ),
    ].sort();
    const rows = scoped.filter(
      (row) =>
        (!input.expiryDate || row.option?.expiryDate === input.expiryDate) &&
        (!input.right || row.option?.right === input.right),
    );
    return {
      items: rows.slice(input.offset, input.offset + 50),
      total: rows.length,
      expiries,
      underlyings: underlyings.slice(0, 500),
      fetchedAt: data.fetchedAt,
      nextOffset: input.offset + 50 < rows.length ? input.offset + 50 : null,
    };
  }
  /** Selected tickets must match the cached broker contract exactly; browser metadata is not authority. */
  /** Resolve an exact research contract; never translate broker aliases or guess a token. */
  public resolveResearch(
    broker: MarketDataBroker,
    market: "cash" | "options",
    leg: {
      stockCode: string;
      expiryDate?: string;
      right?: string;
      strikePrice?: number;
    },
  ) {
    const data = this.current(`${broker}:${market}`);
    if (!data) {
      throw new Error("Reload the broker instrument master first.");
    }
    const matches = data.rows.filter(
      (row) =>
        row.symbol === leg.stockCode &&
        (market === "cash" ||
          (row.option?.expiryDate === leg.expiryDate &&
            row.option?.right === leg.right &&
            row.option?.strikePrice === leg.strikePrice)),
    );
    if (matches.length !== 1) {
      throw new Error(
        "Exact contract not found in the current broker master. Use that broker's symbol and a listed contract; expired token history is not guessed.",
      );
    }
    return matches[0];
  }
  /** Selected tickets must match the cached broker contract exactly; browser metadata is not authority. */
  public validate(
    broker: MarketDataBroker,
    input: InstrumentSelection,
    quantity?: number,
  ) {
    if (!input.masterToken) {
      return;
    } // Explicit legacy/manual research input is still supported.
    const data = this.current(`${broker}:${input.option ? "options" : "cash"}`),
      row = data?.rows.find((row) => row.masterToken === input.masterToken);
    if (
      !row ||
      row.instrument !== input.instrument ||
      JSON.stringify(row.option) !== JSON.stringify(input.option) ||
      (quantity !== undefined && quantity % row.lotSize !== 0)
    ) {
      throw new Error(
        "Selected contract changed or master expired. Search and select the contract again; quantity must be whole lots.",
      );
    }
  }
}
