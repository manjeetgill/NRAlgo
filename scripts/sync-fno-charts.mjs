/** Download and publish official NSE F&O end-of-day option history as compact Parquet,
 * in one bounded job — the containerized counterpart to sync-nse-charts.mjs for options.
 * Python downloads/normalizes; this process only compacts and atomically publishes.
 * A failed download or publish never replaces the last good publication.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishOptionCharts } from "./sync-option-eod-charts.mjs";

/** Run the existing single-purpose Python downloader without shell interpolation. */
async function python(args) {
  await new Promise((done, reject) => {
    const child = spawn(
      process.env.PYTHON_EXECUTABLE || "python3",
      ["scripts/download_fno_historical.py", ...args],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? done()
        : reject(
            new Error(
              `F&O download failed (${code}); previous option charts are unchanged.`,
            ),
          ),
    );
  });
}

/** Default to the last seven calendar days; the operator overrides for a backfill. */
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
    "nse-options",
  );
  await mkdir(directory, { recursive: true });
  const lock = await open(join(directory, "sync.lock"), "wx");
  let temporary;
  try {
    temporary = await mkdtemp(join(tmpdir(), "nralgo-fno-charts-"));
    const day = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
    });
    const before = (count) =>
      new Date(Date.parse(day) - count * 86400000).toISOString().slice(0, 10);
    await python([
      "--from",
      option("--from") || before(7),
      "--to",
      option("--to") || day,
      "--symbols",
      ...(option("--symbols") || "ALL").split(","),
      "--legacy-provider",
      "native",
      "--skip-unavailable",
      "--continue-invalid",
      "--output",
      temporary,
    ]);
    console.log(
      JSON.stringify(
        await publishOptionCharts([join(temporary, "normalized")], directory),
      ),
    );
  } finally {
    await lock.close();
    await rm(join(directory, "sync.lock"));
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
