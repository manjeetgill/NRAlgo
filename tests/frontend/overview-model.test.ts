/** Network-free valuation regressions: a single tick batch must value table and headline equally. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPriceTicks,
  calculatePositionPnl,
  formatAccountMoney,
  formatActivityTime,
} from "../../frontend/src/features/overview/overview-model";
import type {
  AccountSnapshot,
  PriceTick,
} from "../../frontend/src/features/overview/overview-types";

/** Create an isolated known book; callers override only the scenario under test. */
function createSnapshot(
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return {
    mode: "live",
    capturedAt: 1000,
    availableFunds: 500,
    pnl: 100,
    warnings: [],
    positions: [
      {
        id: "nse_fo|101",
        instrument: "101",
        exchange: "nse_fo",
        symbol: "OPTION",
        quantity: 10,
        averagePrice: 90,
        markPrice: 100,
        pnl: 100,
        pnlBase: -900,
        pnlPerMark: 10,
        markedAt: null,
      },
    ],
    ...overrides,
  };
}

/** Create a fresh normalized quote without using wall-clock time. */
function createTick(overrides: Partial<PriceTick> = {}): PriceTick {
  return {
    instrument: "101",
    exchange: "nse_fo",
    price: 105,
    receivedAt: 2000,
    fresh: true,
    ...overrides,
  };
}

test("unknown balances and incomplete books never appear as zero", /** Verify null, empty and partial books remain distinct. */ () => {
  assert.equal(formatAccountMoney(null), "—");
  assert.equal(formatAccountMoney(NaN), "—");
  assert.match(formatAccountMoney(0), /0/);
  assert.equal(calculatePositionPnl(createSnapshot({ positions: null })), null);
  assert.equal(calculatePositionPnl(createSnapshot({ positions: [] })), 0);
  const book = createSnapshot();
  book.positions![0].pnl = null;
  assert.equal(calculatePositionPnl(book), null);
});

test("a tick atomically updates the row and headline without mutating the snapshot", /** Verify coefficient-based valuation and immutable account state. */ () => {
  const original = createSnapshot();
  const result = applyPriceTicks(original, [createTick()], 2000);
  assert.equal(result.pnl, 150);
  assert.equal(result.positions![0].pnl, result.pnl);
  assert.equal(result.positions![0].markPrice, 105);
  assert.equal(result.positions![0].markedAt, 2000);
  assert.equal(result.capturedAt, original.capturedAt);
  assert.equal(original.positions![0].markPrice, 100);
  assert.equal(original.pnl, 100);
  assert.equal(result.availableFunds, 500);
});

test("paper account prices cannot be changed by live ticks", /** Prevent accidental paper/live state contamination. */ () => {
  const paper = createSnapshot({ mode: "paper" });
  assert.equal(applyPriceTicks(paper, [createTick()], 2000), paper);
});

test("matching requires both exchange and token", /** Reject collisions across market segments and unrelated contracts. */ () => {
  const result = applyPriceTicks(
    createSnapshot(),
    [createTick({ exchange: "nse_cm" }), createTick({ instrument: "102" })],
    2000,
  );
  assert.equal(result.pnl, 100);
});

test("stale, future, invalid and non-fresh ticks cannot revalue a position", /** Validate the complete freshness boundary against a fixed clock. */ () => {
  const result = applyPriceTicks(
    createSnapshot(),
    [
      createTick({ receivedAt: 1 }),
      createTick({ receivedAt: 20001 }),
      createTick({ price: NaN, receivedAt: 20000 }),
      createTick({ price: -1, receivedAt: 20000 }),
      createTick({ fresh: false, receivedAt: 20000 }),
      createTick({ receivedAt: NaN }),
    ],
    20000,
  );
  assert.equal(result.pnl, 100);
});

test("newest tick wins and out-of-order updates never rewind a mark", /** Confirm ordering within and across cache batches. */ () => {
  const first = applyPriceTicks(
    createSnapshot(),
    [createTick({ receivedAt: 3000, price: 110 }), createTick()],
    3000,
  );
  assert.equal(first.pnl, 200);
  assert.equal(applyPriceTicks(first, [createTick()], 3000).pnl, 200);
  assert.equal(
    applyPriceTicks(first, [createTick({ receivedAt: 3000, price: 110 })], 3000)
      .pnl,
    200,
  );
});

test("delta fallback does not compound repeated prices", /** Use previous mark deltas only when an absolute valuation base is absent. */ () => {
  const book = createSnapshot();
  book.positions![0].pnlBase = null;
  const first = applyPriceTicks(book, [createTick()], 2000);
  const repeated = applyPriceTicks(first, [createTick()], 2000);
  assert.equal(repeated.pnl, 150);
  assert.equal(
    applyPriceTicks(
      repeated,
      [createTick({ price: 106, receivedAt: 3000 })],
      3000,
    ).pnl,
    160,
  );
});

test("signed broker multipliers support shorts and unsupported valuation remains unknown", /** Do not infer a multiplier from units or fabricate missing basis. */ () => {
  const book = createSnapshot();
  Object.assign(book.positions![0], {
    quantity: -10,
    pnlBase: 900,
    pnlPerMark: -10,
  });
  assert.equal(applyPriceTicks(book, [createTick()], 2000).pnl, -150);
  Object.assign(book.positions![0], {
    pnl: null,
    pnlBase: null,
    markPrice: null,
  });
  assert.equal(applyPriceTicks(book, [createTick()], 2000).pnl, null);
});

test("missing coefficients preserve marks and aggregate overflow is unknown", /** Reject unsafe calculations rather than displaying infinity. */ () => {
  const book = createSnapshot();
  book.positions![0].pnlPerMark = null;
  assert.equal(applyPriceTicks(book, [createTick()], 2000).pnl, 100);
  book.positions![0].pnl = Number.MAX_VALUE;
  book.positions!.push({ ...book.positions![0], id: "second" });
  assert.equal(calculatePositionPnl(book), null);
  assert.equal(formatActivityTime("not a date"), "Unknown time");
});
