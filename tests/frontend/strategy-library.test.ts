/** Library failures must not masquerade as an empty collection of saved strategies. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseStrategyLibrary } from "../../frontend/src/features/strategies/use-strategy-library";
test("library accepts real definition summaries and rejects malformed payloads", () => {
  assert.deepEqual(parseStrategyLibrary({ strategies: [] }), []);
  const strategy = {
    id: "saved",
    definition: {
      name: "My basket",
      market: "cash",
      legs: [{ stockCode: "RELIANCE" }],
    },
  };
  assert.deepEqual(parseStrategyLibrary({ strategies: [strategy] }), [
    strategy,
  ]);
  for (const payload of [
    null,
    {},
    { strategies: [{}] },
    {
      strategies: [
        {
          ...strategy,
          definition: { ...strategy.definition, market: "other" },
        },
      ],
    },
  ]) {
    assert.throws(() => parseStrategyLibrary(payload), /unavailable/);
  }
});
