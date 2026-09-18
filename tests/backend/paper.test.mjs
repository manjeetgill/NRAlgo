/** Strictly offline paper tests: fake broker HTTP, isolated PostgreSQL and a fixed market clock.
 * No real broker credentials, sockets or orders are ever constructed by this suite.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  newPaperLedger,
  placePaperOrder,
  modifyPaperOrder,
  cancelPaperOrder,
  matchPaperOrders,
  paperSummary,
  expirePaperOrders,
  paperInstrumentKey,
} from "../../dist/backend/paper-trading-ledger.js";
import { normalizePortfolioRows } from "../../dist/backend/broker-portfolio-normalizer.js";
import {
  KotakMarketDataClient,
  parseKotakPaperFillQuote,
  validateKotakOrigin,
} from "../../dist/backend/kotak-market-data-client.js";
const now = Date.parse("2026-09-18T05:00:00Z"),
  realNow = Date.now;
Date.now = () => now;
after(() => {
  Date.now = realNow;
});
const intent = (extra = {}) => ({
  key: randomUUID(),
  instrument: "TEST",
  side: "buy",
  quantity: 10,
  limitPaise: 11000,
  ...extra,
});
const quote = (extra = {}) => ({
  instrument: "TEST",
  bid: 10000,
  ask: 10010,
  observedAt: now,
  receivedAt: now,
  ...extra,
});
const login = {
  accessToken: "fake-token-only",
  mobileNumber: "+919999999999",
  ucc: "FAKE",
  totp: "123456",
  mpin: "123456",
};
function kotakQuote(instrument = "123", extra = {}) {
  return [
    {
      exchange: "nse_cm",
      exchange_token: instrument,
      lstup_time: String(now / 1000),
      depth: { buy: [{ price: "100" }], sell: [{ price: "100.10" }] },
      ...extra,
    },
  ];
}
/** Emulate documented auth/quote envelopes, rejecting any path outside the three read-only capabilities. */
function fakeTransport(calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/tradeApiLogin")) {
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
    }
    if (url.endsWith("/tradeApiValidate")) {
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "trade",
          sid: "sid",
          baseUrl: "https://cis.kotaksecurities.com",
        },
      };
    }
    assert.equal(init.method, "GET");
    if (url.endsWith("/masterscrip/file-paths")) {
      assert.equal(init.headers.Authorization, "fake-token-only");
      return {
        data: {
          filesPaths: [
            "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/transformed/nse_fo.csv",
          ],
        },
      };
    }
    if (
      url.endsWith("/quick/user/positions") ||
      url.endsWith("/portfolio/v1/holdings")
    ) {
      assert.equal(init.headers.Auth, "trade");
      assert.equal(init.headers.Sid, "sid");
      return url.endsWith("/positions")
        ? {
            stat: "Ok",
            stCode: 200,
            data: [
              {
                trdSym: "REAL-OPTION",
                qty: "-25",
                exSeg: "nse_fo",
                prod: "NRML",
                accountSecret: "never-return",
              },
            ],
          }
        : {
            data: [
              {
                displaySymbol: "REAL-HOLDING",
                quantity: 7,
                averagePrice: 100.1234,
              },
            ],
          };
    }
    assert.match(
      url,
      /\/script-details\/1.0\/quotes\/neosymbol\/nse_(cm|fo)%7C123\/all$/,
    );
    return kotakQuote("123", {
      exchange: url.includes("nse_fo") ? "nse_fo" : "nse_cm",
    });
  };
}
test("paper reservations, immutable idempotency, full fills and fee-inclusive realized P&L", () => {
  const state = newPaperLedger(),
    input = intent();
  placePaperOrder(state, input, now);
  placePaperOrder(state, input, now);
  assert.equal(state.orders.length, 1);
  assert.equal(paperSummary(state, now).reservedPaise, 110500);
  assert.throws(
    () => placePaperOrder(state, { ...input, quantity: 11 }, now),
    /different content/,
  );
  matchPaperOrders(state, [quote()], now);
  assert.equal(state.orders[0].state, "filled");
  assert.equal(state.orders[0].fillPaise, 10016);
  assert.equal(state.cashPaise, 9899340);
  placePaperOrder(state, intent({ side: "sell", limitPaise: 9000 }), now);
  matchPaperOrders(state, [quote()], now);
  assert.equal(state.positions.TEST.quantity, 0);
  assert.equal(state.realizedPaise, -1210);
  assert.equal(state.cashPaise, state.capitalPaise + state.realizedPaise);
});
test("unfunded buys and oversold units are rejected; modify/cancel release reservations", () => {
  const state = newPaperLedger();
  assert.throws(
    () => placePaperOrder(state, intent({ quantity: 10000 }), now),
    /cash/,
  );
  assert.throws(
    () => placePaperOrder(state, intent({ side: "sell" }), now),
    /short selling/,
  );
  const input = intent();
  placePaperOrder(state, input, now);
  modifyPaperOrder(state, input.key, 5, 10500, now);
  assert.equal(paperSummary(state, now).reservedPaise, 53000);
  assert.throws(
    () => modifyPaperOrder(state, input.key, 10000, 10500, now),
    /cash/,
  );
  assert.equal(state.orders[0].quantity, 5);
  cancelPaperOrder(state, input.key, now);
  assert.equal(paperSummary(state, now).reservedPaise, 0);
  matchPaperOrders(state, [quote()], now);
  assert.equal(state.orders[0].state, "cancelled");
});
test("stale, zero, crossed, future and pre-modification quotes cannot fill; DAY expiry releases cash", () => {
  for (const override of [
    { observedAt: now - 61000 },
    { receivedAt: now - 16000 },
    { bid: 0 },
    { bid: 12000 },
    { observedAt: now + 2000 },
  ]) {
    const state = newPaperLedger();
    placePaperOrder(state, intent(), now);
    matchPaperOrders(state, [quote(override)], now);
    assert.equal(state.orders[0].state, "open");
  }
  const state = newPaperLedger(),
    input = intent();
  placePaperOrder(state, input, now);
  modifyPaperOrder(state, input.key, 1, 11000, now + 1);
  matchPaperOrders(state, [quote()], now + 1);
  assert.equal(state.orders[0].state, "open");
  expirePaperOrders(state, now + 86400000);
  assert.equal(state.orders[0].state, "expired");
  assert.equal(paperSummary(state, now + 86400000).reservedPaise, 0);
});
test("stale marks never report current unrealized P&L", () => {
  const state = newPaperLedger();
  placePaperOrder(state, intent(), now);
  matchPaperOrders(state, [quote()], now);
  assert.equal(typeof paperSummary(state, now).unrealizedPaise, "number");
  assert.equal(paperSummary(state, now + 16000).unrealizedPaise, null);
});
test("Kotak uses documented auth headers, data-only URL and session ownership; no secrets returned", async () => {
  const calls = [],
    manager = new KotakMarketDataClient(fakeTransport(calls));
  await manager.connect("a", "session-a", now + 60000, login);
  assert.equal(manager.isConnected("a", "session-b"), false);
  assert.equal(manager.isConnected("b", "session-a"), false);
  assert.equal(calls[1].init.headers.Auth, "view");
  assert.equal(calls[1].init.headers.sid, "sid");
  const value = await manager.getPaperFillQuote("a", "session-a", "123");
  assert.equal(value.ask, 10010);
  assert.equal(calls[2].init.headers.Authorization, login.accessToken);
  assert.equal(JSON.stringify(value).includes(login.accessToken), false);
  manager.disconnect("a");
  await assert.rejects(
    manager.getPaperFillQuote("a", "session-a", "123"),
    /Connect/,
  );
});
test("Kotak rejects unexpected hosts, wrong instruments and bad auth, redacting upstream errors", async () => {
  for (const host of [
    "http://cis.kotaksecurities.com",
    "https://cis.kotaksecurities.com.evil.test",
    "https://localhost",
    "https://cis.kotaksecurities.com/path",
  ]) {
    assert.throws(() => validateKotakOrigin(host));
  }
  assert.throws(() => parseKotakPaperFillQuote(kotakQuote("456"), "123"));
  assert.throws(() =>
    parseKotakPaperFillQuote(kotakQuote("123", { lstup_time: "bad" }), "123"),
  );
  const manager = new KotakMarketDataClient(async () => {
    throw new Error(login.accessToken);
  });
  await assert.rejects(
    manager.connect("a", "a", now + 60000, login),
    (error) => !error.message.includes(login.accessToken),
  );
});
test("paper dependency paths contain no live execution or order RPC", () => {
  for (const file of [
    "paper-trading-ledger.ts",
    "paper-trading-routes.ts",
    "kotak-market-data-client.ts",
  ]) {
    const source = readFileSync(
      new URL(`../../backend/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /from ["'][^"']*\/live\//);
    assert.doesNotMatch(
      source,
      /\.call\(["'](?:placeOrder|cancelOrder|modifyOrder)["']/,
    );
  }
});

test("disconnect fences a pending Kotak login so a late response cannot restore it", async () => {
  let finish;
  const manager = new KotakMarketDataClient(async (url) => {
    if (url.endsWith("/tradeApiLogin")) {
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
    }
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const connecting = manager.connect("a", "a", now + 60000, login);
  await new Promise((resolve) => setImmediate(resolve));
  manager.disconnect("a");
  finish({
    data: {
      status: "success",
      kType: "Trade",
      token: "trade",
      sid: "sid",
      baseUrl: "https://cis.kotaksecurities.com",
    },
  });
  await assert.rejects(connecting, /login failed/);
  assert.equal(manager.isConnected("a", "a"), false);
});
test("options enforce lots, isolate contract balances, prevent naked sales and flag expiry without settlement", () => {
  const state = newPaperLedger(),
    option = {
      expiryDate: "2026-09-24",
      right: "call",
      strikePrice: 25000,
      lotSize: 25,
    };
  const order = intent({ quantity: 25, option });
  assert.throws(
    () => placePaperOrder(state, intent({ quantity: 1, option }), now),
    /multiple/,
  );
  assert.throws(
    () =>
      placePaperOrder(
        state,
        intent({
          quantity: 25,
          option: { ...option, expiryDate: "2026-09-17" },
        }),
        now,
      ),
    /expired/,
  );
  placePaperOrder(state, order, now);
  assert.throws(
    () => modifyPaperOrder(state, order.key, 26, 11000, now),
    /multiple/,
  );
  matchPaperOrders(
    state,
    [quote({ instrument: paperInstrumentKey(order) })],
    now,
  );
  assert.equal(state.positions[paperInstrumentKey(order)].quantity, 25);
  for (const changed of [
    { right: "put" },
    { strikePrice: 25100 },
    { expiryDate: "2026-10-01" },
  ]) {
    assert.throws(
      () =>
        placePaperOrder(
          state,
          intent({
            quantity: 25,
            side: "sell",
            option: { ...option, ...changed },
          }),
          now,
        ),
      /held|sell|units/i,
    );
  }
  const expired = paperSummary(state, Date.parse("2026-09-25T05:00Z"));
  assert.equal(expired.settlementRequired.length, 1);
  assert.equal(expired.equityPaise, null);
  placePaperOrder(state, intent({ quantity: 25, side: "sell", option }), now);
  matchPaperOrders(
    state,
    [quote({ instrument: paperInstrumentKey(order), bid: 11000, ask: 11010 })],
    now,
  );
  assert.equal(state.positions[paperInstrumentKey(order)].quantity, 0);
});
test("position averages use side quantity, and scaled P&L follows each price change", () => {
  const row = normalizePortfolioRows("positions", [
    {
      trdSym: "TEST",
      tok: "123",
      exSeg: "nse_fo",
      cfBuyQty: "0",
      flBuyQty: "100",
      cfSellQty: "0",
      flSellQty: "40",
      buyAmt: "40000",
      sellAmt: "17600",
      multiplier: "2",
      genNum: "2",
      genDen: "1",
      prcNum: "2",
      prcDen: "2",
    },
  ])[0];
  assert.equal(row.quantity, 60);
  assert.equal(row.averagePrice, 100);
  assert.equal(row.pnlPerMark, 240);
  assert.equal(row.pnlBase + row.pnlPerMark * 110, 4000);
  assert.equal(row.pnlBase + row.pnlPerMark * 111, 4240);
});
test("portfolio normalizers preserve signed exposure and reject incomplete books", async () => {
  const position = normalizePortfolioRows("positions", [
    {
      trdSym: "TEST",
      qty: "-25",
      tok: "123",
      avgPrc: "100.25",
      ltp: "98.5",
      unrealizedPnl: "-43.75",
    },
  ])[0];
  assert.equal(position.quantity, -25);
  assert.equal(position.instrumentToken, "123");
  assert.equal(position.averagePrice, 100.25);
  assert.equal(position.markPrice, 98.5);
  assert.equal(position.pnl, -43.75);
  const derivedPosition = normalizePortfolioRows("positions", [
    {
      trdSym: "OPEN",
      qty: 0,
      cfBuyQty: "0",
      flBuyQty: "65",
      cfSellQty: "0",
      flSellQty: "0",
      buyAmt: "23133.5",
    },
  ])[0];
  assert.equal(derivedPosition.quantity, 65);
  assert.equal(derivedPosition.averagePrice, 355.9);
  assert.equal(derivedPosition.pnlBase, -23133.5);
  assert.equal(derivedPosition.pnlPerMark, 65);
  for (const raw of [
    null,
    {},
    [{ stock_code: "TEST" }],
    [{ stock_code: "TEST", quantity: "unknown" }],
  ]) {
    assert.throws(() => normalizePortfolioRows("positions", raw));
  }
  assert.deepEqual(normalizePortfolioRows("holdings", []), []);
  const manager = new KotakMarketDataClient(async (url, init) =>
    url.includes("tradeApi")
      ? fakeTransport()(url, init)
      : { stat: "Not_Ok", emsg: "secret", data: [] },
  );
  await manager.connect("a", "session", now + 60000, login);
  await assert.rejects(
    manager.getPortfolioRows("a", "session", "positions"),
    /unavailable/,
  );
  await assert.rejects(
    manager.getPortfolioRows("a", "wrong", "holdings"),
    /Connect/,
  );
  manager.close();
});
