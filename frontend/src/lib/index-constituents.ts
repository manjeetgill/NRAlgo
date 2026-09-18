import { parse } from "csv-parse/sync";

// Fixed official sources: never accept a caller-supplied download URL.
export const INDEX_FILES = {
  NIFTY: "ind_nifty50list.csv",
  NIFTYNXT50: "ind_niftynext50list.csv",
  FINNIFTY: "ind_niftyfinancelist.csv",
  BANKNIFTY: "ind_niftybanklist.csv",
  MIDCPNIFTY: "ind_niftymidcapselect_list.csv",
  NIFTYFPI: "ind_niftyIndiaFPI150_list.csv",
} as const;

/** Parse the bounded official CSV; reject malformed symbols before deduplication. */
export function parseConstituents(csv: string): string[] {
  const rows = parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  if (
    !rows.length ||
    rows.length > 1000 ||
    rows.some((row) => !/^[A-Z0-9&-]+$/.test(row.Symbol ?? ""))
  ) {
    throw new Error("Invalid index constituent data");
  }
  return [...new Set(rows.map((row) => row.Symbol))].sort();
}
