/** Offline Kotak-only integration with no credentials or live execution. */
import test from "node:test";
import assert from "node:assert/strict";
import { KotakMarketDataClient } from "../../dist/backend/kotak-market-data-client.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";
const login = {
  accessToken: "fake-kotak-token",
  mobileNumber: "+919999999999",
  ucc: "FAKE",
  totp: "123456",
  mpin: "123456",
};
const definition = {
  broker: "kotak",
  name: "Kotak research test",
  market: "cash",
  legs: [{ stockCode: "TEST", side: "buy", quantity: 1 }],
  capital: 10000,
  marginReserve: 0,
  entryTime: "09:20",
  exitTime: "09:30",
  stopLoss: 1000,
  targetProfit: 1000,
  slippageBps: 0,
  feePerOrder: 1,
};
test("Kotak-only discovery, quotes, replay and account reports", async (t) => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-09-18T05:00:00Z");
  t.after(() => {
    Date.now = originalNow;
  });
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const calls = [];
  const kotak = new KotakMarketDataClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("tradeApiLogin")) {
      return {
        data: { status: "success", kType: "View", token: "view", sid: "sid" },
      };
    }
    if (url.endsWith("tradeApiValidate")) {
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "trade",
          sid: "sid",
          baseUrl: "https://e43.kotaksecurities.com",
        },
      };
    }
    assert.ok(url.startsWith("https://e43.kotaksecurities.com/"));
    if (url.endsWith("masterscrip/file-paths")) {
      return {
        data: {
          filesPaths: [
            "transformed-v1/nse_cm-v1.csv",
            "transformed/nse_fo.csv",
          ].map(
            (path) =>
              `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/${path}`,
          ),
        },
      };
    }
    if (url.includes("/quotes/")) {
      return decodeURIComponent(url.split("/neosymbol/")[1].split("/all")[0])
        .split(",")
        .map((pair) => {
          const [exchange, exchange_token] = pair.split("|");
          return {
            exchange,
            exchange_token,
            ltp: "101",
            open_int: "20",
            last_volume: "50",
            lstup_time: String(Date.now() / 1000),
            depth: { buy: [{ price: "100" }], sell: [{ price: "102" }] },
          };
        });
    }
    if (url.includes("/historical/details?")) {
      const params = new URL(url).searchParams,
        day = params.get("fromdate");
      assert.equal(params.get("interval"), "5min");
      assert.equal(day, params.get("todate"));
      return {
        status: "success",
        interval: "5min",
        data: {
          candles: [15, 20, 25, 30].map((minute, i) => [
            `${day}T09:${minute}:00+0530`,
            100 + i,
            104 + i,
            99 + i,
            102 + i,
            10,
            null,
          ]),
        },
      };
    }
    if (url.endsWith("/limits")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(
        JSON.parse(new URLSearchParams(init.body).get("jData")),
        { seg: "ALL", exch: "ALL", prod: "ALL" },
      );
      return {
        stat: "Ok",
        stCode: 200,
        Net: "12345",
        MarginUsed: "20",
        token: "DO_NOT_LEAK",
      };
    }
    if (url.endsWith("/orders") || url.endsWith("/trades")) {
      return {
        stat: "Ok",
        stCode: 200,
        data: [
          {
            nOrdNo: "123",
            trdSym: "TEST-EQ",
            qty: 2,
            fldQty: 1,
            prc: "100",
            avgPrc: "101",
            usrId: "DO_NOT_LEAK",
          },
        ],
      };
    }
    throw new Error("Unexpected endpoint");
  });
  const app = createApiApplication(
    store,
    { BROKER_ENCRYPTION_KEY: "ab".repeat(32) },
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
    return async (path, body) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie,
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      if (response.headers.get("set-cookie")) {
        cookie = response.headers.get("set-cookie").split(";")[0];
      }
      const data = await response.json();
      if (data.csrf) {
        csrf = data.csrf;
      }
      return { status: response.status, data };
    };
  }
  const alice = client(),
    bob = client();
  await alice("/auth/setup", {
    username: "kotak-alice",
    password: "kotak-password-long",
  });
  await bob("/auth/register", {
    username: "kotak-bob",
    password: "kotak-password-long",
  });
  assert.equal((await alice("/paper/kotak/connect", login)).status, 200);
  const symbols = await alice("/paper/kotak/instruments", {
    market: "cash",
    query: "",
    offset: 0,
  });
  assert.equal(symbols.status, 200, JSON.stringify(symbols.data));
  assert.equal(symbols.data.items[0].symbol, "TEST");
  assert.equal(symbols.data.items[0].instrument, "123");
  assert.equal(
    (await bob("/paper/kotak/instruments", { market: "cash", query: "" }))
      .status,
    409,
  );
  assert.equal(
    (await alice("/paper/kotak/instruments", { market: "options", query: "" }))
      .status,
    422,
  );
  assert.equal(
    (await bob("/paper/kotak/option-chain", { underlying: "TEST" })).status,
    409,
  );
  const metadata = await alice("/paper/kotak/option-chain", {
    underlying: "TEST",
  });
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.data.expiries, ["2026-09-24"]);
  const chain = await alice("/paper/kotak/option-chain", {
    underlying: "TEST",
    expiryDate: "2026-09-24",
  });
  assert.equal(chain.status, 200);
  assert.equal(chain.data.items.length, 2);
  assert.equal(chain.data.items[0].price, 101);
  const saved = await alice("/research/strategies", definition);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const strategyId = saved.data.id;
  assert.equal((await bob("/research/quotes", { strategyId })).status, 404);
  const quotes = await alice("/research/quotes", { strategyId });
  assert.equal(quotes.status, 200, JSON.stringify(quotes.data));
  assert.equal(quotes.data.source, "kotak");
  const replay = await alice("/research/backtest", {
    strategyId,
    day: "2026-09-17",
    interval: "5minute",
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.strategy.broker, "kotak");
  const batch = await alice("/research/backtest/batch", {
    strategyId,
    days: ["2026-09-16", "2026-09-17"],
    interval: "5minute",
  });
  assert.equal(batch.status, 200, JSON.stringify(batch.data));
  assert.equal(batch.data.summary.sessionsRun, 2);
  const optionSaved = await alice("/research/strategies", {
    ...definition,
    market: "options",
    legs: [
      {
        stockCode: "TEST",
        side: "buy",
        quantity: 25,
        expiryDate: "2026-09-24",
        right: "call",
        strikePrice: 25000,
      },
    ],
  });
  assert.equal(optionSaved.status, 201);
  const optionQuotes = await alice("/research/quotes", {
    strategyId: optionSaved.data.id,
  });
  assert.equal(optionQuotes.status, 200, JSON.stringify(optionQuotes.data));
  assert.equal(optionQuotes.data.source, "kotak");
  const optionHistory = await alice("/research/backtest", {
    strategyId: optionSaved.data.id,
    day: "2026-09-17",
    interval: "5minute",
  });
  assert.equal(optionHistory.status, 200, JSON.stringify(optionHistory.data));
  assert.equal((await bob("/paper/kotak/reports", {})).status, 409);
  assert.equal((await alice("/research/stream", { strategyId })).status, 404);
  const reports = await alice("/paper/kotak/reports", {});
  assert.equal(reports.status, 200);
  assert.equal(reports.data.limits.rows[0].available, 12345);
  assert.ok(!JSON.stringify(reports).includes("DO_NOT_LEAK"));
  assert.equal(calls.filter((call) => call.url.includes("/quotes/")).length, 3);
  assert.ok(
    calls.every(
      (call) => !/\/order\/|\/place|\/cancel|\/modify/.test(call.url),
    ),
  );
});
