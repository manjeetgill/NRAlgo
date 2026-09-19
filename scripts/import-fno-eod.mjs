/** Validate or import normalized official NSE F&O option history.
 *
 * Validation is the default. Database writes require the explicit --commit flag,
 * use the administrative local connection, and remain idempotent by contract/day.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { openDatabaseStore } from "../backend/database.ts";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";
import { importOptionEodDailyData } from "../backend/stored-market-data.ts";

const normalizedRowSchema = z
  .object({
    day: z.iso.date(),
    underlying: z.string().regex(/^[A-Z0-9&_.-]{1,40}$/),
    expiry_date: z.iso.date(),
    right: z.enum(["call", "put"]),
    strike_price: z.string().min(1),
    open: z.string(),
    high: z.string(),
    low: z.string(),
    close: z.string(),
    settlement: z.string(),
    volume: z.string(),
    open_interest: z.string(),
    change_open_interest: z.string(),
    lot_size: z.string(),
    underlying_price: z.string(),
    source: z.enum(["nse-fno-legacy", "nse-fno-udiff"]),
  })
  .strict();

/** List only the deterministic daily normalized files produced by the downloader. */
function normalizedFiles(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.csv$/.test(entry.name),
    )
    .map((entry) => path.join(folder, entry.name))
    .sort();
}

/** Parse a required finite nonnegative number, preserving zero where NSE reported it. */
function nonnegative(value, field) {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number < 0) {
    throw new Error(`invalid_${field}`);
  }
  return number;
}

/** Parse an optional safe integer and enforce whether negative values are allowed. */
function optionalInteger(value, field, signed = false) {
  if (!value.trim()) {
    return null;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!signed && number < 0)) {
    throw new Error(`invalid_${field}`);
  }
  return number;
}

/** Convert one normalized CSV row into the database boundary contract. */
export function normalizeOptionRow(raw, sourceIdentity) {
  const row = normalizedRowSchema.parse(raw);
  const strikePrice = nonnegative(row.strike_price, "strike");
  if (strikePrice <= 0 || row.expiry_date < row.day) {
    throw new Error("invalid_contract_identity");
  }
  const instrumentId = `NSE:FO:${row.underlying}:${row.expiry_date}:${row.right}:${row.strike_price}`;
  return {
    instrument: {
      id: instrumentId,
      underlying: row.underlying,
      expiryDate: row.expiry_date,
      right: row.right,
      strikePrice,
      exchange: "NSE",
    },
    candle: {
      day: row.day,
      open: nonnegative(row.open, "open"),
      high: nonnegative(row.high, "high"),
      low: nonnegative(row.low, "low"),
      close: nonnegative(row.close, "close"),
      settlement: row.settlement.trim()
        ? nonnegative(row.settlement, "settlement")
        : null,
      volume: optionalInteger(row.volume, "volume"),
      openInterest: optionalInteger(row.open_interest, "open_interest"),
      changeOpenInterest: optionalInteger(
        row.change_open_interest,
        "change_open_interest",
        true,
      ),
      lotSize: optionalInteger(row.lot_size, "lot_size"),
      underlyingPrice: row.underlying_price.trim()
        ? nonnegative(row.underlying_price, "underlying_price")
        : null,
      source: sourceIdentity,
    },
  };
}

/** Load a downloader manifest when it is adjacent to the normalized directory. */
function readManifest(folder) {
  const file = path.join(path.dirname(folder), "manifest.json");
  if (!fs.existsSync(file)) {
    return { file: null, manifest: null };
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    manifest.version !== 1 ||
    !manifest.days ||
    typeof manifest.days !== "object"
  ) {
    throw new Error("Invalid NSE F&O downloader manifest.");
  }
  return { file, manifest };
}

/** Validate every file, then optionally bulk-upsert each complete exchange day. */
export async function run(folder, commit = false) {
  const { file: manifestFile, manifest } = readManifest(folder);
  const files = normalizedFiles(folder);
  if (!files.length) {
    throw new Error(`No normalized daily CSV files found in ${folder}`);
  }
  const report = {
    dataset: folder,
    committed: commit,
    files: [],
    validRows: 0,
    rejectedRows: 0,
    first: null,
    last: null,
  };
  const store = commit
    ? openDatabaseStore(
        process.env.IMPORT_DATABASE_URL ??
          readLocalPostgresConfiguration()?.adminUrl,
      )
    : null;
  try {
    for (const file of files) {
      const payload = fs.readFileSync(file);
      const normalizedSha256 = createHash("sha256")
        .update(payload)
        .digest("hex");
      const day = path.basename(file, ".csv");
      const manifestEntry = manifest?.days?.[day];
      if (
        manifestEntry &&
        (manifestEntry.status !== "complete" ||
          manifestEntry.normalizedSha256 !== normalizedSha256)
      ) {
        throw new Error(`Manifest checksum/status mismatch for ${day}`);
      }
      const rawSha256 = manifestEntry?.rawSha256 ?? normalizedSha256;
      const sourceIdentity = `nse-fno:${rawSha256}`;
      const rows = parse(payload, {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      });
      const entries = [];
      const result = {
        file: path.basename(file),
        sha256: normalizedSha256,
        valid: 0,
        rejected: {},
        examples: [],
      };
      for (const [offset, row] of rows.entries()) {
        try {
          const entry = normalizeOptionRow(row, sourceIdentity);
          if (entry.candle.day !== day) {
            throw new Error("filename_date_mismatch");
          }
          entries.push(entry);
          result.valid++;
          report.validRows++;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "invalid_row";
          result.rejected[reason] = (result.rejected[reason] ?? 0) + 1;
          report.rejectedRows++;
          if (result.examples.length < 3) {
            result.examples.push({ line: offset + 2, reason });
          }
        }
      }
      if (result.rejected && Object.keys(result.rejected).length) {
        throw new Error(
          `Rejected rows in ${day}: ${JSON.stringify(result.rejected)}`,
        );
      }
      if (store && entries.length) {
        for (let offset = 0; offset < entries.length; offset += 20_000) {
          await importOptionEodDailyData(
            store,
            entries.slice(offset, offset + 20_000),
          );
        }
        if (manifestEntry) {
          manifestEntry.imported = true;
          manifestEntry.importedAt = new Date().toISOString();
        }
      }
      report.first ??= day;
      report.last = day;
      report.files.push(result);
      console.log(
        `${commit ? "imported" : "validated"} ${day}: ${entries.length} rows`,
      );
    }
  } finally {
    await store?.close();
  }
  if (commit && manifestFile && manifest) {
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const output = path.resolve(
    `.runtime/nse-fno-${commit ? "import" : "validation"}.json`,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { ...report, files: report.files.length, report: output },
      null,
      2,
    ),
  );
  return report;
}

/** Run only when invoked as the operator CLI, never when imported by tests. */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const folder = path.resolve(
    process.argv.slice(2).find((argument) => !argument.startsWith("-")) ??
      ".runtime/nse-fno/normalized",
  );
  await run(folder, process.argv.includes("--commit"));
}
