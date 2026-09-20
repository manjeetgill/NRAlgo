import test from "node:test";
import assert from "node:assert/strict";
import {
  readStoredOptionChart,
  registerStoredOptionCharts,
} from "../backend/stored-option-chart.ts";

const id = "NSE:FO:NIFTY:2026-09-29:call:25000";
const valid = {
  day: "2026-09-18",
  open: 100,
  high: 110,
  low: 95,
  close: 105,
  volume: 500,
};
function store(rows, exists = true) {
  const calls = [];
  return {
    calls,
    transaction: (action) =>
      action(async (sql, args) => {
        calls.push({ sql, args });
        assert.deepEqual(args, [id]);
        assert.match(sql, /WHERE (?:instrument_)?id=\$1/);
        return sql.includes("FROM option_eod_instruments")
          ? exists
            ? [{ id, symbol: "NIFTY 2026-09-29 25000 CE" }]
            : []
          : rows;
      }),
  };
}
test("stored option chart reads only the exact contract and valid traded OHLC", async () => {
  const db = store([
    valid,
    { ...valid, day: "2026-09-19", open: 0, settlement: 100 },
    { ...valid, day: "2026-09-20", high: 99 },
    { ...valid, day: "2026-09-21", close: NaN },
  ]);
  const result = await readStoredOptionChart(db, id);
  assert.deepEqual(result.candles, [valid]);
  assert.equal(result.excludedSessions, 3);
  assert.equal(result.instrument.id, id);
  assert.equal(result.interval, "day");
  assert.equal(db.calls.length, 2);
});
test("missing option does not query cash or substitute another strike", async () => {
  const db = store([], false);
  const result = await readStoredOptionChart(db, id);
  assert.equal(result.instrument, null);
  assert.deepEqual(result.candles, []);
  assert.equal(db.calls.length, 1);
});
test("stored option charts enforce the session limit", async () => {
  await assert.rejects(
    readStoredOptionChart(store(Array(10001).fill(valid)), id),
    { status: 422 },
  );
});
test("option chart endpoint rejects cash IDs before accessing storage", async () => {
  let handler;
  registerStoredOptionCharts(
    {
      get: (path, fn) => {
        assert.equal(path, "/api/eod/option-candles");
        handler = fn;
      },
    },
    { transaction: () => assert.fail("must not query") },
  );
  await assert.rejects(handler({ query: { id: "NSE:EQ:NIFTY" } }, {}));
});
