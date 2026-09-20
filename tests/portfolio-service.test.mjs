import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboard,
  calculatePortfolioSummary,
  canonicalPortfolioKey,
  portfolioTradingDay,
} from "../backend/portfolio-service.ts";

// Durable legacy rows can share an underlying token without call/put metadata.
const storedOption = (overrides = {}) => ({
  id: "row-1",
  snapshot_id: "snapshot",
  account_id: "account",
  provider: "kotak",
  kind: "holding",
  canonical_key: "holding:token:123",
  isin: "",
  instrument_token: "123",
  symbol: "NIFTY",
  underlying: "NIFTY",
  exchange: "nse_fo",
  product: "Options",
  quantity: 65,
  pledged_quantity: 0,
  t1_quantity: 0,
  mtf_quantity: 0,
  average_price: 100,
  mark_price: 110,
  pnl: 650,
  expiry: "2026-09-22",
  option_right: "",
  strike: "23350",
  ...overrides,
});

test("incomplete legacy option contracts remain separate dashboard rows", () => {
  const result = buildDashboard(
    [],
    [],
    [storedOption(), storedOption({ id: "row-2" })],
    [],
  );
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.quantity),
    [65, 65],
  );
  assert.equal(new Set(result.items.map((item) => item.canonicalKey)).size, 2);
});

test("legacy long and short holdings do not cancel each other in the dashboard", () => {
  const result = buildDashboard(
    [],
    [],
    [
      storedOption({ option_right: "CE" }),
      storedOption({ id: "row-2", option_right: "CE", quantity: -65 }),
    ],
    [],
  );
  assert.equal(result.items.length, 2);
});

const row = (overrides = {}) => ({
  instrumentToken: "123",
  symbol: "RELIANCE-EQ",
  isin: "INE002A01018",
  underlying: "",
  exchange: "nse_cm",
  product: "CNC",
  quantity: 10,
  pledgedQuantity: 4,
  t1Quantity: 1,
  mtfQuantity: 0,
  averagePrice: 200,
  markPrice: 250,
  pnl: 500,
  pnlBase: null,
  pnlPerMark: null,
  expiry: "",
  right: "",
  strike: "",
  ...overrides,
});

test("portfolio identity clubs equities by ISIN across provider tokens", () => {
  assert.equal(
    canonicalPortfolioKey("holding", row({ instrumentToken: "123" })),
    canonicalPortfolioKey("holding", row({ instrumentToken: "987" })),
  );
});

test("portfolio totals keep pledged holdings and buying power out of equity", () => {
  const summary = calculatePortfolioSummary(
    {
      availableMargin: 9_000,
      cashBalance: 1_000,
      usedMargin: 500,
      collateralValue: 1_000,
      positionMtm: null,
    },
    [row()],
    [row({ quantity: -1, pnl: -100 })],
  );
  assert.deepEqual(summary, {
    holdingsValue: 2_500,
    investedValue: 2_000,
    pledgedValue: 1_000,
    positionsPnl: -100,
    availableMargin: 9_000,
    cashBalance: 1_000,
    usedMargin: 500,
    collateralValue: 1_000,
    totalEquity: 3_400,
  });
});

test("portfolio totals remain unavailable when a contributing value is unknown", () => {
  const summary = calculatePortfolioSummary(
    {
      availableMargin: 9_000,
      cashBalance: null,
      usedMargin: null,
      collateralValue: null,
      positionMtm: null,
    },
    [row({ markPrice: null })],
    [],
  );
  assert.equal(summary.holdingsValue, null);
  assert.equal(summary.totalEquity, null);
  assert.equal(summary.availableMargin, 9_000);
});

test("daily snapshots use the Indian trading calendar", () => {
  assert.equal(
    portfolioTradingDay(Date.parse("2026-09-20T20:00:00.000Z")),
    "2026-09-21",
  );
});
