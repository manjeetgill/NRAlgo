/** Read-only overview aggregation: distinct broker identities and honest incomplete totals. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  combineConnectedPositions,
  combineConnectedBalances,
} from "../frontend/src/features/overview/account-model.ts";

const book = (id, positions, current = true) => ({
  id,
  name: id,
  current,
  snapshot: positions === null ? null : { positions },
});
const position = (pnl = 10) => ({
  id: "same-contract",
  symbol: "TEST",
  quantity: 1,
  pnl,
});

const balanceBook = (id, funds, holdings = []) => ({
  id,
  name: id,
  current: true,
  holdingsCurrent: true,
  snapshot: { availableFunds: funds, holdings },
});

test("balances and pledged holdings aggregate all connected brokers without merging identities", () => {
  const holding = { id: "SAME", quantity: 2, pledgedQuantity: 1 };
  const result = combineConnectedBalances([
    balanceBook("kotak", 100, [holding]),
    balanceBook("zerodha", 200, [holding]),
    balanceBook("icici", 50),
  ]);
  assert.equal(result.availableFunds, 350);
  assert.equal(result.pledgedQuantity, 2);
  assert.equal(result.holdingsComplete, true);
  assert.deepEqual(
    result.holdings.map((row) => row.id),
    ["kotak:SAME", "zerodha:SAME"],
  );
});

test("unknown funds do not hide known holdings; stale holdings cannot establish complete totals", () => {
  const unknownFunds = balanceBook("kotak", null, [
    { id: "A", pledgedQuantity: 2 },
  ]);
  assert.equal(combineConnectedBalances([unknownFunds]).availableFunds, null);
  assert.equal(combineConnectedBalances([unknownFunds]).pledgedQuantity, 2);
  const stale = { ...unknownFunds, holdingsCurrent: false };
  const result = combineConnectedBalances([stale]);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdingsComplete, false);
  assert.equal(result.pledgedQuantity, null);
});

test("no connected accounts remain unknown, verified empty holdings and zero balances are valid", () => {
  assert.equal(combineConnectedBalances([]).availableFunds, null);
  assert.equal(combineConnectedBalances([]).pledgedQuantity, null);
  const result = combineConnectedBalances([balanceBook("kotak", 0)]);
  assert.equal(result.availableFunds, 0);
  assert.equal(result.pledgedQuantity, 0);
  assert.equal(result.holdingsComplete, true);
});

test("a derivatives response is not counted as demat holdings", () => {
  const result = combineConnectedBalances([
    balanceBook("kotak", 100, [
      {
        id: "OPTION",
        exchange: "nse_fo",
        product: "Options",
        pledgedQuantity: 0,
      },
    ]),
    balanceBook("zerodha", 200, [
      { id: "STOCK", exchange: "nse_cm", product: "CNC", pledgedQuantity: 5 },
    ]),
  ]);
  assert.equal(result.availableFunds, 300);
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdingsComplete, false);
  assert.equal(result.pledgedQuantity, null);
  assert.deepEqual(result.invalidHoldingBrokers, ["kotak"]);
});

test("all three connected brokers contribute separate rows and P&L", () => {
  const result = combineConnectedPositions([
    book("kotak", [position(10)]),
    book("zerodha", [position(-5)]),
    book("icici", [position(20)]),
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.pnl, 25);
  assert.deepEqual(
    result.positions.map((row) => row.id),
    ["kotak:same-contract", "zerodha:same-contract", "icici:same-contract"],
  );
  assert.deepEqual(
    result.positions.map((row) => row.brokerName),
    ["kotak", "zerodha", "icici"],
  );
});

test("unavailable or stale books preserve known rows without asserting a complete total", () => {
  for (const failed of [
    book("icici", null, false),
    book("icici", [position(99)], false),
    book("icici", null),
  ]) {
    const result = combineConnectedPositions([
      book("kotak", [position()]),
      failed,
    ]);
    assert.equal(result.complete, false);
    assert.equal(result.pnl, null);
    assert.equal(result.positions[0].pnl, 10);
  }
});

test("empty books mean zero only when every connected account was verified", () => {
  assert.equal(combineConnectedPositions([]).pnl, null);
  assert.equal(combineConnectedPositions([book("kotak", [])]).pnl, 0);
  assert.equal(
    combineConnectedPositions([book("kotak", []), book("icici", null)]).pnl,
    null,
  );
});

test("unknown marks and nonfinite P&L are never added as zero", () => {
  for (const pnl of [null, NaN, Infinity]) {
    const result = combineConnectedPositions([book("kotak", [position(pnl)])]);
    assert.equal(result.complete, true);
    assert.equal(result.pnl, null);
  }
});

test("removed providers do not contribute previous exposure to connected-only totals", () => {
  const result = combineConnectedPositions([book("zerodha", [position(5)])]);
  assert.equal(result.positions.length, 1);
  assert.equal(result.pnl, 5);
});
