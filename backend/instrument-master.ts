/** Read-only, bounded broker instrument catalog. Downloads never receive account tokens.
 * Sources: Breeze SecurityMaster.zip and Kotak's authenticated file-path discovery response.
 * Current contract metadata is not a historical lot-size database or a quote freshness signal.
 */
import { createRequire } from "node:module";
import { z } from "zod";
import {
  paperTradingDay,
  type PaperBroker,
  type PaperInput,
} from "./paper-model.js";
const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("breezeconnect"))(
  "csv-parse/sync",
); // Resolve the pinned SDK dependency without executing the SDK.
const AdmZip = require("adm-zip");
export const iciciMasterUrl =
  "https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip";
export const instrumentSearchSchema = z
  .object({
    market: z.enum(["cash", "options"]),
    query: z.string().trim().toUpperCase().min(2).max(40),
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
  if (typeof value !== "string") throw new Error("Missing master URL");
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
  )
    throw new Error("Unsupported master URL");
  const day = url.pathname.split("/")[4];
  if (
    !z.iso.date().safeParse(day).success ||
    day > paperTradingDay(Date.now()) ||
    Date.parse(paperTradingDay(Date.now())) - Date.parse(day) > 7 * 86400000
  )
    throw new Error("Stale master source");
  return value;
}
/** Fetch public master bytes with TLS, timeout and decompressed HTTP-body limits. */
export async function downloadInstrumentMaster(url: string): Promise<Buffer> {
  if (url !== iciciMasterUrl) {
    validateKotakMasterUrl(
      url,
      url.endsWith("nse_cm-v1.csv") ? "cash" : "options",
    );
  }
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body)
    throw new Error("Instrument master unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 32 * 1024 * 1024)
        throw new Error("Master exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
/** Normalize headers rather than column offsets; schema changes fail instead of shifting fields. */
function csvRows(csv: string, required: string[]): Record<string, string>[] {
  const rows = parse(csv, {
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
      )
        throw new Error("Unsupported master columns");
      return names;
    },
  });
  if (!rows.length || rows.length > 250000)
    throw new Error("Empty or oversized instrument master");
  return rows;
}
/** Dates in the ICICI master are English exchange dates, independent of server timezone. */
function iciciExpiry(value: string) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value),
    months = [
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
    ];
  if (!match) throw new Error("Invalid ICICI expiry");
  return z.iso
    .date()
    .parse(
      `${match[3]}-${String(months.indexOf(match[2].toLowerCase()) + 1).padStart(2, "0")}-${match[1]}`,
    );
}
/** Parse only NSE equity series and listed call/put contracts. Futures/indices are not order tickets. */
export function parseInstrumentCsv(
  broker: PaperBroker,
  market: "cash" | "options",
  csv: string,
): CatalogInstrument[] {
  const required =
    broker === "icici"
      ? market === "cash"
        ? ["Token", "ShortName", "Series", "CompanyName", "Lotsize"]
        : [
            "Token",
            "ShortName",
            "InstrumentName",
            "ExpiryDate",
            "StrikePrice",
            "OptionType",
            "LotSize",
          ]
      : [
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
    const icici = broker === "icici",
      options = market === "options",
      token = icici ? row.Token : row.pSymbol;
    if (!/^[1-9]\d{0,14}$/.test(token)) continue;
    if (!icici && row.pExchSeg !== (options ? "nse_fo" : "nse_cm"))
      throw new Error("Wrong master segment");
    if (
      options
        ? !(icici
            ? /^(OPTIDX|OPTSTK)$/.test(row.InstrumentName)
            : /^(OPTIDX|OPTSTK)$/.test(row.pInstType))
        : (icici ? row.Series : row.pGroup) !== "EQ"
    )
      continue;
    const instrument = icici ? row.ShortName : token,
      symbol = icici ? row.ShortName : row.pSymbolName;
    const lotSize = Number(
      icici ? (options ? row.LotSize : row.Lotsize) : row.lLotSize,
    );
    if (
      !/^[A-Z0-9&_.-]{1,30}$/.test(instrument) ||
      !symbol ||
      symbol.length > 40 ||
      !Number.isSafeInteger(lotSize) ||
      lotSize < 1
    )
      throw new Error("Invalid contract identity or lot size");
    // Paper tickets cap quantity at 10,000 units. Do not offer an unplaceable single lot.
    if (lotSize > 10000) continue;
    const value: CatalogInstrument = {
      masterToken: `${broker}:${market}:${token}`,
      instrument,
      symbol,
      name: (
        (icici ? row.CompanyName : row.pTrdSymbol || row.pDesc || symbol) ||
        symbol
      ).slice(0, 120),
      market,
      lotSize,
    };
    if (options) {
      const right = icici ? row.OptionType : row.pOptionType;
      if (!["CE", "PE"].includes(right))
        throw new Error("Unknown option right");
      // Kotak NSE expiry is a non-Unix epoch: official docs require +315511200, then IST.
      const epoch = Number(row.lExpiryDate);
      if (
        !icici &&
        (!Number.isSafeInteger(epoch) ||
          epoch <= 0 ||
          Number(row.lPrecision) !== 2)
      )
        throw new Error("Unsupported Kotak units");
      const expiryDate = icici
        ? iciciExpiry(row.ExpiryDate)
        : paperTradingDay((epoch + 315511200) * 1000);
      const strikePrice =
        Number(icici ? row.StrikePrice : row.dStrikePrice) / (icici ? 1 : 100);
      if (
        !Number.isFinite(strikePrice) ||
        strikePrice <= 0 ||
        strikePrice > 1000000
      )
        throw new Error("Invalid strike");
      value.option = {
        expiryDate,
        right: right === "CE" ? "call" : "put",
        strikePrice,
        lotSize,
      };
    }
    if (seen.has(value.masterToken)) throw new Error("Duplicate master token");
    seen.add(value.masterToken);
    instruments.push(value);
  }
  if (!instruments.length)
    throw new Error("No supported instruments in master");
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
      paperTradingDay(value.fetchedAt) === paperTradingDay(Date.now())
      ? value
      : undefined;
  }
  isFresh(broker: PaperBroker, market: "cash" | "options") {
    return Boolean(this.current(`${broker}:${market}`));
  }
  /** Single-flight downloads prevent simultaneous searches from multiplying large public fetches. */
  async load(broker: PaperBroker, market: "cash" | "options", url?: string) {
    if (this.isFresh(broker, market)) return;
    const key = broker === "icici" ? "icici" : `kotak:${market}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = (async () => {
      const data = await this.download(
        broker === "icici"
          ? iciciMasterUrl
          : validateKotakMasterUrl(url, market),
      );
      const fetchedAt = Date.now();
      if (broker === "icici") {
        const zip = new AdmZip(data),
          parsed: { market: "cash" | "options"; rows: CatalogInstrument[] }[] =
            [];
        for (const segment of ["cash", "options"] as const) {
          const name =
              segment === "cash"
                ? "NSEScripMaster.txt"
                : "FONSEScripMaster.txt",
            entry = zip.getEntry(name);
          if (!entry || entry.header.size > 80 * 1024 * 1024)
            throw new Error("Missing or oversized ZIP entry");
          parsed.push({
            market: segment,
            rows: parseInstrumentCsv(
              broker,
              segment,
              entry.getData().toString("utf8"),
            ),
          });
        }
        for (const item of parsed)
          this.cache.set(`icici:${item.market}`, {
            rows: item.rows,
            fetchedAt,
          });
      } else
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
  search(broker: PaperBroker, input: InstrumentSearch) {
    const data = this.current(`${broker}:${input.market}`);
    if (!data)
      throw new Error("Reload instrument search; master cache expired.");
    const matching = data.rows.filter(
      (row) =>
        (!row.option || row.option.expiryDate >= paperTradingDay(Date.now())) &&
        `${row.symbol} ${row.name} ${row.instrument}`
          .toUpperCase()
          .includes(input.query),
    );
    const underlyings = [...new Set(matching.map((row) => row.symbol))].sort();
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
  validate(
    broker: PaperBroker,
    input: Pick<PaperInput, "instrument" | "option" | "masterToken">,
    quantity?: number,
  ) {
    if (!input.masterToken) return; // Explicit legacy/manual research input is still supported.
    const data = this.current(`${broker}:${input.option ? "options" : "cash"}`),
      row = data?.rows.find((row) => row.masterToken === input.masterToken);
    if (
      !row ||
      row.instrument !== input.instrument ||
      JSON.stringify(row.option) !== JSON.stringify(input.option) ||
      (quantity !== undefined && quantity % row.lotSize !== 0)
    )
      throw new Error(
        "Selected contract changed or master expired. Search and select the contract again; quantity must be whole lots.",
      );
  }
}
