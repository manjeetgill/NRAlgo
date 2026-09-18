/** Offline history integration: authenticates real app sessions but never calls a broker network/order API. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  historicalRequestSchema,
  validateHistoricalCandles,
} from "../../dist/backend/historical-market-data.js";
import { createKotakMarketDataProvider } from "../../dist/backend/kotak-market-data-provider.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { BrokerRequestCoordinator } from "../../dist/backend/broker-data-access.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { fakeInstrumentCatalog } from "../fixtures/instruments.mjs";
import { fakeKotakData } from "../fixtures/kotak-data.mjs";

const request = {
  market: "cash",
  stockCode: "TEST",
  instrument: "123",
  from: "2026-09-01",
  to: "2026-09-02",
  interval: "day",
};
const candle = {
  timestamp: "2026-09-01T03:45:00Z",
  open: 100,
  high: 105,
  low: 98,
  close: 102,
  volume: null,
  openInterest: null,
};

test("history accepts only bounded exact contract queries and completed daily ranges", () => {
  assert.ok(historicalRequestSchema.safeParse(request).success);
  for (const patch of [
    { from: "2026-02-30" },
    { from: "2025-01-01" },
    { to: "2099-01-01" },
    { instrument: "../orders" },
    { interval: "csv" },
    { market: "options" },
    { candles: [candle] },
    { from: "2026-09-03" },
  ]) {
    assert.equal(
      historicalRequestSchema.safeParse({ ...request, ...patch }).success,
      false,
    );
  }
  assert.equal(
    historicalRequestSchema.safeParse({
      ...request,
      to: new Date(Date.now() + 19800000).toISOString().slice(0, 10),
    }).success,
    false,
  );
  assert.equal(
    historicalRequestSchema.safeParse({
      ...request,
      interval: "1minute",
      from: "2026-07-01",
    }).success,
    false,
  );
});

test("history rejects duplicate sessions, reordered/invalid prices, future and out-of-range rows", () => {
  assert.deepEqual(validateHistoricalCandles(request, [candle]), [candle]);
  for (const rows of [
    [candle, candle],
    [{ ...candle, high: 99 }],
    [{ ...candle, low: 103 }],
    [{ ...candle, open: NaN }],
    [{ ...candle, timestamp: "2026-08-31T03:45:00Z" }],
    [candle, { ...candle, timestamp: "2026-09-01T03:46:00Z" }],
  ]) {
    assert.throws(() => validateHistoricalCandles(request, rows));
  }
});

test("intraday history requires canonical interval buckets without rejecting genuine gaps", () => {
  const intraday = {
    ...request,
    interval: "5minute",
    from: "2026-09-01",
    to: "2026-09-01",
  };
  const first = { ...candle, timestamp: "2026-09-01T03:45:00Z" };
  const gap = { ...candle, timestamp: "2026-09-01T03:55:00Z" };
  assert.deepEqual(validateHistoricalCandles(intraday, [first, gap]), [
    first,
    gap,
  ]);
  for (const timestamp of ["2026-09-01T03:46:00Z", "2026-09-01T03:45:30Z"]) {
    assert.throws(() =>
      validateHistoricalCandles(intraday, [first, { ...candle, timestamp }]),
    );
  }
});

test("Kotak adapter maps daily/intraday history and normalizes documented +0530 timestamps", async () => {
  const calls = [];
  const adapter = createKotakMarketDataProvider({
    fetchMarketData: async (...args) => {
      calls.push(args);
      return {
        candles: [{ ...candle, timestamp: "2026-09-01T09:15:00+0530" }],
      };
    },
  });
  for (const [interval, expected] of [
    ["day", "D"],
    ["1minute", "1min"],
    ["5minute", "5min"],
  ]) {
    const signal = new AbortController().signal;
    const result = await adapter.getHistoricalCandles(
      "owner",
      "session",
      { ...request, interval },
      signal,
    );
    assert.equal(result[0].timestamp, "2026-09-01T03:45:00.000Z");
    assert.equal(calls.at(-1)[2].interval, expected);
    assert.equal(calls.at(-1)[2].exchange, "nse_cm");
    assert.deepEqual(calls.at(-1).slice(0, 2), ["owner", "session"]);
    assert.equal(calls.at(-1)[3], signal);
  }
});

test("cancellable history waits for an active broker read and removes abandoned waiters", async () => {
  const coordinator = new BrokerRequestCoordinator();
  let release;
  const active = coordinator.runExclusiveForUser(
    "owner",
    () => new Promise((resolve) => (release = resolve)),
  );
  const cancelled = new AbortController();
  const abandoned = coordinator.runQueuedForUser(
    "owner",
    cancelled.signal,
    async () => "must-not-run",
  );
  cancelled.abort(new DOMException("Changed selection", "AbortError"));
  await assert.rejects(abandoned, /Changed selection/);
  let ran = false;
  const latest = coordinator.runQueuedForUser(
    "owner",
    new AbortController().signal,
    async () => {
      ran = true;
      return "latest";
    },
  );
  assert.equal(ran, false);
  release();
  await active;
  assert.equal(await latest, "latest");
  assert.equal(ran, true);
});

test("history route enforces auth, CSRF, session ownership, exact master, capabilities and valid nonempty provider data", async (t) => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-09-18T06:00:00Z");
  t.after(() => {
    Date.now = realNow;
  });
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const brokerCalls = [],
    historyCalls = [];
  const broker = fakeKotakData(brokerCalls),
    catalog = fakeInstrumentCatalog();
  await catalog.load(
    "kotak",
    "cash",
    "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/transformed-v1/nse_cm-v1.csv",
  );
  const connection = { owner: "" };
  let rows = [candle];
  const provider = {
    ...createKotakMarketDataProvider(broker, catalog),
    id: "history-fixture",
    isConnected: (user) => user === connection.owner,
    prepareInstruments: async () => {},
    getHistoricalCandles: async (...args) => {
      historyCalls.push(args);
      return rows;
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
  /** Independent cookie jars exercise authenticated owner scope, not a shared mock user. */
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, body, withCsrf = true) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie,
            "Content-Type": "application/json",
            ...(withCsrf ? { "X-CSRF-Token": csrf } : {}),
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
  assert.equal((await alice("/market/history", request)).status, 401);
  await alice("/auth/setup", {
    username: "history-alice",
    password: "test-history-password",
  });
  await bob("/auth/register", {
    username: "history-bob",
    password: "test-history-password",
  });
  const [owner] = await store.transaction((query) =>
    query("SELECT id FROM users WHERE username=$1", ["history-alice"]),
  );
  connection.owner = owner.id;
  assert.equal((await alice("/market/history", request, false)).status, 403);
  assert.equal((await bob("/market/history", request)).status, 409);
  assert.equal(
    (await alice("/market/history", { ...request, instrument: "999" })).status,
    422,
  );
  assert.equal(historyCalls.length, 0);
  const result = await alice("/market/history", request);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.source, "history-fixture");
  assert.equal(result.data.instrument.instrument, "123");
  assert.deepEqual(result.data.candles, [candle]);
  assert.equal(historyCalls[0][0], connection.owner);
  rows = [];
  assert.equal((await alice("/market/history", request)).status, 422);
  rows = [{ ...candle, high: 1 }];
  assert.equal((await alice("/market/history", request)).status, 502);
  provider.capabilities.historyIntervals = ["5minute"];
  assert.equal((await alice("/market/history", request)).status, 422);
  assert.equal(brokerCalls.length, 0);
});
