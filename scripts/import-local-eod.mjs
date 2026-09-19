/** Operator-only, additive import of the supplied historical CSV directory. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { openDatabaseStore } from "../backend/database.ts";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";
import { importEodData } from "../backend/eod-market-data.ts";

const daySchema = z.iso.date();
export function normalizeRow(row, file, source) {
  const index = path.basename(path.dirname(file)) === "index_data";
  const rawSymbol = index ? path.basename(file, ".csv") : row.Symbol?.trim();
  const aliases = {
    NIFTY_50: "NIFTY",
    NIFTY_BANK: "BANKNIFTY",
    NIFTY_FIN_SERVICE: "FINNIFTY",
  };
  const symbol = (
    index ? aliases[rawSymbol] || rawSymbol : rawSymbol
  )?.toUpperCase();
  const series = index ? "" : row.Series?.trim();
  if (
    !symbol ||
    symbol.length > 60 ||
    (!index && !series) ||
    series.length > 10
  ) {
    throw new Error("invalid_identity");
  }
  const day = row.Date?.trim();
  if (!daySchema.safeParse(day).success) {
    throw new Error("invalid_date");
  }
  const number = (value) => (value?.trim() ? Number(value) : NaN);
  const [open, high, low, close] = [row.Open, row.High, row.Low, row.Close].map(
    number,
  );
  if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error("missing_or_invalid_ohlc");
  }
  if (high < Math.max(open, low, close) || low > Math.min(open, close)) {
    throw new Error("inconsistent_ohlc");
  }
  const volume = row.Volume?.trim() ? number(row.Volume) : null;
  if (volume !== null && (!Number.isFinite(volume) || volume < 0)) {
    throw new Error("invalid_volume");
  }
  return {
    instrument: {
      id: `NSE:${index ? "INDEX" : series}:${rawSymbol.toUpperCase()}`,
      symbol,
      name: index ? rawSymbol.replaceAll("_", " ") : symbol,
      kind: index ? "index" : "equity",
      series,
      exchange: "NSE",
    },
    candle: { day, open, high, low, close, volume, source },
  };
}

function filesBelow(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(folder, entry.name);
      return entry.isDirectory()
        ? filesBelow(file)
        : entry.isFile() && file.endsWith(".csv")
          ? [file]
          : [];
    })
    .sort();
}

export async function run(folder, commit = false) {
  const report = {
    dataset: folder,
    committed: commit,
    files: [],
    validRows: 0,
    rejectedRows: 0,
    skippedValuationFiles: 0,
    first: null,
    last: null,
  };
  const store = commit
    ? openDatabaseStore(
        process.env.IMPORT_DATABASE_URL ||
          readLocalPostgresConfiguration()?.adminUrl,
      )
    : null;
  try {
    for (const file of filesBelow(folder)) {
      if (file.endsWith("_pe_pb.csv")) {
        report.skippedValuationFiles++;
        continue;
      }
      const payload = fs.readFileSync(file);
      const sha256 = createHash("sha256").update(payload).digest("hex");
      const source = `local-dataset:${sha256}`;
      const rows = parse(payload, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      });
      const groups = new Map();
      const result = {
        file: path.relative(folder, file),
        sha256,
        valid: 0,
        rejected: {},
        duplicateDates: 0,
        examples: [],
      };
      for (const [offset, row] of rows.entries()) {
        try {
          const { instrument, candle } = normalizeRow(row, file, source);
          if (!groups.has(instrument.id)) {
            groups.set(instrument.id, { instrument, candles: new Map() });
          }
          const group = groups.get(instrument.id);
          if (group.candles.has(candle.day)) {
            result.duplicateDates++;
            continue;
          }
          group.candles.set(candle.day, candle);
          result.valid++;
          report.validRows++;
          if (!report.first || candle.day < report.first) {
            report.first = candle.day;
          }
          if (!report.last || candle.day > report.last) {
            report.last = candle.day;
          }
        } catch (error) {
          const reason = error.message;
          result.rejected[reason] = (result.rejected[reason] || 0) + 1;
          report.rejectedRows++;
          if (result.examples.length < 3) {
            result.examples.push({ line: offset + 2, reason });
          }
        }
      }
      if (store) {
        for (const { instrument, candles } of groups.values()) {
          const bars = [...candles.values()].sort((a, b) =>
            a.day.localeCompare(b.day),
          );
          for (let offset = 0; offset < bars.length; offset += 1000) {
            await importEodData(
              store,
              instrument,
              bars.slice(offset, offset + 1000),
              { preserveExisting: true },
            );
          }
        }
      }
      report.files.push(result);
      if (report.files.length % 100 === 0) {
        console.log(
          `${commit ? "Imported" : "Validated"} ${report.files.length} files; ${report.validRows} valid rows`,
        );
      }
    }
  } finally {
    await store?.close();
  }
  const output = path.resolve(
    `.runtime/local-eod-${commit ? "import" : "validation"}.json`,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { ...report, files: report.files.length, report: output },
      null,
      2,
    ),
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const folder = process.argv[2];
  if (!folder) {
    throw new Error(
      "Usage: node --import tsx scripts/import-local-eod.mjs DIRECTORY [--commit]",
    );
  }
  await run(path.resolve(folder), process.argv.includes("--commit"));
}
