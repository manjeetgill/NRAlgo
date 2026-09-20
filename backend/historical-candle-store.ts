/**
 * Broker-agnostic historical candle repository.
 *
 * A verified Parquet manifest activates the compact read path. Without it the
 * repository falls back to PostgreSQL, which keeps upgrades and rollback safe.
 * Transactional, broker and option-history tables never pass this boundary.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance, listValue, type DuckDBValue } from "@duckdb/node-api";
import { z } from "zod";
import { root, type Store } from "./database.js";

const manifestSchema = z
  .object({
    version: z.literal(1),
    format: z.literal("parquet-zstd"),
    createdAt: z.iso.datetime(),
    source: z.object({
      rowCount: z.string().regex(/^\d+$/),
      instrumentCount: z.string().regex(/^\d+$/),
      firstDay: z.iso.date(),
      lastDay: z.iso.date(),
      valueHash: z.string().regex(/^\d+$/),
    }),
    files: z.array(
      z.object({
        path: z.string().min(1).max(240),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    bytes: z.number().int().positive(),
  })
  .strict();

export type HistoricalInstrument = {
  id: string;
  symbol: string;
  name: string;
  kind: "equity" | "index";
  series: string;
  exchange: "NSE";
  first_day: string;
  last_day: string;
  candle_count: number;
};

export type WatchlistInstrument = Omit<
  HistoricalInstrument,
  "first_day" | "last_day"
> & {
  first_day: string | null;
  last_day: string | null;
  fno: boolean;
};

export type HistoricalCandle = {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
  imported_at: string;
};

/** Convert a DuckDB JSON row to the primitive record expected by HTTP callers. */
function primitiveRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

/** Own one lazy embedded DuckDB instance and bounded archive/PostgreSQL reads. */
export class HistoricalCandleStore {
  private readonly archiveDirectory: string;
  private readonly catalogPath: string;
  private readonly candleGlob: string;
  private readonly archived: boolean;
  private instance?: Promise<DuckDBInstance>;

  /** Resolve an atomic NSE publication each request so a daily sync needs no app restart. */
  private nsePublication() {
    const directory = resolve(this.archiveDirectory, "nse");
    const pointer = resolve(directory, "current.json");
    if (!existsSync(pointer)) {
      return null;
    }
    const publication = z
      .object({
        version: z.literal(1),
        generation: z.uuid(),
        fetchedAt: z.iso.datetime(),
        files: z.record(
          z.string(),
          z.object({
            bytes: z.number().int().positive(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(pointer, "utf8")));
    const file = (name: string) => {
      const path = resolve(directory, publication.generation, name);
      if (
        !publication.files[name] ||
        !existsSync(path) ||
        statSync(path).size !== publication.files[name].bytes
      ) {
        throw new Error(
          "NSE chart publication is incomplete; run the NSE chart sync again.",
        );
      }
      return path;
    };
    return {
      catalog: file("catalog.parquet"),
      candles: file("candles.parquet"),
      fetchedAt: publication.fetchedAt,
    };
  }

  /** Browse the full current NSE catalogue, including newly listed stocks without candles. */
  public async searchWatchlistInstruments(
    queryText: string,
    offset: number,
    segment: "cash" | "fno" | "index",
  ) {
    // NSE's derivatives alias must resolve without changing saved legacy index IDs.
    if (queryText.trim().toUpperCase() === "NIFTYNXT50") {
      queryText = "NIFTY_NEXT_50";
    }
    const publication = this.nsePublication();
    if (!publication) {
      const detail =
        "The NSE stock catalogue has not been downloaded yet. Run the NSE chart sync to populate Cash, F&O and Indices.";
      throw Object.assign(new Error(detail), { status: 503, detail });
    }
    const filter =
      segment === "index"
        ? "kind='index'"
        : segment === "fno"
          ? "fno=true"
          : "kind='equity'";
    const rows = await this.parquetQuery<WatchlistInstrument>(
      `SELECT * FROM read_parquet(?) WHERE active=true AND ${filter} AND (strpos(upper(symbol),upper(?))>0 OR strpos(upper(name),upper(?))>0) ORDER BY CASE WHEN upper(symbol)=upper(?) THEN 0 WHEN starts_with(upper(symbol),upper(?)) THEN 1 ELSE 2 END,name,id LIMIT 51 OFFSET ?`,
      [publication.catalog, queryText, queryText, queryText, queryText, offset],
    );
    return {
      items: rows.slice(0, 50),
      nextOffset: rows.length > 50 ? offset + 50 : null,
      fetchedAt: publication.fetchedAt,
    };
  }

  /** Refresh saved display names in one catalogue read without rewriting the user's list. */
  public async watchlistNames(ids: string[]) {
    const publication = this.nsePublication();
    if (!publication || !ids.length) {
      return new Map<string, string>();
    }
    const rows = await this.parquetQuery<{ id: string; name: string }>(
      "SELECT id,name FROM read_parquet(?) WHERE id IN (SELECT unnest(?))",
      [publication.catalog, listValue(ids)],
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  constructor(
    private readonly store: Store,
    archiveDirectory = process.env.HISTORICAL_ARCHIVE_DIRECTORY ||
      resolve(root, ".runtime", "historical-parquet"),
  ) {
    this.archiveDirectory = resolve(archiveDirectory);
    this.catalogPath = resolve(this.archiveDirectory, "catalog.parquet");
    this.candleGlob = resolve(
      this.archiveDirectory,
      "candles",
      "year=*",
      "*.parquet",
    );
    this.archived = this.validatePublishedManifest();
  }

  /** Report the active storage engine without exposing filesystem details. */
  public mode() {
    return this.archived ? "parquet" : "postgresql";
  }

  /** Validate manifest shape, path containment and file sizes before activation. */
  private validatePublishedManifest() {
    const manifestPath = resolve(this.archiveDirectory, "manifest.json");
    if (!existsSync(manifestPath)) {
      return false;
    }
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    for (const file of manifest.files) {
      const path = resolve(this.archiveDirectory, file.path);
      if (
        !path.startsWith(`${this.archiveDirectory}/`) ||
        !existsSync(path) ||
        statSync(path).size !== file.bytes
      ) {
        throw new Error(
          "Historical archive manifest does not match its files.",
        );
      }
    }
    if (!existsSync(this.catalogPath)) {
      throw new Error("Historical archive catalog is missing.");
    }
    return true;
  }

  /** Create DuckDB only when a request actually needs archived candles. */
  private database() {
    this.instance ??= DuckDBInstance.create(":memory:", {
      threads: "2",
      max_memory: "256MB",
    });
    return this.instance;
  }

  /** Execute one bounded parameterized archive query using an isolated connection. */
  private async parquetQuery<T>(sql: string, values: DuckDBValue[] = []) {
    const connection = await (await this.database()).connect();
    try {
      const result = await connection.runAndReadAll(sql, values);
      return (await result.getRowObjectsJson()).map(primitiveRow) as T[];
    } finally {
      connection.closeSync();
    }
  }

  /** Search only instruments that have candles, in stable symbol order. */
  public async searchInstruments(queryText: string, offset: number) {
    const publication = this.nsePublication();
    if (publication) {
      // Research still requires actual candles. The watchlist catalogue deliberately does not.
      const catalogs = this.archived
        ? [publication.catalog, this.catalogPath]
        : [publication.catalog];
      return this.parquetQuery<HistoricalInstrument>(
        "SELECT id,symbol,name,kind,series,exchange,CAST(first_day AS VARCHAR) first_day,CAST(last_day AS VARCHAR) last_day,CAST(candle_count AS INTEGER) candle_count FROM (SELECT * FROM read_parquet(?,union_by_name=true) WHERE candle_count>0 QUALIFY row_number() OVER (PARTITION BY id ORDER BY last_day DESC)=1) WHERE strpos(upper(symbol),upper(?))>0 OR strpos(upper(name),upper(?))>0 ORDER BY CASE WHEN upper(symbol)=upper(?) THEN 0 ELSE 1 END,symbol,id LIMIT 51 OFFSET ?",
        [listValue(catalogs), queryText, queryText, queryText, offset],
      );
    }
    if (this.archived) {
      return this.parquetQuery<HistoricalInstrument>(
        "SELECT id,symbol,name,kind,series,exchange,CAST(first_day AS VARCHAR) AS first_day,CAST(last_day AS VARCHAR) AS last_day,CAST(candle_count AS INTEGER) AS candle_count FROM read_parquet(?) WHERE strpos(upper(symbol),upper(?))>0 OR strpos(upper(name),upper(?))>0 ORDER BY symbol,id LIMIT 51 OFFSET ?",
        [this.catalogPath, queryText, queryText, offset],
      );
    }
    return this.store.transaction((query) =>
      query<HistoricalInstrument>(
        "SELECT i.id,i.symbol,i.name,i.kind,i.series,i.exchange,MIN(c.day)::text AS first_day,MAX(c.day)::text AS last_day,COUNT(*)::int AS candle_count FROM eod_instruments i JOIN eod_candles c ON c.instrument_id=i.id WHERE strpos(upper(i.symbol),upper($1))>0 OR strpos(upper(i.name),upper($1))>0 GROUP BY i.id,i.symbol,i.name,i.kind,i.series,i.exchange ORDER BY i.symbol,i.id LIMIT 51 OFFSET $2",
        [queryText, offset],
      ),
    );
  }

  /** Read exact instrument metadata from the compact catalog or PostgreSQL. */
  public async readInstrument(id: string) {
    const publication = this.nsePublication();
    if (publication) {
      const [instrument] = await this.parquetQuery<HistoricalInstrument>(
        "SELECT id,symbol,name,kind,series,exchange,COALESCE(first_day,'') first_day,COALESCE(last_day,'') last_day,candle_count FROM read_parquet(?) WHERE id=? LIMIT 1",
        [publication.catalog, id],
      );
      if (instrument) {
        return instrument;
      }
    }
    if (this.archived) {
      const [instrument] = await this.parquetQuery<HistoricalInstrument>(
        "SELECT id,symbol,name,kind,series,exchange,CAST(first_day AS VARCHAR) AS first_day,CAST(last_day AS VARCHAR) AS last_day,CAST(candle_count AS INTEGER) AS candle_count FROM read_parquet(?) WHERE id=? LIMIT 1",
        [this.catalogPath, id],
      );
      return instrument ?? null;
    }
    const [instrument] = await this.store.transaction((query) =>
      query<HistoricalInstrument>(
        "SELECT id,symbol,name,kind,series,exchange,'' AS first_day,'' AS last_day,0::int AS candle_count FROM eod_instruments WHERE id=$1",
        [id],
      ),
    );
    return instrument ?? null;
  }

  /** Read at most 10,001 ordered rows so API callers can enforce the public cap. */
  public async readCandles(
    id: string,
    from?: string,
    to?: string,
    preferNse = false,
  ) {
    const publication = this.nsePublication();
    if (publication) {
      const candles = await this.parquetQuery<HistoricalCandle>(
        "SELECT CAST(day AS VARCHAR) AS day,open,high,low,close,volume,source,CAST(imported_at AS VARCHAR) imported_at FROM read_parquet(?) WHERE instrument_id=? AND (? IS NULL OR day>=CAST(? AS DATE)) AND (? IS NULL OR day<=CAST(? AS DATE)) ORDER BY day LIMIT 10001",
        [
          publication.candles,
          id,
          from ?? null,
          from ?? null,
          to ?? null,
          to ?? null,
        ],
      );
      // Full history from listing, not just the contiguous rolling window: merge
      // with the older archive rather than hiding it. Any multi-year discontinuity
      // is surfaced to the UI via the gaps field, not silently dropped.
      void preferNse;
      const legacy = await this.readLegacyCandles(id, from, to);
      // Exact day/identity only: no symbol-renaming guesses and no fabricated gap filling.
      const merged = new Map(legacy.map((bar) => [bar.day, bar]));
      for (const candle of candles) {
        merged.set(candle.day, candle);
      }
      return [...merged.values()]
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(0, 10001);
    }
    return this.readLegacyCandles(id, from, to);
  }

  /** Preserve the existing archive/PostgreSQL fallback; NSE updates are an additive overlay. */
  private async readLegacyCandles(id: string, from?: string, to?: string) {
    if (this.archived) {
      return this.parquetQuery<HistoricalCandle>(
        "SELECT CAST(day AS VARCHAR) AS day,open,high,low,close,volume,source,CAST(imported_at AS VARCHAR) AS imported_at FROM read_parquet(?,hive_partitioning=true) WHERE instrument_id=? AND (? IS NULL OR day>=CAST(? AS DATE)) AND (? IS NULL OR day<=CAST(? AS DATE)) ORDER BY day LIMIT 10001",
        [
          this.candleGlob,
          id,
          from ?? null,
          from ?? null,
          to ?? null,
          to ?? null,
        ],
      );
    }
    return this.store.transaction((query) =>
      query<HistoricalCandle>(
        "SELECT day::text AS day,open,high,low,close,volume,source,imported_at::text FROM eod_candles WHERE instrument_id=$1 AND ($2::date IS NULL OR day >= $2::date) AND ($3::date IS NULL OR day <= $3::date) ORDER BY day ASC LIMIT 10001",
        [id, from ?? null, to ?? null],
      ),
    );
  }

  /** Resolve one exact candle after checking stable ID and symbol together. */
  public async readDailyCandle(id: string, symbol: string, day: string) {
    const instrument = await this.readInstrument(id);
    if (!instrument || instrument.symbol !== symbol) {
      return null;
    }
    const [candle] = await this.readCandles(id, day, day);
    return candle ? { ...candle, instrument_id: id, symbol } : null;
  }

  /** Read backtest bars through the same storage selection as the public routes. */
  public async readBacktestBars(
    id: string,
    symbol: string,
    from: string,
    to: string,
  ) {
    const instrument = await this.readInstrument(id);
    if (!instrument || instrument.symbol !== symbol) {
      return [];
    }
    return this.readCandles(id, from, to);
  }
}
