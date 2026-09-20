/** Publish official NSE F&O end-of-day option history as compact Parquet.
 * Reads already-normalized daily CSVs produced by download_fno_historical.py
 * directly — no PostgreSQL round-trip. One writer, bounded memory, atomic
 * generation swap: a failed run never replaces the last good publication.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const literal = (text) => `'${text.replaceAll("'", "''")}'`;

/** List normalized daily CSVs (YYYY-MM-DD.csv) under one or more source folders. */
async function normalizedCsvGlobs(sourceDirs) {
  const globs = [];
  for (const directory of sourceDirs) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(entry.name))) {
      globs.push(join(directory, "*.csv"));
    }
  }
  if (!globs.length) {
    throw new Error(
      "No normalized daily CSV files found in the given source(s).",
    );
  }
  return globs;
}

/** Merge fresh normalized rows with the previous generation, preferring fresh values
 * for any (underlying, expiry, right, strike, day) already published. Publish last. */
export async function publishOptionCharts(sourceDirs, directory) {
  await mkdir(directory, { recursive: true });
  const generation = randomUUID();
  const destination = join(directory, generation);
  await mkdir(destination);
  let previous;
  try {
    previous = JSON.parse(
      await readFile(join(directory, "current.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (previous && !/^[a-f0-9-]{36}$/.test(previous.generation)) {
    throw new Error("Invalid previous option-chart publication");
  }
  const globs = await normalizedCsvGlobs(sourceDirs);
  // Merging fresh rows against a multi-year previous generation via QUALIFY needs
  // headroom well beyond a single day's fresh CSVs; spill to disk rather than fail
  // outright as the archive keeps growing across incremental runs.
  const spillDirectory = join(directory, `.duckdb-spill-${randomUUID()}`);
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "2",
    max_memory: "4GB",
    temp_directory: spillDirectory,
  });
  const connection = await instance.connect();
  try {
    const freshList = globs.map(literal).join(",");
    const fresh = `SELECT underlying,CAST(expiry_date AS DATE) AS expiry_date,"right",CAST(strike_price AS DOUBLE) AS strike_price,CAST(day AS DATE) AS day,CAST(open AS DOUBLE) AS open,CAST(high AS DOUBLE) AS high,CAST(low AS DOUBLE) AS low,CAST(close AS DOUBLE) AS close,TRY_CAST(NULLIF(settlement,'') AS DOUBLE) AS settlement,TRY_CAST(NULLIF(volume,'') AS BIGINT) AS volume,TRY_CAST(NULLIF(open_interest,'') AS BIGINT) AS open_interest,TRY_CAST(NULLIF(change_open_interest,'') AS BIGINT) AS change_open_interest,TRY_CAST(NULLIF(lot_size,'') AS INTEGER) AS lot_size,TRY_CAST(NULLIF(underlying_price,'') AS DOUBLE) AS underlying_price,source FROM read_csv([${freshList}],header=true,columns={'day':'VARCHAR','underlying':'VARCHAR','expiry_date':'VARCHAR','right':'VARCHAR','strike_price':'VARCHAR','open':'VARCHAR','high':'VARCHAR','low':'VARCHAR','close':'VARCHAR','settlement':'VARCHAR','volume':'VARCHAR','open_interest':'VARCHAR','change_open_interest':'VARCHAR','lot_size':'VARCHAR','underlying_price':'VARCHAR','source':'VARCHAR'})`;
    // Replace whole days rather than deduplicating every row with a window function:
    // a fresh run always re-normalizes complete exchange sessions, so "day in the
    // fresh set" is the correct and far cheaper replacement predicate — a global
    // QUALIFY over the whole multi-year archive needs the entire result in memory
    // and stops scaling once the archive is more than a year or two.
    const previousCandles = previous
      ? ` UNION ALL SELECT underlying,expiry_date,"right",strike_price,day,open,high,low,close,settlement,volume,open_interest,change_open_interest,lot_size,underlying_price,source FROM read_parquet(${literal(join(directory, previous.generation, "candles", "year=*", "*.parquet"))},hive_partitioning=true) WHERE day NOT IN (SELECT DISTINCT day FROM (${fresh}))`
      : "";
    await connection.run(`CREATE TABLE candles AS ${fresh}${previousCandles}`);
    await connection.run(
      `COPY (SELECT *,YEAR(day)::INTEGER AS year FROM candles ORDER BY year,underlying,expiry_date,"right",strike_price,day) TO ${literal(join(destination, "candles"))} (FORMAT PARQUET,COMPRESSION ZSTD,PARTITION_BY(year),ROW_GROUP_SIZE 200000)`,
    );
    await connection.run(
      `COPY (SELECT underlying,expiry_date,"right",strike_price,concat('NSE:FO:',underlying,':',CAST(expiry_date AS VARCHAR),':',"right",':',CAST(strike_price AS VARCHAR)) AS id,MIN(day) first_day,MAX(day) last_day,COUNT(*)::INTEGER candle_count FROM candles GROUP BY underlying,expiry_date,"right",strike_price ORDER BY underlying,expiry_date,strike_price,"right") TO ${literal(join(destination, "catalog.parquet"))} (FORMAT PARQUET,COMPRESSION ZSTD)`,
    );
    const result = await connection.runAndReadAll(
      "SELECT COUNT(*)::BIGINT candles,COUNT(DISTINCT underlying)::INTEGER underlyings,MIN(day)::VARCHAR first_day,MAX(day)::VARCHAR last_day FROM candles",
    );
    const [coverage] = result.getRowObjectsJson();
    const files = {};
    for (const name of ["catalog.parquet"]) {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(join(destination, name))) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      files[name] = { bytes, sha256: hash.digest("hex") };
    }
    // candles.parquet is hive-partitioned (candles/year=*/*.parquet); hash each part file.
    const candlesRoot = join(destination, "candles");
    const parts = [];
    for (const yearDir of await readdir(candlesRoot, { withFileTypes: true })) {
      if (!yearDir.isDirectory()) {
        continue;
      }
      for (const file of await readdir(join(candlesRoot, yearDir.name))) {
        const path = join(candlesRoot, yearDir.name, file);
        const relativePath = join("candles", yearDir.name, file);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(path)) {
          bytes += chunk.length;
          hash.update(chunk);
        }
        parts.push({ path: relativePath, bytes, sha256: hash.digest("hex") });
      }
    }
    const publication = {
      version: 1,
      generation,
      fetchedAt: new Date().toISOString(),
      coverage,
      files: { ...files, candleParts: parts },
    };
    const temporary = join(directory, `${generation}.json.pending`);
    await writeFile(temporary, JSON.stringify(publication));
    await rename(temporary, join(directory, "current.json"));
    return publication;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    await rm(join(directory, `${generation}.json.pending`), { force: true });
    throw error;
  } finally {
    connection.closeSync();
    instance.closeSync();
    await rm(spillDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sources = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--source") {
      sources.push(resolve(args[index + 1]));
      index++;
    }
  }
  if (!sources.length) {
    throw new Error("Pass at least one --source <normalized-folder>.");
  }
  const directory = join(
    resolve(
      process.env.HISTORICAL_ARCHIVE_DIRECTORY || ".runtime/historical-parquet",
    ),
    "nse-options",
  );
  await mkdir(directory, { recursive: true });
  const lock = await open(join(directory, "sync.lock"), "wx");
  try {
    console.log(JSON.stringify(await publishOptionCharts(sources, directory)));
  } finally {
    await lock.close();
    await rm(join(directory, "sync.lock"));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
