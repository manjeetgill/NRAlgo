/** PDF 03/04/06 deterministic acceptance oracles; fixtures never enter application market-data flows. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  runDailyBacktest,
  parseDailyCsv,
  validateDailyBars,
  type DailyBar,
  type BacktestSettings,
} from "../../frontend/src/features/backtest-studio/daily-backtest";
import { createBacktestReport } from "../../frontend/src/features/backtest-studio/backtest-report";
import { readDailyDataset } from "../../frontend/src/features/backtest-studio/use-daily-backtest";
import { summarizePayoff } from "../../frontend/src/features/spread-builder/spread-payoff";

const configuration: BacktestSettings = {
  template: "breakout",
  first: 3,
  second: 2,
  capital: 1020,
  allocation: 100,
  fee: 20,
  slippage: 0,
  stop: 2,
  target: 40,
};
/** Generate isolated ascending OHLC for exact financial oracles, not selectable production data. */
function candles(count = 90): DailyBar[] {
  return Array.from({ length: count }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }));
}
/** One completed breakout signal, followed by a 100 next-open entry. */
function oneEntry() {
  const rows = candles();
  rows[20] = { ...rows[20], high: 103, close: 102 };
  return rows;
}
/** Encode complete input rows using the public upload format. */
function csv(rows: DailyBar[]) {
  return (
    "date,open,high,low,close\n" +
    rows.map((bar) => Object.values(bar).join(",")).join("\n")
  );
}

test("04-T02 accounting oracle: ten at 100, exit 110, two 20 fees yields net 60", () => {
  const rows = oneEntry();
  rows[89] = { ...rows[89], open: 110, high: 111, low: 109, close: 110 };
  const result = runDailyBacktest(rows, configuration);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].quantity, 10);
  assert.equal(result.trades[0].entry, 100);
  assert.equal(result.trades[0].exit, 110);
  assert.equal(result.trades[0].pnl, 60);
  assert.equal(result.totalFees, 40);
  assert.equal(result.endingEquity, 1080);
  assert.equal(result.trades[0].signalDate, rows[20].date);
  assert.equal(result.trades[0].entryFee + result.trades[0].exitFee, 40);
});
test("04-T03 both stop and target touched exits at 98 with an explicit conservative reason", () => {
  const rows = oneEntry();
  rows[21] = { ...rows[21], low: 97, high: 105 };
  const trade = runDailyBacktest(rows, { ...configuration, target: 4 })
    .trades[0];
  assert.equal(trade.exit, 98);
  assert.match(trade.reason, /both stop and target/);
});
test("04-T04 gap-stop precedes a queued rule exit and fills at open 95, not stop 98", () => {
  const rows = oneEntry();
  rows[21] = { ...rows[21], low: 99.5 };
  rows[22] = { ...rows[22], open: 100, low: 98.5, high: 100, close: 98.5 };
  rows[23] = { ...rows[23], open: 95, high: 96, low: 94, close: 95 };
  const trade = runDailyBacktest(rows, configuration).trades[0];
  assert.equal(trade.exitDate, rows[23].date);
  assert.equal(trade.exit, 95);
  assert.equal(trade.reason, "Gap below stop");
});
test("04-T01 future bars cannot alter prefix trades or prior closing equity", () => {
  const original = oneEntry();
  original[21] = { ...original[21], low: 97, high: 105 };
  const changed = structuredClone(original);
  for (let index = 70; index < changed.length; index++) {
    changed[index] = {
      ...changed[index],
      open: 1000,
      high: 1010,
      low: 990,
      close: 1000,
    };
  }
  for (const template of ["ema", "rsi", "breakout"] as const) {
    const settings = {
      ...configuration,
      template,
      first: 3,
      second: template === "rsi" ? 70 : 5,
    };
    const a = runDailyBacktest(original, settings),
      b = runDailyBacktest(changed, settings);
    assert.deepEqual(a.equity.slice(0, 70), b.equity.slice(0, 70));
    assert.deepEqual(
      a.trades.filter((trade) => trade.exitDate < original[70].date),
      b.trades.filter((trade) => trade.exitDate < original[70].date),
    );
  }
});
test("03-T03 breakout excludes current high and uses completed close before next-open entry", () => {
  const rows = candles();
  rows[20] = { ...rows[20], high: 1000, close: 102 };
  const trade = runDailyBacktest(rows, configuration).trades[0];
  assert.equal(trade.entryDate, rows[21].date);
  assert.equal(trade.entry, 100);
});
test("04-T05 CSV boundaries reject 59/10001 rows, accept 60/10000 and reject bad OHLC/dates", () => {
  for (const length of [59, 10001]) {
    assert.throws(() => parseDailyCsv(csv(candles(length))), /60–10,000/);
  }
  for (const length of [60, 10000]) {
    assert.equal(parseDailyCsv(csv(candles(length))).length, length);
  }
  for (const patch of [
    { date: "2025-02-30" },
    { date: "2025-01-02" },
    { high: 90 },
    { close: NaN },
  ]) {
    const rows = candles();
    rows[5] = { ...rows[5], ...patch };
    assert.throws(() => validateDailyBars(rows));
  }
  assert.throws(
    () =>
      parseDailyCsv(
        csv(candles()).replace(
          "date,open,high,low,close",
          "date,open,high,low,close,close",
        ),
      ),
    /unique/,
  );
});
test("04-T06 warmup errors are explicit; flat data has finite equity and no manufactured trades", () => {
  assert.throws(
    () => runDailyBacktest(candles(), { ...configuration, first: 100 }),
    /warm-up/,
  );
  for (const template of ["ema", "rsi", "breakout"] as const) {
    const result = runDailyBacktest(candles(), {
      ...configuration,
      template,
      first: 3,
      second: template === "rsi" ? 70 : 5,
    });
    assert.equal(result.trades.length, 0);
    assert.equal(result.profitFactor, null);
    assert.equal(result.endingEquity, 1020);
    assert.ok(result.equity.every((bar) => Number.isFinite(bar.value)));
  }
});
test("04-T07 report manifest pins input copies and changes fingerprints when parameters/data change", async () => {
  const rows = oneEntry(),
    settings = { ...configuration };
  const pending = createBacktestReport(rows, settings, "oracle.csv");
  settings.fee = 999;
  rows[0].close = 100.5;
  const result = await pending;
  assert.equal(result.settings.fee, 20);
  assert.equal(result.manifest.filename, "oracle.csv");
  const same = await createBacktestReport(
    oneEntry(),
    configuration,
    "renamed.csv",
  );
  assert.equal(result.manifest.datasetHash, same.manifest.datasetHash);
  assert.equal(
    result.manifest.configurationHash,
    same.manifest.configurationHash,
  );
  const changed = await createBacktestReport(rows, settings, "changed.csv");
  assert.notEqual(changed.manifest.datasetHash, result.manifest.datasetHash);
  assert.notEqual(
    changed.manifest.configurationHash,
    result.manifest.configurationHash,
  );
});
test("04-T10 exported report retains every trade beyond the 50-row UI window", async () => {
  const rows = candles(300);
  for (let index = 10; index < rows.length - 1; index += 5) {
    rows[index] = { ...rows[index], high: 103, close: 102 };
    rows[index + 1] = { ...rows[index + 1], high: 105, low: 97 };
  }
  const report = await createBacktestReport(
    rows,
    { ...configuration, capital: 100000, allocation: 1, fee: 0 },
    "full.csv",
  );
  assert.ok(report.trades.length > 50);
  const exported = JSON.parse(JSON.stringify(report));
  assert.deepEqual(exported.trades, report.trades);
  assert.equal(exported.manifest.rowCount, 300);
});
test("04-F02 validation helper rejects replacement before producing a new committed dataset", async () => {
  const previous = await readDailyDataset(
    new File([csv(candles())], "valid.csv"),
  );
  await assert.rejects(
    readDailyDataset(new File(["date,open\nbad,broken"], "invalid.csv")),
  );
  assert.equal(previous.filename, "valid.csv");
  assert.equal(previous.bars.length, 90);
});
test("06-T01 known bull call has loss 2710, profit 7290 and breakeven 25054.2", () => {
  const result = summarizePayoff([
    { right: "call", side: "buy", strike: 25000, premium: 142.3, quantity: 50 },
    { right: "call", side: "sell", strike: 25200, premium: 88.1, quantity: 50 },
  ])!;
  assert.ok(Math.abs(result.maxLoss - 2710) < 1e-8);
  assert.ok(Math.abs(result.maxProfit - 7290) < 1e-8);
  assert.deepEqual(result.breakevens, [25054.2]);
});
test("06-T02 short-call loss and long-call profit are unbounded regardless of chart range", () => {
  const call = {
    right: "call" as const,
    strike: 25000,
    quantity: 75,
    premium: 100,
  };
  assert.equal(
    summarizePayoff([{ ...call, side: "buy" }])!.maxProfit,
    Infinity,
  );
  assert.equal(summarizePayoff([{ ...call, side: "sell" }])!.maxLoss, Infinity);
});
