import test from "node:test";
import assert from "node:assert/strict";
import { evaluateLiveRisk, RiskLimitError } from "../backend/live/risk.ts";
import { context, intent } from "./fixtures.mjs";

test("valid order reserves exact integer-paise notional without mutating inputs", () => {
  const state = context(),
    before = structuredClone(state);
  assert.equal(evaluateLiveRisk(intent, state), 10000);
  assert.deepEqual(state, before);
});
test("risk rejects intents outside the regular market session, independent of broker session health", () => {
  const c = context();
  // Fixture `now` is a Wednesday 10:00 IST; move it to the same day's midnight, well
  // outside 09:15-15:30 IST, without touching snapshot freshness relative to it.
  const closed = c.now - 10 * 60 * 60 * 1000;
  c.now = closed;
  c.snapshot.capturedAt = closed;
  assert.throws(
    () => evaluateLiveRisk(intent, c),
    (error) =>
      error instanceof RiskLimitError && /market session/.test(error.message),
  );
});
for (const [name, change, message] of [
  ["stale snapshot", (c) => (c.snapshot.capturedAt -= 5001), /Fresh complete/],
  ["future snapshot", (c) => c.snapshot.capturedAt++, /Fresh complete/],
  [
    "incomplete snapshot",
    (c) => (c.snapshot.complete = false),
    /Fresh complete/,
  ],
  [
    "unhealthy session",
    (c) => (c.snapshot.sessionHealthy = false),
    /Fresh complete/,
  ],
  [
    "daily loss equality",
    (c) => (c.snapshot.dailyPnlPaise = -10000),
    /Daily loss/,
  ],
  [
    "insufficient funds",
    (c) => (c.snapshot.availablePaise = 9999),
    /Capital reservation/,
  ],
  ["reserved capital", (c) => (c.reservedPaise = 90001), /Capital reservation/],
  [
    "gross exposure",
    (c) => (c.snapshot.grossExposurePaise = 190001),
    /Gross exposure/,
  ],
  [
    "position limit",
    (c) => (c.snapshot.positions[intent.instrument] = 91),
    /Position limit/,
  ],
  [
    "pending orders do not net",
    (c) => {
      c.snapshot.positions[intent.instrument] = -80;
      c.outstandingUnits[intent.instrument] = 11;
    },
    /Position limit/,
  ],
  ["rate equality", (c) => (c.ordersLastMinute = 10), /Order rate/],
  [
    "negative reservation",
    (c) => (c.reservedPaise = -1),
    /Invalid risk context/,
  ],
  [
    "fractional pending units",
    (c) => (c.outstandingUnits[intent.instrument] = 0.5),
    /Invalid risk context/,
  ],
  ["nonfinite clock", (c) => (c.now = NaN), /Invalid risk context/],
]) {
  test(`risk rejects ${name}`, () => {
    const c = context();
    change(c);
    assert.throws(() => evaluateLiveRisk(intent, c), message);
  });
}
test("exact capital, exposure, units and snapshot-age boundaries pass", () => {
  const c = context();
  c.snapshot.capturedAt -= 5000;
  c.snapshot.availablePaise = c.limits.maxReservedPaise = 10000;
  c.limits.maxGrossExposurePaise = 10000;
  c.limits.maxPositionUnits = 10;
  assert.equal(evaluateLiveRisk(intent, c), 10000);
});
test("unsafe multiplication is rejected", () => {
  assert.throws(
    () =>
      evaluateLiveRisk(
        { ...intent, limitPaise: Number.MAX_SAFE_INTEGER },
        context(),
      ),
    RiskLimitError,
  );
});
for (const [position, side] of [
  [10, "sell"],
  [-10, "buy"],
]) {
  test(`reduce-only ${side} releases no additional capital`, () => {
    const c = context();
    c.snapshot.positions[intent.instrument] = position;
    c.snapshot.availablePaise = 0;
    assert.equal(evaluateLiveRisk({ ...intent, side, reduceOnly: true }, c), 0);
    c.outstandingUnits[intent.instrument] = 1;
    assert.throws(
      () => evaluateLiveRisk({ ...intent, side, reduceOnly: true }, c),
      /Reduce-only/,
    );
  });
}
test("reduce-only cannot open a position or bypass stale state and rate limits", () => {
  const i = { ...intent, side: "sell", reduceOnly: true },
    c = context();
  assert.throws(() => evaluateLiveRisk(i, c), /Reduce-only/);
  c.snapshot.positions[i.instrument] = 10;
  c.ordersLastMinute = 10;
  assert.throws(() => evaluateLiveRisk(i, c), /Order rate/);
  c.snapshot.complete = false;
  assert.throws(() => evaluateLiveRisk(i, c), /Fresh complete/);
});
