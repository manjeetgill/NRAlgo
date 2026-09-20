/**
 * Historical option EOD chain repository.
 *
 * A published Parquet generation (see scripts/sync-option-eod-charts.mjs)
 * activates the compact read path. Without it the repository falls back to
 * PostgreSQL (option_eod_instruments/option_eod_candles) via the existing
 * readOptionEodChain/readOptionEodExpiries — the same safety boundary
 * HistoricalCandleStore uses for cash/index candles. Both paths render
 * through the shared shapeOptionEodChain so they cannot drift on output.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { z } from "zod";
import { root, type Query, type Store } from "./database.js";
import {
  readOptionEodChain,
  readOptionEodExpiries,
  shapeOptionEodChain,
  type OptionEodChainRow,
} from "./stored-market-data.js";

const publicationSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    fetchedAt: z.iso.datetime(),
    coverage: z.object({
      candles: z.string().regex(/^\d+$/),
      underlyings: z.number().int().nonnegative(),
      first_day: z.iso.date(),
      last_day: z.iso.date(),
    }),
    files: z
      .object({
        "catalog.parquet": z.object({
          bytes: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
        candleParts: z
          .array(
            z.object({
              path: z.string().min(1).max(240),
              bytes: z.number().int().positive(),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

/** Convert a DuckDB JSON row to the primitive record expected by callers. */
function primitiveRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ]),
  );
}

export class OptionCandleStore {
  private readonly archiveDirectory: string;
  private instance?: Promise<DuckDBInstance>;

  constructor(
    private readonly store: Store,
    archiveDirectory = resolve(
      process.env.HISTORICAL_ARCHIVE_DIRECTORY ||
        resolve(root, ".runtime", "historical-parquet"),
      "nse-options",
    ),
  ) {
    this.archiveDirectory = resolve(archiveDirectory);
  }

  /** Report the active storage engine without exposing filesystem details. */
  public mode(): "parquet" | "postgresql" {
    return this.publication() ? "parquet" : "postgresql";
  }

  /** Validate the published pointer, manifest shape and file sizes before activation. */
  private publication() {
    const pointer = resolve(this.archiveDirectory, "current.json");
    if (!existsSync(pointer)) {
      return null;
    }
    const publication = publicationSchema.parse(
      JSON.parse(readFileSync(pointer, "utf8")),
    );
    const generationDir = resolve(
      this.archiveDirectory,
      publication.generation,
    );
    const catalog = resolve(generationDir, "catalog.parquet");
    const catalogMeta = publication.files["catalog.parquet"];
    if (!existsSync(catalog) || statSync(catalog).size !== catalogMeta.bytes) {
      throw new Error(
        "Option chart publication is incomplete; run the option chart sync again.",
      );
    }
    for (const part of publication.files.candleParts) {
      const path = resolve(generationDir, part.path);
      if (
        !path.startsWith(`${generationDir}/`) ||
        !existsSync(path) ||
        statSync(path).size !== part.bytes
      ) {
        throw new Error(
          "Option chart publication is incomplete; run the option chart sync again.",
        );
      }
    }
    return {
      candleGlob: resolve(generationDir, "candles", "year=*", "*.parquet"),
      fetchedAt: publication.fetchedAt,
    };
  }

  /** Create DuckDB only when a request actually needs the archived chain. */
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

  /** Return one real exchange session's expiries at or before the replay cutoff. */
  public async readExpiries(input: { underlying: string; asOf?: string }) {
    const publication = this.publication();
    if (!publication) {
      return readOptionEodExpiries(this.store, input);
    }
    const cutoff = input.asOf ?? "9999-12-31";
    const [session] = await this.parquetQuery<{ day: string }>(
      `SELECT MAX(day)::VARCHAR AS day FROM read_parquet(?,hive_partitioning=true) WHERE underlying=? AND day<=CAST(? AS DATE)`,
      [publication.candleGlob, input.underlying, cutoff],
    );
    if (!session?.day) {
      return null;
    }
    const rows = await this.parquetQuery<{ expiry_date: string }>(
      `SELECT DISTINCT CAST(expiry_date AS VARCHAR) AS expiry_date FROM read_parquet(?,hive_partitioning=true) WHERE underlying=? AND day=CAST(? AS DATE) AND expiry_date>=CAST(? AS DATE) ORDER BY 1`,
      [publication.candleGlob, input.underlying, session.day, session.day],
    );
    return { day: session.day, expiries: rows.map((row) => row.expiry_date) };
  }

  /** Read one paged historical chain, preferring the compact Parquet archive. */
  public async readChain(input: {
    underlying: string;
    expiryDate: string;
    offset: number;
    asOf?: string;
  }) {
    const publication = this.publication();
    if (!publication) {
      return readOptionEodChain(this.store, input);
    }
    const metadata = await this.readExpiries(input);
    if (!metadata || !metadata.expiries.includes(input.expiryDate)) {
      return null;
    }
    const [centre] = await this.parquetQuery<{
      below: number;
      spot: number | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE strike_price<underlying_price)::INTEGER AS below,MAX(underlying_price) FILTER (WHERE underlying_price>0) AS spot FROM read_parquet(?,hive_partitioning=true) WHERE underlying=? AND expiry_date=CAST(? AS DATE) AND day=CAST(? AS DATE)`,
      [
        publication.candleGlob,
        input.underlying,
        input.expiryDate,
        metadata.day,
      ],
    );
    const rows = await this.parquetQuery<OptionEodChainRow>(
      `SELECT concat('NSE:FO:',underlying,':',CAST(expiry_date AS VARCHAR),':',"right",':',CAST(strike_price AS VARCHAR)) AS id,"right" AS option_right,strike_price,close,settlement,volume,open_interest,lot_size,underlying_price,source,COUNT(*) OVER()::INTEGER AS total FROM read_parquet(?,hive_partitioning=true) WHERE underlying=? AND expiry_date=CAST(? AS DATE) AND day=CAST(? AS DATE) ORDER BY strike_price,"right" LIMIT 50 OFFSET ?`,
      [
        publication.candleGlob,
        input.underlying,
        input.expiryDate,
        metadata.day,
        input.offset,
      ],
    );
    return shapeOptionEodChain(rows, centre, metadata, input);
  }

  /** Query the snapshot-cache PostgreSQL store directly for callers that need it
   * alongside the archived chain (e.g. option-chain-history.ts). */
  public transaction<T>(body: (query: Query) => Promise<T>): Promise<T> {
    return this.store.transaction(body);
  }
}
