/** Guard the regression where each tick render recreated the option-chain snapshot effect. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
test("empty position strikes are stable and cached feed reads never load broker reports", () => {
  const chain = readFileSync(
    new URL(
      "../../frontend/src/components/live-option-chain.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(chain, /positionStrikes = EMPTY_POSITION_STRIKES/);
  assert.doesNotMatch(chain, /positionStrikes = \[\]/);
  const feed = readFileSync(
    new URL(
      "../../frontend/src/features/option-chain/use-market-feed.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(feed, /\/market\/feed/);
  assert.doesNotMatch(feed, /\/market\/kotak\/feed/);
  assert.doesNotMatch(feed, /\/reports|\/positions|\/quotes|setInterval/);
  assert.match(feed, /controller.abort\(\)/);
});
