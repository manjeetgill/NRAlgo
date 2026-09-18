/** Analytic tails prevent a finite plotting window being misrepresented as bounded risk. */
import assert from "node:assert/strict";
import test from "node:test";
import { summarizePayoff } from "../../frontend/src/features/spread-builder/spread-payoff";
test("vertical spread extrema and roots use signed units and paid premiums", () => {
  assert.deepEqual(
    summarizePayoff([
      { right: "call", side: "buy", strike: 100, quantity: 10, premium: 12 },
      { right: "call", side: "sell", strike: 120, quantity: 10, premium: 4 },
    ]),
    { maxProfit: 120, maxLoss: 80, breakevens: [108] },
  );
});
test("uncovered call risk is unbounded and missing premiums cannot become zero", () => {
  assert.equal(
    summarizePayoff([
      { right: "call", side: "sell", strike: 100, quantity: 10, premium: 12 },
    ])?.maxLoss,
    Infinity,
  );
  assert.equal(summarizePayoff([]), null);
  assert.equal(
    summarizePayoff([
      { right: "put", side: "buy", strike: 100, quantity: 10, premium: NaN },
    ]),
    null,
  );
});
