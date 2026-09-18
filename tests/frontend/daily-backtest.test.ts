/** Isolated test fixtures are never shipped as selectable application market data. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDailyCsv,
  runDailyBacktest,
  validateDailyBars,
  type DailyBar,
  type BacktestSettings,
} from "../../frontend/src/features/backtest-studio/daily-backtest";
const settings: BacktestSettings = {
  template: "breakout",
  first: 3,
  second: 2,
  capital: 10000,
  allocation: 50,
  stop: 2,
  target: 4,
  fee: 10,
  slippage: 5,
};
/** Flat, valid daily OHLC fixture; tests explicitly alter only the bars relevant to each assertion. */
function bars(): DailyBar[] {
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
  }));
}
test("CSV rejects missing headers, invalid dates, inconsistent OHLC and duplicate dates", () => {
  assert.throws(() => parseDailyCsv("symbol,price\nA,1"), /Required CSV/);
  for (const mutation of [
    (rows: DailyBar[]) => {
      rows[2].date = rows[1].date;
    },
    (rows: DailyBar[]) => {
      rows[2].date = "2025-02-30";
    },
    (rows: DailyBar[]) => {
      rows[2].high = 90;
    },
  ]) {
    const rows = bars();
    mutation(rows);
    assert.throws(() => validateDailyBars(rows));
  }
  const rows = bars();
  assert.deepEqual(
    parseDailyCsv(
      "date,open,high,low,close\n" +
        rows.map((row) => Object.values(row).join(",")).join("\n"),
    ),
    rows,
  );
});
test("flat prices produce no fabricated trades or gains for all three rules", () => {
  for (const template of ["ema", "rsi", "breakout"] as const) {
    const result = runDailyBacktest(bars(), {
      ...settings,
      template,
      first: 3,
      second: template === "rsi" ? 70 : 5,
    });
    assert.equal(result.trades.length, 0);
    assert.equal(result.endingEquity, settings.capital);
    assert.equal(result.winRate, null);
  }
});
test("completed breakout enters at next open and ambiguous bar exits stop first with both fees", () => {
  const rows = bars();
  rows[20] = { ...rows[20], high: 106, close: 105 };
  rows[21] = { ...rows[21], open: 106, high: 120, low: 90, close: 100 };
  const result = runDailyBacktest(rows, settings),
    trade = result.trades[0];
  assert.equal(trade.entryDate, rows[21].date);
  assert.equal(trade.exitDate, rows[21].date);
  assert.match(trade.reason, /Stop/);
  assert.equal(trade.entry, 106 * 1.0005);
  assert.ok(trade.exit < trade.entry * 0.98);
  assert.ok(
    Math.abs(
      result.endingEquity -
        settings.capital -
        result.trades.reduce((sum, item) => sum + item.pnl, 0),
    ) < 1e-8,
  );
  assert.equal(result.totalFees, result.trades.length * 20);
});
test("invalid periods and allocation fail before calculation", () => {
  assert.throws(
    () =>
      runDailyBacktest(bars(), {
        ...settings,
        template: "ema",
        first: 30,
        second: 21,
      }),
    /Fast EMA/,
  );
  assert.throws(
    () => runDailyBacktest(bars(), { ...settings, allocation: 101 }),
    /outside/,
  );
  assert.throws(
    () => runDailyBacktest(bars(), { ...settings, first: 300 }),
    /warm-up/,
  );
});
