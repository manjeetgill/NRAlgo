import test from "node:test";
import assert from "node:assert/strict";
import { createKotakMarketDataProvider } from "../../dist/backend/kotak-market-data-provider.js";
import { selectMarketDataProvider } from "../../dist/backend/market-data-provider.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";
import { fakeKotakData } from "../fixtures/kotak-data.mjs";

test("provider selection is explicit without imposing another adapter's token namespace", () => {
  const provider = createKotakMarketDataProvider(fakeKotakData());
  assert.equal(selectMarketDataProvider("kotak", [provider]), provider);
  assert.throws(
    () => selectMarketDataProvider("unknown", [provider]),
    /Unsupported/,
  );
  const independent = { ...provider, id: "other" };
  assert.equal(selectMarketDataProvider("other", [independent]), independent);
  assert.equal("getPortfolioRows" in provider, false);
  assert.equal("getAccountReport" in provider, false);
  assert.equal("connect" in provider, false);
});

test("independent data adapter serves chain and ticks without a broker account; account stays disconnected", async (t) => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-09-18T06:00:00Z");
  t.after(() => {
    Date.now = realNow;
  });
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const brokerCalls = [];
  const broker = fakeKotakData(brokerCalls);
  const catalog = fakeInstrumentCatalog();
  await catalog.load(
    "kotak",
    "options",
    "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/transformed/nse_fo.csv",
  );
  const subscriptions = new Map();
  const provider = {
    ...createKotakMarketDataProvider(broker, catalog),
    id: "independent-test",
    capabilities: {
      live: true,
      historyIntervals: ["5minute"],
      requiresBrokerConnection: false,
    },
    isConnected: () => true,
    prepareInstruments: async () => {},
    getHistoricalCandlesForDay: async (
      _user,
      _session,
      _token,
      _segment,
      day,
    ) =>
      ["09:15", "09:20", "09:25"].map((time) => ({
        datetime: `${day}T${time}:00+05:30`,
        open: 42,
        high: 43,
        low: 41,
        close: 42,
      })),
    getQuoteSnapshots: async (_user, _session, tokens) =>
      tokens.map((instrument) => ({
        instrument,
        price: 42,
        bid: 41,
        ask: 43,
        openInterest: 10,
        volume: 20,
        observedAt: Date.now(),
        stale: false,
      })),
    startPriceFeed: (user, session, input) => {
      const snapshot = {
        state: "live",
        notifications: [],
        records: input.instruments.map((item) => ({
          ...item,
          type: "quote",
          ltp: 42,
          receivedAt: Date.now(),
          receivedRecently: true,
        })),
      };
      subscriptions.set(`${user}:${session}`, snapshot);
      return snapshot;
    },
    readPriceFeed: (user, session) =>
      subscriptions.get(`${user}:${session}`) || {
        state: "stopped",
        records: [],
        notifications: [],
      },
    disconnect: (user) => {
      for (const key of subscriptions.keys()) {
        if (key.startsWith(`${user}:`)) {
          subscriptions.delete(key);
        }
      }
    },
  };
  const app = createApiApplication(
    store,
    {
      BROKER_ENCRYPTION_KEY: "ab".repeat(32),
      MARKET_DATA_PROVIDER: provider.id,
    },
    broker,
    catalog,
    [provider],
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
  assert.equal((await alice("/market/provider")).status, 401);
  await alice("/auth/setup", {
    username: "provider-alice",
    password: "provider-test-password",
  });
  await bob("/auth/register", {
    username: "provider-bob",
    password: "provider-test-password",
  });
  assert.equal((await alice("/market/provider")).data.source, provider.id);
  const chain = await alice("/market/option-chain", {
    underlying: "TEST",
    expiryDate: "2026-09-24",
  });
  assert.equal(chain.status, 200);
  assert.equal(chain.data.source, provider.id);
  assert.equal(chain.data.items[0].price, 42);
  assert.equal(
    (await alice("/market/live-feed", { instruments: ["123"] })).status,
    200,
  );
  assert.equal((await alice("/market/feed")).data.records[0].ltp, 42);
  assert.deepEqual((await bob("/market/feed")).data.records, []);
  assert.equal((await alice("/paper/kotak/reports", {})).status, 409);
  assert.equal((await alice("/portfolio/kotak/refresh", {})).status, 409);
  const strategy = await alice("/research/strategies", {
    name: "Independent data replay",
    broker: "kotak",
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
    capital: 100000,
    marginReserve: 0,
    entryTime: "09:15",
    exitTime: "09:25",
    stopLoss: 1000,
    targetProfit: 1000,
    slippageBps: 0,
    feePerOrder: 0,
  });
  assert.equal(strategy.status, 201);
  const run = await alice("/research/backtest", {
    strategyId: strategy.data.id,
    day: "2026-09-17",
    interval: "5minute",
  });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.dataSource, provider.id);
  const unsupported = await alice("/research/backtest", {
    strategyId: strategy.data.id,
    day: "2026-09-17",
    interval: "1minute",
  });
  assert.equal(unsupported.status, 422);
  assert.equal(brokerCalls.length, 0);
  await alice("/auth/logout", {});
  assert.equal(subscriptions.size, 0);
});
