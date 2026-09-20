import test from "node:test";
import assert from "node:assert/strict";
import { enrichPortfolioPositionMarks } from "../backend/portfolio-position-marks.ts";
const now = 1789908000000;
const position = (patch = {}) => ({
  symbol: "TEST",
  exchange: "nse_fo",
  instrumentToken: "123",
  quantity: 65,
  markPrice: null,
  pnl: null,
  pnlBase: -24050,
  pnlPerMark: 65,
  ...patch,
});
const quote = (patch = {}) => ({
  instrument: "123",
  price: 400,
  observedAt: now - 2 * 86400000,
  ...patch,
});
test("missing Kotak long position marks use the exact closing snapshot and calculate P&L", async () => {
  const rows = [position()];
  const result = await enrichPortfolioPositionMarks(
    rows,
    async (tokens, segment) => {
      assert.deepEqual(tokens, ["123"]);
      assert.equal(segment, "nse_fo");
      return [quote()];
    },
    now,
  );
  assert.equal(result[0].markPrice, 400);
  assert.equal(result[0].pnl, 1950);
  assert.equal(rows[0].markPrice, null);
});
test("short position uses signed units and cash basis", async () => {
  const [row] = await enrichPortfolioPositionMarks(
    [position({ quantity: -65, pnlBase: 22142.25, pnlPerMark: -65 })],
    async () => [quote({ price: 300 })],
    now,
  );
  assert.equal(row.pnl, 2642.25);
});
for (const [name, quotes] of [
  ["missing", []],
  ["wrong token", [quote({ instrument: "456" })]],
  ["duplicate", [quote(), quote()]],
  ["unknown timestamp", [quote({ observedAt: null })]],
  ["future timestamp", [quote({ observedAt: now + 60000 })]],
  ["too old", [quote({ observedAt: now - 8 * 86400000 })]],
  ["invalid price", [quote({ price: NaN })]],
  ["zero price", [quote({ price: 0 })]],
]) {
  test(`unusable quote remains unavailable: ${name}`, async () => {
    const [row] = await enrichPortfolioPositionMarks(
      [position()],
      async () => quotes,
      now,
    );
    assert.equal(row.markPrice, null);
    assert.equal(row.pnl, null);
  });
}
test("quote outage preserves broker report and position quantity", async () => {
  const original = position({ markPrice: 390, pnl: 100 });
  const [row] = await enrichPortfolioPositionMarks(
    [original],
    async () => {
      throw new Error("offline");
    },
    now,
  );
  assert.deepEqual(row, original);
});
test("never invent P&L when the broker did not supply its basis", async () => {
  const [row] = await enrichPortfolioPositionMarks(
    [position({ pnlBase: null })],
    async () => [quote()],
    now,
  );
  assert.equal(row.markPrice, 400);
  assert.equal(row.pnl, null);
});
test("same token on different exchanges cannot leak a price", async () => {
  const result = await enrichPortfolioPositionMarks(
    [position(), position({ exchange: "nse_cm" })],
    async (_tokens, segment) => (segment === "nse_fo" ? [quote()] : []),
    now,
  );
  assert.equal(result[0].markPrice, 400);
  assert.equal(result[1].markPrice, null);
});
test("deduplicates tokens and limits each request to 50", async () => {
  const rows = Array.from({ length: 51 }, (_, i) =>
    position({ instrumentToken: String(i + 1) }),
  );
  const sizes = [];
  await enrichPortfolioPositionMarks(
    [...rows, rows[0]],
    async (tokens) => {
      sizes.push(tokens.length);
      return [];
    },
    now,
  );
  assert.deepEqual(sizes, [50, 1]);
});
