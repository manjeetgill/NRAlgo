/**
 * Reversible daily-candle archive migration.
 *
 * The command attaches PostgreSQL read-only, writes ZSTD Parquet into a private
 * staging directory, compares every instrument's row count and value hash, then
 * atomically publishes a manifest. It never changes or drops PostgreSQL data.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimeDirectory = resolve(projectRoot, ".runtime");
const archiveDirectory = resolve(
  process.env.HISTORICAL_ARCHIVE_DIRECTORY ||
    resolve(runtimeDirectory, "historical-parquet"),
);
const manifestPath = resolve(archiveDirectory, "manifest.json");
const valueColumns =
  "instrument_id,day,open,high,low,close,volume,source,imported_at";
const rowHash =
  "hash(instrument_id,day,open,high,low,close,volume,source,imported_at)";

/** Escape a trusted filesystem path before embedding it in DuckDB SQL. */
function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Convert DuckDB JSON-safe values to stable strings for manifest comparison. */
function normalizedStats(row) {
  return {
    rowCount: String(row.row_count),
    instrumentCount: String(row.instrument_count),
    firstDay: String(row.first_day),
    lastDay: String(row.last_day),
    valueHash: String(row.value_hash),
  };
}

/** Recursively list regular files in deterministic relative-path order. */
function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

/** Hash one published file without buffering it in application memory. */
async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Read the single row returned by an aggregate query. */
async function one(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  const [row] = await reader.getRowObjectsJson();
  if (!row) {
    throw new Error("Integrity query returned no result.");
  }
  return row;
}

/** Configure libpq variables without putting database credentials in SQL or logs. */
function configurePostgresEnvironment() {
  const explicit =
    process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || null;
  const local = readLocalPostgresConfiguration()?.applicationUrl || null;
  const databaseUrl = explicit || local;
  if (!databaseUrl) {
    throw new Error("No PostgreSQL migration connection is configured.");
  }
  const url = new URL(databaseUrl);
  if (!url.protocol.startsWith("postgres")) {
    throw new Error("The migration connection must be PostgreSQL.");
  }
  process.env.PGHOST = url.hostname;
  process.env.PGPORT = url.port || "5432";
  process.env.PGDATABASE = url.pathname.slice(1);
  process.env.PGUSER = decodeURIComponent(url.username);
  process.env.PGPASSWORD = decodeURIComponent(url.password);
}

/** Open a bounded in-memory DuckDB used for archive reads and verification. */
async function openDuckDbConnection() {
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    max_memory: "768MB",
  });
  return instance.connect();
}

/** Attach the source database with read-only enforcement for migration comparison. */
async function openMigrationConnection() {
  configurePostgresEnvironment();
  const connection = await openDuckDbConnection();
  await connection.run("INSTALL postgres; LOAD postgres");
  await connection.run("ATTACH '' AS source (TYPE postgres, READ_ONLY)");
  return connection;
}

/** Aggregate all persisted values; count plus hash detects omission or mutation. */
async function sourceStats(connection) {
  return normalizedStats(
    await one(
      connection,
      `SELECT COUNT(*)::BIGINT AS row_count, COUNT(DISTINCT instrument_id)::BIGINT AS instrument_count, MIN(day)::VARCHAR AS first_day, MAX(day)::VARCHAR AS last_day, BIT_XOR(${rowHash})::UBIGINT AS value_hash FROM source.public.eod_candles`,
    ),
  );
}

/** Read and validate the published manifest structure before archive verification. */
function readManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error("No published historical Parquet manifest exists.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.format !== "parquet-zstd" ||
    !Array.isArray(manifest.files) ||
    !manifest.source
  ) {
    throw new Error("Historical Parquet manifest is invalid.");
  }
  return manifest;
}

/** Verify file digests plus aggregate and per-instrument equality against PostgreSQL. */
async function verifyArchive(connection, directory, expectedSource) {
  const candleGlob = resolve(directory, "candles", "year=*", "*.parquet");
  const parquetStats = normalizedStats(
    await one(
      connection,
      `SELECT COUNT(*)::BIGINT AS row_count, COUNT(DISTINCT instrument_id)::BIGINT AS instrument_count, MIN(day)::VARCHAR AS first_day, MAX(day)::VARCHAR AS last_day, BIT_XOR(${rowHash})::UBIGINT AS value_hash FROM read_parquet(${sqlLiteral(candleGlob)}, hive_partitioning=true)`,
    ),
  );
  if (JSON.stringify(parquetStats) !== JSON.stringify(expectedSource)) {
    throw new Error("Archive aggregate integrity comparison failed.");
  }
  const mismatch = await one(
    connection,
    `WITH source_group AS (SELECT instrument_id,COUNT(*)::BIGINT AS row_count,BIT_XOR(${rowHash})::UBIGINT AS value_hash FROM source.public.eod_candles GROUP BY instrument_id), archive_group AS (SELECT instrument_id,COUNT(*)::BIGINT AS row_count,BIT_XOR(${rowHash})::UBIGINT AS value_hash FROM read_parquet(${sqlLiteral(candleGlob)}, hive_partitioning=true) GROUP BY instrument_id) SELECT COUNT(*)::BIGINT AS mismatch_count FROM source_group FULL OUTER JOIN archive_group USING(instrument_id) WHERE source_group.row_count IS DISTINCT FROM archive_group.row_count OR source_group.value_hash IS DISTINCT FROM archive_group.value_hash`,
  );
  if (String(mismatch.mismatch_count) !== "0") {
    throw new Error("Archive per-instrument integrity comparison failed.");
  }
  return parquetStats;
}

/** Recheck a published archive, optionally comparing it with the PostgreSQL source. */
async function verifyPublished(connection, compareSource = true) {
  const manifest = readManifest();
  for (const file of manifest.files) {
    const path = resolve(archiveDirectory, file.path);
    if (!path.startsWith(`${archiveDirectory}/`) || !existsSync(path)) {
      throw new Error("A manifest file is missing or outside the archive.");
    }
    const size = statSync(path).size;
    const digest = await sha256File(path);
    if (size !== file.bytes || digest !== file.sha256) {
      throw new Error(`Archive file integrity failed: ${file.path}`);
    }
  }
  if (compareSource) {
    const currentSource = await sourceStats(connection);
    if (JSON.stringify(currentSource) !== JSON.stringify(manifest.source)) {
      throw new Error("PostgreSQL changed after the archive was published.");
    }
    await verifyArchive(connection, archiveDirectory, currentSource);
  } else {
    const candleGlob = resolve(
      archiveDirectory,
      "candles",
      "year=*",
      "*.parquet",
    );
    const archive = normalizedStats(
      await one(
        connection,
        `SELECT COUNT(*)::BIGINT AS row_count, COUNT(DISTINCT instrument_id)::BIGINT AS instrument_count, MIN(day)::VARCHAR AS first_day, MAX(day)::VARCHAR AS last_day, BIT_XOR(${rowHash})::UBIGINT AS value_hash FROM read_parquet(${sqlLiteral(candleGlob)}, hive_partitioning=true)`,
      ),
    );
    if (JSON.stringify(archive) !== JSON.stringify(manifest.source)) {
      throw new Error("Archive contents do not match the published manifest.");
    }
  }
  process.stdout.write(
    `${JSON.stringify({ status: "verified", comparison: compareSource ? "postgresql-and-archive" : "archive-only", source: manifest.source, files: manifest.files.length, bytes: manifest.bytes })}\n`,
  );
}

/** Export into staging, verify, write the manifest last, then atomically publish. */
async function exportArchive(connection) {
  if (existsSync(archiveDirectory)) {
    throw new Error(
      "A historical Parquet archive already exists; run with --verify instead.",
    );
  }
  const staging = resolve(
    runtimeDirectory,
    `.historical-parquet-${randomUUID()}.pending`,
  );
  mkdirSync(resolve(staging, "candles"), { recursive: true, mode: 0o700 });
  try {
    const source = await sourceStats(connection);
    await connection.run(
      `COPY (SELECT ${valueColumns},YEAR(day)::INTEGER AS year FROM source.public.eod_candles ORDER BY year,instrument_id,day) TO ${sqlLiteral(resolve(staging, "candles"))} (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY(year), ROW_GROUP_SIZE 100000)`,
    );
    await connection.run(
      `COPY (SELECT i.id,i.symbol,i.name,i.kind,i.series,i.exchange,MIN(c.day) AS first_day,MAX(c.day) AS last_day,COUNT(*)::BIGINT AS candle_count FROM source.public.eod_instruments i JOIN source.public.eod_candles c ON c.instrument_id=i.id GROUP BY ALL ORDER BY i.symbol,i.id) TO ${sqlLiteral(resolve(staging, "catalog.parquet"))} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    await verifyArchive(connection, staging, source);
    const files = [];
    let bytes = 0;
    for (const path of listFiles(staging)) {
      const size = statSync(path).size;
      bytes += size;
      files.push({
        path: relative(staging, path),
        bytes: size,
        sha256: await sha256File(path),
      });
    }
    const manifest = {
      version: 1,
      format: "parquet-zstd",
      createdAt: new Date().toISOString(),
      source,
      files,
      bytes,
    };
    writeFileSync(
      resolve(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    mkdirSync(dirname(archiveDirectory), { recursive: true, mode: 0o700 });
    renameSync(staging, archiveDirectory);
    process.stdout.write(
      `${JSON.stringify({ status: "published", source, files: files.length, bytes })}\n`,
    );
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

const archiveOnly = process.argv.includes("--archive-only");
const connection = archiveOnly
  ? await openDuckDbConnection()
  : await openMigrationConnection();
try {
  if (process.argv.includes("--verify") || archiveOnly) {
    await verifyPublished(connection, !archiveOnly);
  } else {
    await exportArchive(connection);
  }
} finally {
  connection.closeSync();
}
