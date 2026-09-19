/**
 * Explicit finalizer for the immutable daily-candle Parquet migration.
 *
 * This command keeps the table schema and instrument catalog, locks the exact
 * candle table, compares its complete manifest statistics, and truncates only
 * after an operator supplies the literal confirmation argument.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";

const confirmation = "--confirm-retire-eod-candles";
if (!process.argv.includes(confirmation)) {
  throw new Error(`Refusing to change PostgreSQL without ${confirmation}.`);
}

const archiveDirectory = resolve(
  process.env.HISTORICAL_ARCHIVE_DIRECTORY ||
    resolve(process.cwd(), ".runtime", "historical-parquet"),
);
const manifestPath = resolve(archiveDirectory, "manifest.json");
if (!existsSync(manifestPath)) {
  throw new Error("Verified historical archive manifest is missing.");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest.version !== 1 ||
  manifest.format !== "parquet-zstd" ||
  !manifest.source?.rowCount
) {
  throw new Error("Historical archive manifest is invalid.");
}

/** Resolve an administrative connection without printing its credentials. */
function databaseUrl() {
  const configured =
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL ||
    readLocalPostgresConfiguration()?.adminUrl;
  if (!configured) {
    throw new Error("No PostgreSQL migration connection is configured.");
  }
  return configured;
}

const client = new pg.Client({
  connectionString: databaseUrl(),
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("LOCK TABLE public.eod_candles IN ACCESS EXCLUSIVE MODE");
  const { rows } = await client.query(
    "SELECT COUNT(*)::text AS row_count,COUNT(DISTINCT instrument_id)::text AS instrument_count,MIN(day)::text AS first_day,MAX(day)::text AS last_day FROM public.eod_candles",
  );
  const source = rows[0];
  for (const key of ["rowCount", "instrumentCount", "firstDay", "lastDay"]) {
    const sqlKey = key.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`);
    if (String(manifest.source[key]) !== String(source[sqlKey])) {
      throw new Error(`PostgreSQL ${sqlKey} no longer matches the archive.`);
    }
  }
  await client.query("TRUNCATE TABLE public.eod_candles");
  const result = await client.query(
    "SELECT COUNT(*)::text AS row_count FROM public.eod_candles",
  );
  if (result.rows[0]?.row_count !== "0") {
    throw new Error("PostgreSQL candle retirement did not complete.");
  }
  await client.query("COMMIT");
  process.stdout.write(
    `${JSON.stringify({ status: "retired", table: "public.eod_candles", rows: manifest.source.rowCount, archive: archiveDirectory })}\n`,
  );
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
