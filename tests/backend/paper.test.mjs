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
} from "../../dist/backend/paper-model.js";
import { normalizePortfolioRows } from "../../dist/backend/portfolio-model.js";
import { createBreezeData } from "../../dist/backend/breeze.js";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";
import {
  KotakDataManager,
  normalizeKotakQuote,
  validateKotakOrigin,
} from "../../dist/backend/kotak-data.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { BrokerManager } from "../../dist/backend/brokers.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
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
    if (url.endsWith("/tradeApiLogin"))
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
    if (url.endsWith("/tradeApiValidate"))
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "trade",
          sid: "sid",
          baseUrl: "https://cis.kotaksecurities.com",
        },
      };
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
    manager = new KotakDataManager(fakeTransport(calls));
  await manager.connect("a", "session-a", now + 60000, login);
  assert.equal(manager.connected("a", "session-b"), false);
  assert.equal(manager.connected("b", "session-a"), false);
  assert.equal(calls[1].init.headers.Auth, "view");
  assert.equal(calls[1].init.headers.sid, "sid");
  const value = await manager.quote("a", "session-a", "123");
  assert.equal(value.ask, 10010);
  assert.equal(calls[2].init.headers.Authorization, login.accessToken);
  assert.equal(JSON.stringify(value).includes(login.accessToken), false);
  manager.disconnect("a");
  await assert.rejects(manager.quote("a", "session-a", "123"), /Connect/);
});
test("Kotak rejects unexpected hosts, wrong instruments and bad auth, redacting upstream errors", async () => {
  for (const host of [
    "http://cis.kotaksecurities.com",
    "https://cis.kotaksecurities.com.evil.test",
    "https://localhost",
    "https://cis.kotaksecurities.com/path",
  ])
    assert.throws(() => validateKotakOrigin(host));
  assert.throws(() => normalizeKotakQuote(kotakQuote("456"), "123"));
  assert.throws(() =>
    normalizeKotakQuote(kotakQuote("123", { lstup_time: "bad" }), "123"),
  );
  const manager = new KotakDataManager(async () => {
    throw new Error(login.accessToken);
  });
  await assert.rejects(
    manager.connect("a", "a", now + 60000, login),
    (error) => !error.message.includes(login.accessToken),
  );
});
test("paper dependency paths contain no live execution or order RPC", () => {
  for (const file of ["paper-model.ts", "paper-routes.ts", "kotak-data.ts"]) {
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
  const manager = new KotakDataManager(async (url) => {
    if (url.endsWith("/tradeApiLogin"))
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
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
  assert.equal(manager.connected("a", "a"), false);
});
test("paper API routes both brokers, isolates wallets/users, protects CSRF and blocks all real submissions by default", async (t) => {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const iciciCalls = [],
    kotakCalls = [];
  const icici = new BrokerManager(() => ({
    async call(method, params) {
      iciciCalls.push(method);
      if (method === "connect") return {};
      if (method === "positions" || method === "holdings")
        return normalizePortfolioRows("icici", method, [
          {
            stock_code: "REAL",
            quantity: 99,
            action: "sell",
            accountSecret: "never-return",
          },
        ]);
      assert.equal(method, "quotes");
      return [
        {
          stock_code: params.stockCode,
          exchange_code: params.exchangeCode,
          expiry_date: params.expiryDate,
          right: params.right,
          strike_price: params.strikePrice,
          ltp: 100,
          best_bid_price: 100,
          best_offer_price: 100.1,
          ltt: "18-Sep-2026 10:30:00",
        },
      ];
    },
    snapshot() {
      return { state: "connected", tick: null, receivedAt: null };
    },
    close() {},
  }));
  const kotak = new KotakDataManager(fakeTransport(kotakCalls));
  let realCalls = 0;
  const app = createApiApplication(
    store,
    { BROKER_ENCRYPTION_KEY: "ab".repeat(32) },
    icici,
    () => {
      realCalls++;
      throw new Error("Live forbidden");
    },
    undefined,
    kotak,
    fakeInstrumentCatalog(),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, body, method, headers = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method: method || (body === undefined ? "GET" : "POST"),
          headers: {
            cookie,
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      if (response.headers.get("set-cookie"))
        cookie = response.headers.get("set-cookie").split(";")[0];
      const data = await response.json();
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data };
    };
  }
  const alice = client(),
    bob = client();
  await alice("/auth/setup", {
    username: "paper-alice",
    password: "long-paper-password",
  });
  await bob("/auth/register", {
    username: "paper-bobby",
    password: "long-paper-password",
  });
  assert.equal(
    (
      await alice("/brokers/icici/connect", {
        apiKey: "fake-key",
        apiSecret: "fake-secret",
        sessionToken: "fake-session",
      })
    ).status,
    200,
  );
  assert.equal((await alice("/paper/kotak/connect", login)).status, 200);
  const input = intent();
  assert.equal(
    (
      await alice("/paper/icici/orders", input, undefined, {
        "X-CSRF-Token": "",
      })
    ).status,
    403,
  );
  assert.equal((await alice("/paper/icici/orders", input)).status, 200);
  assert.equal(
    (await alice("/paper/icici/orders", input)).data.orders.length,
    1,
  );
  const result = await alice("/paper/icici/refresh", {});
  assert.equal(result.status, 200);
  assert.equal(result.data.orders[0].state, "filled");
  assert.equal((await alice("/paper/kotak")).data.orders.length, 0);
  assert.equal((await bob("/paper/icici")).data.orders.length, 0);
  const kotakInput = intent({ instrument: "123" });
  assert.equal((await alice("/paper/kotak/orders", kotakInput)).status, 200);
  assert.equal(
    (await alice("/paper/kotak/refresh", {})).data.orders[0].state,
    "filled",
  );
  const resting = intent({ instrument: "123", limitPaise: 5000 });
  await alice("/paper/kotak/orders", resting);
  await alice(`/paper/kotak/orders/${resting.key}/modify`, {
    quantity: 1,
    limitPaise: 5500,
  });
  assert.equal(
    (await alice(`/paper/kotak/orders/${resting.key}/cancel`, {})).data
      .orders[1].state,
    "cancelled",
  );
  assert.equal(
    (await bob(`/paper/kotak/orders/${resting.key}/cancel`, {})).status,
    409,
  );
  for (const path of ["connect", "arm", "preview", "orders"])
    assert.equal((await alice(`/live/icici/${path}`, {})).status, 403);
  assert.equal(realCalls, 0);
  const option = {
    expiryDate: "2026-09-24",
    right: "call",
    strikePrice: 25000,
    lotSize: 25,
  };
  for (const broker of ["icici", "kotak"]) {
    const searchBody = { market: "options", query: "TEST" };
    assert.equal(
      (await bob(`/paper/${broker}/instruments`, searchBody)).status,
      409,
    );
    assert.equal(
      (
        await alice(`/paper/${broker}/instruments`, searchBody, undefined, {
          "X-CSRF-Token": "",
        })
      ).status,
      403,
    );
    const search = await alice(`/paper/${broker}/instruments`, searchBody);
    assert.equal(search.status, 200);
    assert.equal(search.data.total, 2);
    const selected = search.data.items[0];
    const order = intent({
      instrument: broker === "kotak" ? "123" : "TEST",
      quantity: 25,
      option,
      masterToken: selected.masterToken,
    });
    assert.equal(
      (
        await alice(`/paper/${broker}/orders`, {
          ...order,
          option: { ...option, strikePrice: 26000 },
        })
      ).status,
      409,
    );
    assert.equal((await alice(`/paper/${broker}/orders`, order)).status, 200);
    const filled = await alice(`/paper/${broker}/refresh`, {});
    assert.equal(filled.status, 200);
    assert.equal(filled.data.positions[paperInstrumentKey(order)].quantity, 25);
    const before = (await alice(`/paper/${broker}`)).data;
    const portfolio = await alice(`/portfolio/${broker}/refresh`, {});
    assert.equal(portfolio.status, 200);
    assert.equal(portfolio.data.positions.rows.length, 1);
    assert.equal(portfolio.data.holdings.rows.length, 1);
    assert.ok(!JSON.stringify(portfolio).includes("never-return"));
    assert.deepEqual((await alice(`/paper/${broker}`)).data, before);
    assert.equal((await bob(`/portfolio/${broker}/refresh`, {})).status, 409);
    assert.equal(
      (
        await alice(`/portfolio/${broker}/refresh`, {}, undefined, {
          "X-CSRF-Token": "",
        })
      ).status,
      403,
    );
  }
  assert.equal(realCalls, 0);
  assert.ok(
    iciciCalls.every((method) =>
      ["connect", "quotes", "positions", "holdings"].includes(method),
    ),
  );
  await alice("/auth/logout", {});
  assert.equal((await alice("/paper/kotak")).status, 401);
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
  ])
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
test("portfolio normalizers preserve signed exposure and reject incomplete books", async () => {
  assert.equal(
    normalizePortfolioRows("icici", "positions", [
      { stock_code: "TEST", quantity: "25", action: "sell" },
    ])[0].quantity,
    -25,
  );
  for (const raw of [
    null,
    {},
    [{ stock_code: "TEST" }],
    [{ stock_code: "TEST", quantity: "unknown" }],
  ])
    assert.throws(() => normalizePortfolioRows("icici", "positions", raw));
  assert.deepEqual(normalizePortfolioRows("icici", "holdings", []), []);
  const manager = new KotakDataManager(async (url, init) =>
    url.includes("tradeApi")
      ? fakeTransport()(url, init)
      : { stat: "Not_Ok", emsg: "secret", data: [] },
  );
  await manager.connect("a", "session", now + 60000, login);
  await assert.rejects(
    manager.portfolio("a", "session", "positions"),
    /unavailable/,
  );
  await assert.rejects(manager.portfolio("a", "wrong", "holdings"), /Connect/);
  manager.close();
});
test("ICICI portfolio SDK methods are read-only and redact failed or incomplete envelopes", async () => {
  let response = {
    Status: 200,
    Success: [{ stock_code: "TEST", quantity: 25, accountSecret: "hidden" }],
    Error: null,
  };
  const calls = [];
  class PortfolioSdk {
    async generateSession() {}
    async getPortfolioPositions() {
      calls.push("positions");
      return response;
    }
    async getDematHoldings() {
      calls.push("holdings");
      return response;
    }
  }
  const adapter = createBreezeData(
    { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
    PortfolioSdk,
  );
  await assert.rejects(adapter.portfolio("positions"), /Connect/);
  await adapter.connect();
  assert.equal((await adapter.portfolio("positions"))[0].quantity, 25);
  assert.ok(
    !JSON.stringify(await adapter.portfolio("holdings")).includes("hidden"),
  );
  for (const malformed of [
    { Status: 500, Error: "hidden" },
    { Status: 200, Success: null },
    { Success: [] },
    { Status: 200, Success: [{}] },
  ]) {
    response = malformed;
    await assert.rejects(adapter.portfolio("positions"), {
      message: "ICICI portfolio unavailable. Verify the connected account.",
    });
  }
  assert.deepEqual(calls.slice(0, 2), ["positions", "holdings"]);
  assert.equal("placeOrder" in adapter, false);
  adapter.disconnect();
});
