import assert from "node:assert/strict";
import test from "node:test";
import { portfolioDashboardSchema } from "../frontend/src/features/portfolio/portfolio-model.ts";
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

// Combined totals must not hide a known account, nor portray it as the complete portfolio.
const account = (id, provider) => ({
  id,
  broker_id: id,
  provider,
  account_binding: id,
  display_label: provider,
  currency: "INR",
});
const snapshot = (accountId, patch = {}) => ({
  id: `snapshot-${accountId}`,
  account_id: accountId,
  trading_day: "2026-09-20",
  observed_at: 1,
  holdings_value: 100,
  invested_value: 90,
  pledged_value: 40,
  positions_pnl: -5,
  available_margin: 50,
  cash_balance: 10,
  used_margin: 20,
  collateral_value: 30,
  total_equity: 105,
  complete: true,
  warnings: [],
  ...patch,
});
test("combined portfolio exposes known subtotals while preserving unavailable complete totals", () => {
  const accounts = [account("one", "kotak"), account("two", "zerodha")];
  const snapshots = [
    snapshot("one", {
      holdings_value: null,
      pledged_value: null,
      cash_balance: null,
      total_equity: null,
      complete: false,
    }),
    snapshot("two"),
  ];
  const result = buildDashboard(accounts, snapshots, [], snapshots);
  assert.equal(result.summary.holdingsValue, null);
  assert.deepEqual(result.summaryCoverage.holdingsValue, {
    knownValue: 100,
    availableAccounts: 1,
    missingAccountIds: ["one"],
  });
  assert.equal(result.summary.availableMargin, 100);
  assert.equal(result.summaryCoverage.availableMargin.availableAccounts, 2);
  assert.equal(result.history[0].totalEquity, null);
});
test("unknown balances and missing snapshots are never converted to zero", () => {
  const result = buildDashboard(
    [account("one", "kotak"), account("two", "zerodha")],
    [snapshot("one", { cash_balance: null })],
    [],
    [],
  );
  assert.deepEqual(result.summaryCoverage.cashBalance, {
    knownValue: null,
    availableAccounts: 0,
    missingAccountIds: ["one", "two"],
  });
  assert.equal(result.summaryCoverage.holdingsValue.knownValue, 100);
  assert.equal(result.summary.holdingsValue, null);
});
test("a genuine zero is a known subtotal; negative P&L and complete totals remain intact", () => {
  const accounts = [account("one", "kotak"), account("two", "zerodha")];
  const result = buildDashboard(
    accounts,
    [
      snapshot("one", { cash_balance: null }),
      snapshot("two", { cash_balance: 0 }),
    ],
    [],
    [],
  );
  assert.deepEqual(result.summaryCoverage.cashBalance, {
    knownValue: 0,
    availableAccounts: 1,
    missingAccountIds: ["one"],
  });
  assert.equal(result.summary.positionsPnl, -10);
  const individual = buildDashboard([accounts[1]], [snapshot("two")], [], []);
  assert.equal(individual.summary.holdingsValue, 100);
  assert.deepEqual(
    individual.summaryCoverage.holdingsValue.missingAccountIds,
    [],
  );
});

test("partial dashboard coverage passes the frontend response contract", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const accounts = [account(id, "zerodha")];
  const snapshots = [snapshot(id, { holdings_value: null })];
  const parsed = portfolioDashboardSchema.parse(
    buildDashboard(accounts, snapshots, [], []),
  );
  assert.equal(parsed.summaryCoverage.holdingsValue.knownValue, null);
  assert.deepEqual(parsed.summaryCoverage.holdingsValue.missingAccountIds, [
    id,
  ]);
});
