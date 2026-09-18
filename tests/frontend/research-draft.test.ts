/** Research defaults are isolated editable parameters, never broker marks or submitted orders. */
import assert from "node:assert/strict";
import test from "node:test";
import { createResearchDefinition } from "../../frontend/src/features/research/research-draft";

test("new spread drafts are empty and do not share mutable state", () => {
  const first = createResearchDefinition("options");
  const second = createResearchDefinition("options");
  first.legs.push({ stockCode: "TEST", quantity: 25, side: "buy" });
  first.name = "Draft";
  assert.deepEqual(second.legs, []);
  assert.equal(second.name, "");
  assert.equal(second.market, "options");
  assert.equal("price" in second, false);
});

test("cash defaults are copied and never change later drafts", () => {
  const first = createResearchDefinition("cash");
  first.legs[0].quantity = 42;
  assert.equal(createResearchDefinition("cash").legs[0].quantity, 1);
});
