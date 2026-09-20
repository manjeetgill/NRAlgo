/** Real compact-publication checks: current catalogue membership is separate from candle availability. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { publishNseCharts } from "../scripts/sync-nse-charts.mjs";
import { HistoricalCandleStore } from "../backend/historical-candle-store.ts";

const instrument = (symbol, extra = {}) => ({
  id: `NSE:EQ:${symbol}`,
  symbol,
  name: `${symbol} Limited`,
  kind: "equity",
  series: "EQ",
  exchange: "NSE",
  active: true,
  fno: false,
  ...extra,
});
const candle = (id, day, close = 100) => ({
  instrument_id: id,
  day,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: null,
  source: "nse-bhavcopy",
  imported_at: "2026-09-20T10:00:00Z",
});
const writeRows = (path, rows) =>
  writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));

test("NSE publication exposes names/new listings, separates Cash/F&O/Indices, overlays exact daily prices", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nralgo-nse-test-"));
  const input = join(folder, "input");
  await mkdir(input);
  try {
    const alpha = instrument("ALPHA", { fno: true });
    const index = instrument("NIFTY", {
      id: "NSE:INDEX:NIFTY_50",
      name: "Nifty 50",
      kind: "index",
      series: "",
      fno: true,
    });
    await writeRows(join(input, "catalog.ndjson"), [
      alpha,
      instrument("NEWIPO"),
      index,
      instrument("DELISTED", { active: false }),
    ]);
    await writeRows(join(input, "candles.ndjson"), [
      candle(alpha.id, "2026-09-18", 110),
      candle(index.id, "2026-09-18", 200),
    ]);
    const publication = await publishNseCharts(input, join(folder, "nse"));
    assert.equal(publication.coverage.last_day, "2026-09-18");
    const store = {
      transaction: async (callback) =>
        callback(async (sql, params) =>
          sql.includes("FROM eod_candles") && params[0] === alpha.id
            ? [
                { ...candle(alpha.id, "2021-01-13", 80) },
                { ...candle(alpha.id, "2026-09-18", 99) },
              ]
            : [],
        ),
    };
    const history = new HistoricalCandleStore(store, folder);
    assert.deepEqual(
      (await history.searchWatchlistInstruments("", 0, "cash")).items.map(
        (row) => row.symbol,
      ),
      ["ALPHA", "NEWIPO"],
    );
    assert.deepEqual(
      (await history.searchWatchlistInstruments("", 0, "fno")).items.map(
        (row) => row.symbol,
      ),
      ["ALPHA", "NIFTY"],
    );
    assert.deepEqual(
      (await history.searchWatchlistInstruments("", 0, "index")).items.map(
        (row) => row.symbol,
      ),
      ["NIFTY"],
    );
    assert.equal(
      (await history.searchWatchlistInstruments("Limited", 0, "cash")).items
        .length,
      2,
    );
    const ipo = (await history.searchWatchlistInstruments("NEWIPO", 0, "cash"))
      .items[0];
    assert.equal(ipo.candle_count, 0);
    assert.equal(ipo.last_day, null);
    assert.equal((await history.readInstrument(ipo.id)).id, ipo.id);
    assert.deepEqual(await history.readCandles(ipo.id), []);
    const bars = await history.readCandles(alpha.id);
    assert.deepEqual(
      bars.map((bar) => [bar.day, bar.close]),
      [
        ["2021-01-13", 80],
        ["2026-09-18", 110],
      ],
    );
    // Full history from listing is shown regardless of the (now-inert) preferNse
    // flag: the legacy archive is merged, not discarded, and a multi-year gap is
    // disclosed via the API's gaps field rather than hidden by truncating the range.
    assert.deepEqual(
      (await history.readCandles(alpha.id, undefined, undefined, true)).map(
        (bar) => [bar.day, bar.close],
      ),
      bars.map((bar) => [bar.day, bar.close]),
      "Charts show the full merged history, including across a legacy gap",
    );
    assert.equal(
      (await history.searchInstruments("NEWIPO", 0)).length,
      0,
      "Research requires candles",
    );
    // A second publication updates an existing reader without restarting the app.
    await writeRows(join(input, "candles.ndjson"), [
      candle(alpha.id, "2026-09-19", 112),
    ]);
    await publishNseCharts(input, join(folder, "nse"));
    assert.equal((await history.readCandles(alpha.id)).at(-1).close, 112);
    assert.equal((await history.readInstrument(alpha.id)).candle_count, 2);
    const pointer = await readFile(join(folder, "nse/current.json"), "utf8");
    const generations = (await readdir(join(folder, "nse"))).sort();
    await writeFile(join(input, "candles.ndjson"), "invalid json");
    await assert.rejects(publishNseCharts(input, join(folder, "nse")));
    assert.equal(
      await readFile(join(folder, "nse/current.json"), "utf8"),
      pointer,
    );
    assert.deepEqual((await readdir(join(folder, "nse"))).sort(), generations);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("catalogue search pages through every current stock and ranks exact symbols first", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nralgo-nse-page-"));
  try {
    const rows = Array.from({ length: 103 }, (_, index) =>
      instrument(`S${String(index).padStart(3, "0")}`),
    );
    await writeRows(join(folder, "catalog.ndjson"), rows);
    await writeRows(join(folder, "candles.ndjson"), [
      candle(rows[0].id, "2026-09-18"),
    ]);
    await publishNseCharts(folder, join(folder, "nse"));
    const history = new HistoricalCandleStore(
      { transaction: async (fn) => fn(async () => []) },
      folder,
    );
    const seen = [];
    let offset = 0;
    do {
      const page = await history.searchWatchlistInstruments("", offset, "cash");
      seen.push(...page.items.map((row) => row.id));
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(new Set(seen).size, 103);
    assert.equal(
      (await history.searchWatchlistInstruments("S100", 0, "cash")).items[0]
        .symbol,
      "S100",
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("Python NSE normalization preserves canonical index IDs and rejects corrupt OHLC", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util
from datetime import date
spec = importlib.util.spec_from_file_location('nse', 'scripts/download-nse.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
row = {'Index Name':'Nifty 50','Open Index Value':'100','High Index Value':'102','Low Index Value':'99','Closing Index Value':'101','Volume':'-'}
i,c = m.chart_row(row,'indices',date(2026,9,18))
assert i['id'] == 'NSE:INDEX:NIFTY_50' and i['symbol'] == 'NIFTY'
assert c['volume'] is None and c['source'] == 'nse-indices'
row['High Index Value']='98'
try: m.chart_row(row,'indices',date(2026,9,18)); raise AssertionError('Accepted invalid OHLC')
except ValueError: pass
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("NIFTYNXT50 resolves the existing index identity in both index and F&O searches", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nralgo-nse-alias-"));
  try {
    const index = instrument("NIFTY_NEXT_50", {
      id: "NSE:INDEX:NIFTY_NEXT_50",
      name: "Nifty Next 50",
      kind: "index",
      fno: true,
    });
    await writeRows(join(folder, "catalog.ndjson"), [index]);
    await writeRows(join(folder, "candles.ndjson"), [
      candle(index.id, "2026-09-18"),
    ]);
    await publishNseCharts(folder, join(folder, "nse"));
    const history = new HistoricalCandleStore(
      { transaction: async (fn) => fn(async () => []) },
      folder,
    );
    for (const segment of ["index", "fno"]) {
      const result = await history.searchWatchlistInstruments(
        " niftynxt50 ",
        0,
        segment,
      );
      assert.equal(result.items[0]?.id, index.id);
    }
    assert.equal(
      (await history.searchWatchlistInstruments("NIFTYNXT50", 0, "cash")).items
        .length,
      0,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
