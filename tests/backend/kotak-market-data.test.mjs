/** Offline coverage of every documented market-data family. No real broker or credentials. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  marketRequestSchema,
  buildKotakMarketDataPath,
  parseKotakMarketDataResponse,
  historyIntervals,
  quoteFilters,
} from "../../dist/backend/kotak-market-data-contracts.js";
import {
  decodeKotakBinaryFrame,
  KotakMarketDataStream,
  feedRequestSchema,
} from "../../dist/backend/kotak-market-data-stream.js";
import {
  KotakMarketDataClient,
  validateKotakFeedUrl,
} from "../../dist/backend/kotak-market-data-client.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { fakeKotakLogin } from "../fixtures/kotak-data.mjs";

const history = {
  operation: "history",
  exchange: "nse_cm",
  instrument: "123",
  from: "2026-09-01",
  to: "2026-09-02",
  interval: "5min",
};
const chainInput = {
  operation: "chain",
  exchange: "nse_fo",
  underlying: "NIFTY",
  instrumentType: "option",
  count: 40,
};
const feedInput = {
  kind: "mini",
  mode: "subscribe",
  instruments: [{ exchange: "nse_cm", instrument: "11536" }],
};
/** Minimal strict socket double; events are delivered without timers or any network connection. */
class FakeSocket extends EventTarget {
  sent = [];
  closed = false;
  binaryType = "";
  send(value) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  message(data) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data:
          typeof data === "object" && !(data instanceof ArrayBuffer)
            ? JSON.stringify(data)
            : data,
      }),
    );
  }
}
/** Build bounded protocol fixtures with a full nine-byte header. */
function packet(size, code = 7208, level = 1, exchange = 1) {
  const bytes = Buffer.alloc(size);
  bytes.writeUInt16LE(size);
  bytes.writeUInt16LE(code, 2);
  bytes[4] = exchange;
  bytes[5] = level;
  return bytes;
}
/** Login stub routes all future reads through a caller-owned fake handler. */
function managerFor(
  read,
  socketFactory,
  feedUrl = "https://e43.kotaksecurities.com/apifeed",
) {
  return new KotakMarketDataClient(async (url, init, maxBytes) => {
    if (url.endsWith("tradeApiLogin")) {
      return {
        data: {
          status: "success",
          kType: "View",
          token: "view-secret",
          sid: "view-sid",
        },
      };
    }
    if (url.endsWith("tradeApiValidate")) {
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "trade-secret",
          sid: "feed-secret",
          baseUrl: "https://e43.kotaksecurities.com",
          feedUrl,
        },
      };
    }
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, fakeKotakLogin.accessToken);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(new URL(url).origin, "https://e43.kotaksecurities.com");
    return read(new URL(url), maxBytes);
  }, socketFactory);
}

test("market queries cover all filters/intervals and reject unsafe or excessive requests", () => {
  for (const filter of quoteFilters) {
    const input = marketRequestSchema.parse({
      operation: "quotes",
      filter,
      instruments: [
        { exchange: "nse_cm", instrument: "Nifty 50" },
        { exchange: "bse_cm", instrument: "SENSEX" },
      ],
    });
    assert.match(
      buildKotakMarketDataPath(input),
      new RegExp(`/N?[^/]+/${filter}$`),
    );
    assert.ok(
      buildKotakMarketDataPath(input).includes("Nifty%2050%2Cbse_cm%7CSENSEX"),
    );
  }
  for (const interval of historyIntervals) {
    assert.ok(marketRequestSchema.safeParse({ ...history, interval }).success);
  }
  for (const bad of [
    { ...history, to: "2026-10-20" },
    { ...history, from: "2026-09-03" },
    { ...history, exchange: "cde_fo" },
    { ...history, instrument: "123/../../orders" },
    { ...history, from: "2026-02-30" },
    { ...chainInput, count: 15 },
    { ...chainInput, count: 110 },
    { ...chainInput, url: "https://evil.example" },
    {
      operation: "quotes",
      instruments: Array(51).fill({ exchange: "nse_cm", instrument: "1" }),
    },
    {
      operation: "quotes",
      instruments: [{ exchange: "nse_fo", instrument: "NIFTY" }],
    },
  ]) {
    assert.equal(marketRequestSchema.safeParse(bad).success, false);
  }
});

test("all seven master file types are returned without arbitrary URLs or duplicates", () => {
  const paths = [
    "transformed-v1/nse_cm-v1.csv",
    "transformed-v1/bse_cm-v1.csv",
    ...["nse_fo", "bse_fo", "cde_fo", "mcx_fo", "nse_com"].map(
      (exchange) => `transformed/${exchange}.csv`,
    ),
  ];
  const urls = paths.map(
    (path) =>
      `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-09-18/${path}`,
  );
  const normalize = (filesPaths) =>
    parseKotakMarketDataResponse(
      { operation: "instruments" },
      { data: { filesPaths, token: "secret" } },
    );
  assert.equal(normalize(urls).files.length, 7);
  assert.throws(() => normalize([...urls, urls[0]]));
  assert.throws(() => normalize([urls[0] + "?secret=x"]));
  assert.throws(() =>
    normalize([urls[0].replace("lapi.kotaksecurities.com", "evil.example")]),
  );
});

test("quote identity, stale status, nulls, depth and response-field stripping", () => {
  const input = marketRequestSchema.parse({
    operation: "quotes",
    instruments: [
      { exchange: "bse_cm", instrument: "SENSEX" },
      { exchange: "nse_cm", instrument: "123" },
    ],
  });
  const row = {
    exchange: "bse_cm",
    exchange_token: "SENSEX",
    ltp: "80000.1",
    change: "-2.5",
    token: "SECRET",
    lstup_time: "1",
    depth: {
      buy: [{ price: "80000", quantity: "2", orders: "1", sid: "SECRET" }],
      sell: [],
    },
  };
  const result = parseKotakMarketDataResponse(input, [row]);
  assert.equal(result.quotes[0].stale, true);
  assert.equal(result.quotes[0].ltp, 80000.1);
  assert.equal(result.quotes[0].open_int, null);
  assert.deepEqual(result.missing, ["nse_cm|123"]);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.throws(() => parseKotakMarketDataResponse(input, [row, row]));
  assert.throws(() =>
    parseKotakMarketDataResponse(input, [{ ...row, exchange: "nse_cm" }]),
  );
  assert.throws(() =>
    parseKotakMarketDataResponse(input, { stat: "Not_Ok", emsg: "secret" }),
  );
});

test("expiry and native options/futures chain contracts preserve identity and indicative pricing", () => {
  const expiry = {
    operation: "expiries",
    exchange: "nse_fo",
    underlying: "NIFTY",
    instrumentType: "option",
  };
  assert.deepEqual(
    parseKotakMarketDataResponse(expiry, {
      exchange: "nse_fo",
      underlying: "NIFTY",
      expiries: ["2026-09-24", "2026-09-22"],
    }).expiries,
    ["2026-09-22", "2026-09-24"],
  );
  assert.throws(() =>
    parseKotakMarketDataResponse(expiry, {
      exchange: "bse_fo",
      underlying: "NIFTY",
      expiries: [],
    }),
  );
  const common = {
    mktLot: "65",
    multiplier: "1",
    unlSymbol: "NIFTY",
    exSeg: "nse_fo",
    expiryDt: "2026-09-22",
  };
  const row = {
    instrument: {
      neoSymbol: "nse_fo|123",
      symbol: "NIFTY-CE",
      optionType: "CE",
      strikePrice: "25000",
    },
    quote: { ltp: "100", close: null },
    openInterest: { current: 10, previous: 20, change: -10, changePct: -50 },
  };
  const raw = { data: { common_data: common, call: [row], put: [] } };
  const result = parseKotakMarketDataResponse(chainInput, raw);
  assert.equal(result.indicative, true);
  assert.equal(result.observedAt, null);
  assert.equal(result.call[0].openInterest.change, -10);
  assert.throws(() =>
    parseKotakMarketDataResponse({ ...chainInput, expiry: "2026-09-24" }, raw),
  );
  assert.throws(() =>
    parseKotakMarketDataResponse(chainInput, {
      data: { ...raw.data, put: [row] },
    }),
  );
  const fut = {
    data: {
      common_data: { ...common, expiryDt: null },
      call: [],
      put: [],
      fut: [
        {
          inst: {
            neoSymbol: "nse_fo|124",
            symbol: "NIFTY26SEPFUT",
            expiryDt: "24-SEP-2026",
          },
          quote: { ltp: "25000", o: "24900" },
          oi: { cur: 40, chg: -1 },
        },
      ],
    },
  };
  assert.equal(
    parseKotakMarketDataResponse({ ...chainInput, instrumentType: "fut" }, fut)
      .fut[0].quote.ltp,
    25000,
  );
  assert.match(buildKotakMarketDataPath(expiry), /instrument_type=option/);
  assert.match(buildKotakMarketDataPath(chainInput), /option-chain.*count=40/);
});

test("history preserves volume/OI and rejects untrusted ranges, prices and order", () => {
  const candle = [
    "2026-09-01T09:15:00+0530",
    "100",
    "105",
    "99",
    "102",
    10,
    null,
  ];
  for (const interval of historyIntervals) {
    const result = parseKotakMarketDataResponse(
      { ...history, interval },
      { status: "success", interval, data: { candles: [candle] } },
    );
    assert.equal(result.candles[0].volume, 10);
    assert.equal(result.candles[0].openInterest, null);
  }
  assert.equal(
    parseKotakMarketDataResponse(history, {
      status: "success",
      interval: "5min",
      data: { candles: [candle.slice(0, 6)] },
    }).candles[0].openInterest,
    null,
  );
  for (const candles of [
    [candle, candle],
    [[...candle.slice(0, 2), 98, ...candle.slice(3)]],
    [["2026-08-31T09:15:00+0530", ...candle.slice(1)]],
  ]) {
    assert.throws(() =>
      parseKotakMarketDataResponse(history, {
        status: "success",
        interval: "5min",
        data: { candles },
      }),
    );
  }
  assert.throws(() =>
    parseKotakMarketDataResponse(history, {
      status: "ERROR",
      fault: { code: 400 },
    }),
  );
});

test("native decoder matches published mini fixture, divider rules and int64 precision", () => {
  const bytes = Buffer.from(
    "3600281c0101000700102d00008026b4680000000040e20100320000000000000090dc010077000000b0050000010000000201000000",
    "hex",
  );
  const [row] = decodeKotakBinaryFrame(bytes).records;
  assert.equal(row.instrument, "11536");
  assert.equal(row.ltp, 1234.56);
  assert.equal(row.closeRaw, 122000);
  assert.equal(row.percentChange, 1.19);
  assert.equal(row.change, 14.56);
  bytes.writeBigInt64LE(9007199254740993n, 25);
  bytes[4] = 3;
  assert.equal(
    decodeKotakBinaryFrame(bytes, { cde_fo: 10000000 }).records[0].lastQuantity,
    "9007199254740993",
  );
  assert.equal(
    decodeKotakBinaryFrame(bytes, { cde_fo: 10000000 }).records[0].ltp,
    0.0123456,
  );
});

test("native decoder handles full/depth/index/status/CAS and truncated tails", () => {
  const full = packet(176, 7208, 4);
  full.writeUInt32LE(123, 9);
  full.writeUInt32LE(10100, 69);
  full.writeUInt32LE(500, 89);
  full.writeUInt32LE(999, 93);
  full.writeInt32LE(10000, 152);
  full.writeInt32LE(10200, 168);
  const index = packet(87, 7207);
  index.writeInt32LE(20000, 29);
  index.writeInt32LE(19500, 17);
  index.write("Nifty 50", 66);
  const status = packet(16, 105);
  status.writeUInt16LE(1, 9);
  status.write("OPEN", 11);
  const cas = packet(48, 104);
  cas.writeInt32LE(123, 9);
  const decoded = decodeKotakBinaryFrame(
    Buffer.concat([full, index, status, cas, Buffer.from([54, 0])]),
  );
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.records.length, 4);
  assert.equal(decoded.records[0].depth.buy[0].price, 100);
  assert.equal(decoded.records[0].depth.sell[0].price, 102);
  assert.equal(decoded.records[1].change, 5);
  assert.equal(decoded.records[2].status, "OPEN");
  assert.equal(decoded.records[3].referencePriceRaw, 0);
  const partial = packet(160, 7208, 8);
  partial.writeUInt32LE(2, 89);
  partial.writeUInt32LE(1, 93);
  assert.equal(decodeKotakBinaryFrame(partial).records[0].partialDepth, true);
  assert.equal(decodeKotakBinaryFrame(partial).records[0].depth.sell.length, 0);
  assert.throws(() => decodeKotakBinaryFrame(Buffer.alloc(9)));
  const masked = packet(54);
  masked[8] = 1;
  assert.throws(() => decodeKotakBinaryFrame(masked));
  assert.throws(() => decodeKotakBinaryFrame(packet(10)));
});

test("feed auth, controls, session revoke and sanitized cache use no REST or order calls", () => {
  const socket = new FakeSocket();
  let valid = true;
  const feed = new KotakMarketDataStream(
    "wss://e43.kotaksecurities.com/apifeed",
    "fake-ucc",
    "private-sid",
    feedInput,
    () => valid,
    () => socket,
  );
  try {
    socket.dispatchEvent(new Event("open"));
    assert.equal(socket.sent[0].auth, "private-sid");
    socket.message({
      message_code: 1119,
      exchanges: {},
    });
    assert.equal(socket.sent.length, 2);
    socket.message({
      message_code: 1117,
      format: "native_batch",
      exchanges: { nse_cm: { divider: 100 } },
    });
    assert.equal(socket.sent[1].event, "subscribeScripsLite");
    socket.message({
      message_code: 1109,
      trading_symbols: { "nse_cm|11536": "TEST" },
    });
    assert.equal(socket.closed, false);
    const marketOpen = packet(9, 6511, 4);
    socket.message(Uint8Array.from(marketOpen).buffer);
    assert.equal(socket.closed, false);
    const bytes = packet(54);
    bytes.writeUInt32LE(11536, 9);
    bytes.writeUInt32LE(12300, 21);
    socket.message(Uint8Array.from(bytes).buffer);
    assert.equal(feed.getLatestSnapshot().records[0].ltp, 123);
    assert.equal(feed.getLatestSnapshot().records[0].freshnessVerified, false);
    assert.ok(
      !JSON.stringify(feed.getLatestSnapshot()).includes("private-sid"),
    );
    feed.sendSubscriptionCommand("unsubscribe");
    socket.message(Uint8Array.from(bytes).buffer);
    assert.equal(feed.getLatestSnapshot().records.length, 0);
    feed.sendSubscriptionCommand("snapshot");
    assert.equal(socket.sent.at(-1).event, "snapshotScripsLite");
    valid = false;
    assert.equal(feed.getLatestSnapshot().state, "session-expired");
    assert.equal(socket.closed, true);
  } finally {
    feed.closeConnection();
  }
});

test("feed rejects fallback/auth failure, validates targets, and never leaks raw diagnostics", () => {
  for (const message of [
    { message_code: 1120, message: "private-sid" },
    { message_code: 1117, format: "native_fallback", exchanges: {} },
  ]) {
    const socket = new FakeSocket(),
      feed = new KotakMarketDataStream(
        "wss://e43.kotaksecurities.com/apifeed",
        "u",
        "private-sid",
        feedInput,
        () => true,
        () => socket,
      );
    socket.message(message);
    assert.equal(socket.closed, true);
    assert.ok(
      !JSON.stringify(feed.getLatestSnapshot()).includes("private-sid"),
    );
    feed.closeConnection();
  }
  for (const url of [
    "https://evil.example/apifeed",
    "https://e43.kotaksecurities.com/apifeed?sid=x",
    "https://e43.kotaksecurities.com:443/apifeed",
    "https://e43.kotaksecurities.com/../apifeed",
  ]) {
    assert.throws(() => validateKotakFeedUrl(url));
  }
  assert.equal(
    validateKotakFeedUrl(undefined),
    "wss://sfeed.kotaksecurities.com/apifeed",
  );
  assert.equal(
    validateKotakFeedUrl("wss://sfeed.kotaksecurities.com/apifeed"),
    "wss://sfeed.kotaksecurities.com/apifeed",
  );
  assert.equal(
    validateKotakFeedUrl("https://e43.kotaksecurities.com/apifeed"),
    "wss://e43.kotaksecurities.com/apifeed",
  );
  assert.equal(
    feedRequestSchema.safeParse({
      ...feedInput,
      instruments: [...feedInput.instruments, ...feedInput.instruments],
    }).success,
    false,
  );
});

test("reopening the same touchline feed does not disconnect shared viewers", async () => {
  let sockets = 0;
  const manager = managerFor(
    () => ({}),
    () => {
      sockets++;
      return new FakeSocket();
    },
  );
  await manager.connect("u", "s", Date.now() + 60000, fakeKotakLogin);
  const request = { ...feedInput, kind: "touchline" };
  manager.startMarketDataStream("u", "s", request);
  manager.startMarketDataStream("u", "s", request);
  assert.equal(sockets, 1);
  manager.close();
});
test("manager session fences discard delayed data and close feeds on logout/reconnect", async () => {
  let resolveRead;
  const socket = new FakeSocket();
  const manager = managerFor(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    () => socket,
  );
  await manager.connect("u", "s", Date.now() + 60000, fakeKotakLogin);
  assert.throws(() => manager.startMarketDataStream("u", "other", feedInput));
  manager.startMarketDataStream("u", "s", feedInput);
  const pending = manager.fetchMarketData("u", "s", history);
  manager.disconnect("u");
  resolveRead({ status: "success", interval: "5min", data: { candles: [] } });
  await assert.rejects(pending);
  assert.equal(socket.closed, true);
  manager.close();
});

test("every feed level exposes the documented subscribe/unsubscribe/snapshot event names", () => {
  for (const [kind, suffix] of Object.entries({
    mini: "ScripsLite",
    touchline: "Scrips",
    depth: "Depth",
    indices: "Indices",
  })) {
    const socket = new FakeSocket(),
      feed = new KotakMarketDataStream(
        "wss://e43.kotaksecurities.com/apifeed",
        "u",
        "s",
        { ...feedInput, kind, mode: "snapshot" },
        () => true,
        () => socket,
      );
    try {
      socket.message({
        message_code: 1117,
        format: "native_batch",
        exchanges: {},
      });
      assert.equal(socket.sent[0].event, `snapshot${suffix}`);
      feed.sendSubscriptionCommand("subscribe");
      feed.sendSubscriptionCommand("unsubscribe");
      assert.deepEqual(
        socket.sent.map((row) => row.event),
        [`snapshot${suffix}`, `subscribe${suffix}`, `unsubscribe${suffix}`],
      );
      socket.message({
        message_code: 1109,
        error_code: 99,
        message: "PRIVATE-SID",
      });
      assert.equal(socket.closed, true);
      assert.ok(
        !JSON.stringify(feed.getLatestSnapshot()).includes("PRIVATE-SID"),
      );
    } finally {
      feed.closeConnection();
    }
  }
});

test("feeds release on viewer lease expiry and authentication deadline", (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setInterval"],
    now: Date.parse("2026-09-18T05:00:00Z"),
  });
  const socket = new FakeSocket(),
    feed = new KotakMarketDataStream(
      "wss://e43.kotaksecurities.com/apifeed",
      "u",
      "s",
      feedInput,
      () => true,
      () => socket,
    );
  socket.message({ message_code: 1117, format: "native_batch", exchanges: {} });
  t.mock.timers.tick(50000);
  assert.equal(socket.closed, true);
  assert.equal(feed.getLatestSnapshot().state, "stopped");
  feed.closeConnection();
  const pending = new FakeSocket(),
    unauthenticated = new KotakMarketDataStream(
      "wss://e43.kotaksecurities.com/apifeed",
      "u",
      "s",
      feedInput,
      () => true,
      () => pending,
    );
  t.mock.timers.tick(15000);
  assert.equal(pending.closed, true);
  assert.equal(unauthenticated.getLatestSnapshot().state, "error");
  unauthenticated.closeConnection();
});

test("market diagnostics preserve bounded broker errors while stripping all session secrets", async () => {
  const manager = managerFor(() => ({
    status: "ERROR",
    fault: {
      code: 400,
      message: `Unsupported interval ${fakeKotakLogin.accessToken} feed-secret trade-secret`,
    },
  }));
  await manager.connect("u", "s", Date.now() + 60000, fakeKotakLogin);
  await assert.rejects(manager.fetchMarketData("u", "s", history), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.detail, /Unsupported interval/);
    for (const secret of [
      fakeKotakLogin.accessToken,
      "feed-secret",
      "trade-secret",
    ]) {
      assert.ok(!error.detail.includes(secret));
    }
    return true;
  });
  manager.close();
});

test("a delayed quote failure cannot disconnect a replacement Kotak login", async () => {
  let rejectRead;
  const manager = managerFor(
    () =>
      new Promise((resolve, reject) => {
        rejectRead = reject;
      }),
  );
  await manager.connect("u", "old", Date.now() + 60000, fakeKotakLogin);
  const pending = manager.getPaperFillQuote("u", "old", "123");
  await manager.connect("u", "new", Date.now() + 60000, fakeKotakLogin);
  rejectRead(new Error("Old connection failed."));
  await assert.rejects(pending);
  assert.equal(manager.isConnected("u", "new"), true);
  manager.close();
});

test("market routes enforce login, CSRF, owner isolation and shared budget", async (t) => {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  let reads = 0;
  const manager = managerFor((url, maxBytes) => {
    reads++;
    assert.equal(url.pathname, "/market-data/1.0/historical/details");
    assert.equal(maxBytes, 4194304);
    return {
      status: "success",
      interval: "5min",
      data: { candles: [] },
      token: "SECRET",
    };
  });
  const app = createApiApplication(
    store,
    { BROKER_ENCRYPTION_KEY: "ab".repeat(32) },
    manager,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  /** Each test browser owns independent cookies and CSRF; tokens are never shared. */
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, body, validCsrf = true) => {
      const response = await fetch(origin + "/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": validCsrf ? csrf : "invalid",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
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
  assert.equal((await alice("/market/kotak/read", history)).status, 401);
  await alice("/auth/setup", {
    username: "market-alice",
    password: "long-market-password",
  });
  await bob("/auth/register", {
    username: "market-bob",
    password: "long-market-password",
  });
  assert.equal(
    (await alice("/paper/kotak/connect", fakeKotakLogin)).status,
    200,
  );
  assert.equal((await alice("/market/kotak/read", history, false)).status, 403);
  assert.equal((await bob("/market/kotak/read", history)).status, 409);
  assert.equal((await bob("/market/kotak/feed")).status, 409);
  assert.equal(
    (await alice("/market/kotak/read", { ...history, instrument: "../orders" }))
      .status,
    422,
  );
  const result = await alice("/market/kotak/read", history);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(reads, 1);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  await store.transaction((query) =>
    query("UPDATE broker_rpc_windows SET request_count=60"),
  );
  assert.equal((await alice("/market/kotak/read", history)).status, 429);
  assert.equal(reads, 1);
});
