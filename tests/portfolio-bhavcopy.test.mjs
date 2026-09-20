import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPortfolioBhavcopy,
  exactOptionExpiry,
} from "../backend/portfolio-bhavcopy.ts";
const row = (patch = {}) => ({
  id: "position",
  kind: "position",
  underlying: "NIFTY",
  exchange: "nse_fo",
  expiry: "27 Oct, 2026",
  option_right: "CE",
  strike: "23400.00",
  quantity: 65,
  average_price: 350,
  mark_price: null,
  pnl: null,
  ...patch,
});
test("matches exact NSE contract and returns dated display-only valuation", async () => {
  const original = row();
  const [result] = await applyPortfolioBhavcopy(
    async (sql, args) => {
      assert.match(sql, /i.exchange='NSE'/);
      assert.match(sql, /i.expiry_date=r.expiry/);
      assert.match(sql, /i.option_right=r.option_right/);
      assert.match(sql, /i.strike_price=r.strike/);
      assert.match(sql, /c.day=l.day/);
      assert.match(sql, /source LIKE 'nse-fno:%'/);
      assert.deepEqual(JSON.parse(args[0]), [
        {
          id: "position",
          underlying: "NIFTY",
          expiry: "2026-10-27",
          option_right: "call",
          strike: 23400,
        },
      ]);
      assert.equal(args[1], "2026-09-20");
      return [{ id: "position", day: "2026-09-18", close: 370 }];
    },
    [original],
    "2026-09-20",
  );
  assert.equal(result.mark_price, 370);
  assert.equal(result.pnl, 1300);
  assert.equal(result.last_close_day, "2026-09-18");
  assert.equal(result.estimated_pnl, true);
  assert.equal(original.mark_price, null);
});
test("short position uses signed units for estimated unrealized P&L", async () => {
  const [result] = await applyPortfolioBhavcopy(
    async () => [{ id: "position", day: "2026-09-18", close: 300 }],
    [row({ quantity: -65 })],
    "2026-09-20",
  );
  assert.equal(result.pnl, 3250);
});
for (const patch of [
  { mark_price: 400 },
  { kind: "holding" },
  { exchange: "bse_fo" },
  { underlying: "" },
  { expiry: "bad" },
  { option_right: "" },
  { strike: "" },
  { quantity: 0 },
]) {
  test(`unsupported or already marked row is untouched ${JSON.stringify(patch)}`, async () => {
    const original = row(patch);
    assert.deepEqual(
      await applyPortfolioBhavcopy(
        async () => {
          assert.fail("Must not query");
        },
        [original],
        "2026-09-20",
      ),
      [original],
    );
  });
}
test("missing or ambiguous closes stay unavailable", async () => {
  for (const prices of [
    [],
    [
      { id: "position", close: 1 },
      { id: "position", close: 2 },
    ],
  ]) {
    assert.deepEqual(
      await applyPortfolioBhavcopy(async () => prices, [row()], "2026-09-20"),
      [row()],
    );
  }
});
test("no average means no invented P&L; broker P&L is preserved", async () => {
  for (const patch of [{ average_price: null }, { pnl: 55 }]) {
    const original = row(patch);
    const [result] = await applyPortfolioBhavcopy(
      async () => [{ id: "position", day: "2026-09-18", close: 370 }],
      [original],
      "2026-09-20",
    );
    assert.equal(result.pnl, original.pnl);
    assert.equal(result.estimated_pnl, false);
  }
});
test("expiry parser refuses invalid dates instead of rolling into another month", () => {
  assert.equal(exactOptionExpiry("27 Oct, 2026"), "2026-10-27");
  assert.equal(exactOptionExpiry("2026-10-27"), "2026-10-27");
  for (const value of [
    "31 Feb, 2026",
    "2026-02-31",
    "27 Nope, 2026",
    "27/10/26",
  ]) {
    assert.equal(exactOptionExpiry(value), null);
  }
});
