import assert from "node:assert/strict";
import test from "node:test";
import { normalizePortfolioRows } from "../backend/broker-portfolio-normalizer.ts";

const position = (patch = {}) => ({
  trdSym: "NIFTY26OCT23400CE",
  sym: "NIFTY",
  tok: "12345",
  exSeg: "nse_fo",
  prod: "NRML",
  expDt: "27 Oct, 2026",
  optTp: "CE",
  stkPrc: "23400.00",
  cfBuyQty: "65",
  flBuyQty: "0",
  cfSellQty: "0",
  flSellQty: "0",
  cfBuyAmt: "13000",
  buyAmt: "0",
  cfSellAmt: "0",
  sellAmt: "0",
  multiplier: "1",
  genNum: "1",
  genDen: "1",
  prcNum: "1",
  prcDen: "1",
  avgPrc: "370",
  ltp: "250",
  ...patch,
});

test("Kotak long position derives buy basis and P&L from documented cash fields", () => {
  const [row] = normalizePortfolioRows("positions", [position()]);
  assert.equal(row.quantity, 65);
  assert.equal(row.averagePrice, 200);
  assert.equal(row.markPrice, 250);
  assert.equal(row.pnlBase, -13000);
  assert.equal(row.pnlPerMark, 65);
  assert.equal(row.pnl, 3250);
});

test("Kotak short position derives sell basis instead of trusting avgPrc", () => {
  const [row] = normalizePortfolioRows("positions", [
    position({
      cfBuyQty: "0",
      cfSellQty: "65",
      cfBuyAmt: "0",
      cfSellAmt: "16250",
      avgPrc: "340.65",
      ltp: "200",
    }),
  ]);
  assert.equal(row.quantity, -65);
  assert.equal(row.averagePrice, 250);
  assert.equal(row.markPrice, 200);
  assert.equal(row.pnlBase, 16250);
  assert.equal(row.pnlPerMark, -65);
  assert.equal(row.pnl, 3250);
});

test("Kotak calculated average respects the instrument precision", () => {
  const [row] = normalizePortfolioRows("positions", [
    position({ cfBuyAmt: "13001", precision: "2" }),
  ]);
  assert.equal(row.averagePrice, 200.02);
});

test("Kotak non-positive LTP stays unavailable for exact quote enrichment", () => {
  const [row] = normalizePortfolioRows("positions", [position({ ltp: "0" })]);
  assert.equal(row.markPrice, null);
  assert.equal(row.pnl, null);
  assert.equal(row.averagePrice, 200);
});
