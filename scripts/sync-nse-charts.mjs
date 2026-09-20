/** Publish official NSE daily charts and the full cash/F&O-underlying catalogue.
 * Python validates/processes reports; the existing embedded DuckDB only compacts
 * them. One writer, bounded memory, no broker/session access, no raw files kept
 * in the repo. A failed download never replaces the last good publication.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const literal = (text) => `'${text.replaceAll("'", "''")}'`;
// Keep the legacy archive's stable financial-services ID across official name spellings.
const canonicalId = (column) =>
  `CASE WHEN ${column}='NSE:INDEX:NIFTY_FINANCIAL_SERVICES' THEN 'NSE:INDEX:NIFTY_FIN_SERVICE' ELSE ${column} END`;
/** Run the existing single-purpose Python processor without shell interpolation. */
async function python(args) {
  await new Promise((done, reject) => {
    const child = spawn(
      process.env.PYTHON_EXECUTABLE || "python3",
      ["scripts/download-nse.py", ...args],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(
            new Error(
              `NSE processing failed (${code}); previous charts are unchanged.`,
            ),
          ),
    );
  });
}

/** Merge exact IDs/days, preferring freshly verified NSE rows; publish the pointer last. */
export async function publishNseCharts(input, directory) {
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
    throw new Error("Invalid previous NSE publication");
  }
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    max_memory: "256MB",
  });
  const connection = await instance.connect();
  try {
    const fresh = `SELECT instrument_id,CAST(day AS DATE) AS day,CAST(open AS DOUBLE) AS open,CAST(high AS DOUBLE) AS high,CAST(low AS DOUBLE) AS low,CAST(close AS DOUBLE) AS close,CAST(volume AS DOUBLE) AS volume,source,CAST(imported_at AS VARCHAR) AS imported_at FROM read_json_auto(${literal(join(input, "candles.ndjson"))},format='newline_delimited')`;
    const previousCandles = previous
      ? ` UNION ALL SELECT ${canonicalId("instrument_id")} AS instrument_id,day,open,high,low,close,volume,source,imported_at FROM read_parquet(${literal(join(directory, previous.generation, "candles.parquet"))})`
      : "";
    await connection.run(
      `CREATE TABLE candles AS SELECT * FROM (${fresh}${previousCandles}) QUALIFY row_number() OVER (PARTITION BY instrument_id,day ORDER BY imported_at DESC)=1`,
    );
    await connection.run(
      `COPY (SELECT * FROM candles ORDER BY instrument_id,day) TO ${literal(join(destination, "candles.parquet"))} (FORMAT PARQUET,COMPRESSION ZSTD)`,
    );
    // Current exchange membership comes only from the latest catalogue, never from an old candle.
    const oldCatalog = previous
      ? ` UNION ALL SELECT ${canonicalId("id")} AS id,symbol,name,kind,series,exchange,false AS active,false AS fno,1 AS priority FROM read_parquet(${literal(join(directory, previous.generation, "catalog.parquet"))})`
      : "";
    await connection.run(
      `COPY (WITH identities AS (SELECT id,symbol,name,kind,series,exchange,active,fno FROM (SELECT *,0 AS priority FROM read_json_auto(${literal(join(input, "catalog.ndjson"))},format='newline_delimited')${oldCatalog}) QUALIFY row_number() OVER (PARTITION BY id ORDER BY priority)=1), coverage AS (SELECT instrument_id,MIN(day) first_day,MAX(day) last_day,COUNT(*)::INTEGER candle_count FROM candles GROUP BY instrument_id) SELECT i.*,CAST(c.first_day AS VARCHAR) first_day,CAST(c.last_day AS VARCHAR) last_day,COALESCE(c.candle_count,0)::INTEGER candle_count FROM identities i LEFT JOIN coverage c ON i.id=c.instrument_id ORDER BY i.id) TO ${literal(join(destination, "catalog.parquet"))} (FORMAT PARQUET,COMPRESSION ZSTD)`,
    );
    const result = await connection.runAndReadAll(
      "SELECT COUNT(*)::INTEGER candles,COUNT(DISTINCT instrument_id)::INTEGER instruments,MIN(day)::VARCHAR first_day,MAX(day)::VARCHAR last_day FROM candles",
    );
    const [coverage] = result.getRowObjectsJson();
    const files = {};
    for (const name of ["catalog.parquet", "candles.parquet"]) {
      // Archive size grows over time; checksum in bounded chunks, never one heap-sized Buffer.
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(join(destination, name))) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      files[name] = {
        bytes,
        sha256: hash.digest("hex"),
      };
    }
    const publication = {
      version: 1,
      generation,
      fetchedAt: new Date().toISOString(),
      coverage,
      files,
    };
    const temporary = join(directory, `${generation}.json.pending`);
    await writeFile(temporary, JSON.stringify(publication));
    await rename(temporary, join(directory, "current.json"));
    return publication;
  } catch (error) {
    // Remove only this unpublished generation, never the last successful archive.
    await rm(destination, { recursive: true, force: true });
    await rm(join(directory, `${generation}.json.pending`), { force: true });
    throw error;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Default bootstrap is 90 calendar days; subsequent runs request the last seven days plus any missed interval. */
async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const directory = join(
    resolve(
      process.env.HISTORICAL_ARCHIVE_DIRECTORY || ".runtime/historical-parquet",
    ),
    "nse",
  );
  await mkdir(directory, { recursive: true });
  const lock = await open(join(directory, "sync.lock"), "wx");
  let temporary;
  try {
    temporary = await mkdtemp(join(tmpdir(), "nralgo-nse-charts-"));
    const input = option("--input");
    let prior;
    try {
      prior = JSON.parse(
        await readFile(join(directory, "current.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const day = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    const before = (stamp, count) =>
      new Date(Date.parse(stamp) - count * 86400000).toISOString().slice(0, 10);
    if (!input) {
      await python([
        "--from",
        option("--from") ||
          before(prior?.coverage.last_day || day, prior ? 7 : 90),
        "--to",
        option("--to") || day,
        "--output",
        temporary,
        "--workers",
        "2",
      ]);
    }
    await python([
      "--export-charts",
      "--output",
      input ? resolve(input) : temporary,
    ]);
    console.log(
      JSON.stringify(
        await publishNseCharts(input ? resolve(input) : temporary, directory),
      ),
    );
  } finally {
    await lock.close();
    await rm(join(directory, "sync.lock"));
    // Only the exact scratch directory allocated by this invocation is removed.
    if (temporary) {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
