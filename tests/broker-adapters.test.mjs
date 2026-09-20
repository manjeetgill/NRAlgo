import test from "node:test";
import assert from "node:assert/strict";
import {
  KotakLiveAdapter,
  kotakOrderTag,
} from "../backend/live/kotak-live-adapter.ts";
import {
  createZerodhaSdk,
  createZerodhaConnection,
} from "../backend/zerodha-connection.ts";
import {
  ZerodhaLiveAdapter,
  zerodhaOrderTag,
} from "../backend/live/zerodha-live-adapter.ts";
import {
  InstrumentCatalog,
  parseZerodhaInstruments,
} from "../backend/instrument-master.ts";
import { intent } from "./fixtures.mjs";

const signal = () => new AbortController().signal;
// These broker fixtures never access a network, credentials, real accounts or order endpoints.
const kiteIntent = {
  key: "kite-owned-intent",
  instrument: "zerodha:options:123",
  side: "buy",
  quantity: 10,
  limitPaise: 1000,
};
const kiteContract = {
  masterToken: kiteIntent.instrument,
  instrument: "123",
  market: "options",
  name: "NIFTY26SEP25000CE",
  symbol: "NIFTY",
  lotSize: 10,
  tickPaise: 5,
};
const kiteBookRow = (patch = {}) => ({
  order_id: "12345",
  tag: zerodhaOrderTag(kiteIntent.key),
  exchange: "NFO",
  product: "NRML",
  tradingsymbol: kiteContract.name,
  instrument_token: 123,
  variety: "regular",
  transaction_type: "BUY",
  order_type: "LIMIT",
  validity: "DAY",
  quantity: 10,
  filled_quantity: 0,
  price: 10,
  status: "OPEN",
  ...patch,
});
function kiteExecution(options = {}) {
  const calls = [];
  const session = {
    accountBinding: "zerodha:fixture",
    expiresAt: Date.now() + 600000,
    isCurrent: () => options.current !== false,
    async request(path, method, body, abortSignal) {
      calls.push({ path, method, body });
      abortSignal.throwIfAborted();
      if (options.failure) {
        throw options.failure;
      }
      if (method !== "GET") {
        return options.ack ?? { order_id: "12345" };
      }
      if (path === "/orders") {
        return options.orders ?? [];
      }
      if (path === "/portfolio/positions") {
        return { net: options.positions ?? [] };
      }
      if (path === "/portfolio/holdings") {
        return options.holdings ?? [];
      }
      if (path === "/user/margins/equity") {
        return options.margin ?? { enabled: true, net: 100000 };
      }
      const key = decodeURIComponent(path.split("?i=")[1]);
      return {
        [key]: {
          instrument_token: Number(options.contract?.instrument ?? 123),
          timestamp: new Date(Date.now() + 19800000)
            .toISOString()
            .slice(0, 19)
            .replace("T", " "),
          depth: {
            buy: [{ price: 9.95, quantity: 20 }],
            sell: [{ price: 10, quantity: 20 }],
          },
          ...options.quote,
        },
      };
    },
  };
  const adapter = new ZerodhaLiveAdapter(
    session,
    () => options.contract ?? kiteContract,
    async () => [kiteIntent],
  );
  return { adapter, calls };
}
test("Zerodha dispatches exactly one regular LIMIT/DAY order with a 20-character correlation tag", async () => {
  const { adapter, calls } = kiteExecution();
  const result = await adapter.placeOrder(kiteIntent, signal());
  assert.equal(result.status, "acknowledged");
  assert.equal(result.filledQuantity, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tag.length, 20);
  assert.deepEqual(calls[0], {
    path: "/orders/regular",
    method: "POST",
    body: {
      exchange: "NFO",
      tradingsymbol: kiteContract.name,
      transaction_type: "BUY",
      quantity: "10",
      product: "NRML",
      order_type: "LIMIT",
      validity: "DAY",
      price: "10.00",
      tag: zerodhaOrderTag(kiteIntent.key),
    },
  });
});
for (const patch of [
  { instrument: "kotak:options:123" },
  { quantity: 11 },
  { limitPaise: 1001 },
  { side: "sell" },
]) {
  test(`Zerodha rejects invalid/cross-provider intent before dispatch ${JSON.stringify(patch)}`, async () => {
    const { adapter, calls } = kiteExecution();
    await assert.rejects(
      adapter.placeOrder({ ...kiteIntent, ...patch }, signal()),
    );
    assert.equal(calls.length, 0);
  });
}
test("Zerodha accepts a reduce-only sale of an exact contract", async () => {
  const { adapter, calls } = kiteExecution();
  await adapter.placeOrder(
    { ...kiteIntent, side: "sell", reduceOnly: true },
    signal(),
  );
  assert.equal(calls[0].body.transaction_type, "SELL");
});
for (const ack of [{}, { order_id: 12345 }, { order_id: "bad" }]) {
  test(`Zerodha malformed acknowledgement is never retried ${JSON.stringify(ack)}`, async () => {
    const { adapter, calls } = kiteExecution({ ack });
    await assert.rejects(adapter.placeOrder(kiteIntent, signal()));
    assert.equal(calls.length, 1);
  });
}
test("Zerodha ambiguous write failure has one attempt only", async () => {
  const { adapter, calls } = kiteExecution({ failure: new Error("timeout") });
  await assert.rejects(adapter.placeOrder(kiteIntent, signal()));
  assert.equal(calls.length, 1);
});
test("Zerodha owned partial fills reconcile; manual orders are never cancellation candidates", async () => {
  const { adapter, calls } = kiteExecution({
    orders: [
      kiteBookRow({ filled_quantity: 4 }),
      kiteBookRow({ order_id: "999", tag: null }),
    ],
  });
  const owned = await adapter.getCancellationOrders(signal());
  assert.equal(owned.length, 1);
  assert.equal(owned[0].status, "partially_filled");
  await assert.rejects(adapter.cancelOrder("999", signal()), /not owned/);
  assert.ok(calls.every((c) => c.method === "GET"));
  await adapter.cancelOrder("12345", signal());
  assert.equal(calls.at(-1).method, "DELETE");
});
for (const patch of [
  { price: 11 },
  { instrument_token: 999 },
  { quantity: 20 },
  { status: "COMPLETE", filled_quantity: 2 },
  { status: "REJECTED", filled_quantity: 1 },
  { status: "UNKNOWN" },
  { variety: "amo" },
]) {
  test(`Zerodha rejects altered or contradictory broker books ${JSON.stringify(patch)}`, async () => {
    await assert.rejects(
      kiteExecution({ orders: [kiteBookRow(patch)] }).adapter.getSnapshot(
        signal(),
      ),
    );
  });
}
test("Zerodha normalizes option carry, RMS funds and daily mark-to-market", async () => {
  const position = {
    ...kiteBookRow(),
    quantity: 10,
    average_price: 9,
    multiplier: 1,
    m2m: -10,
  };
  const snapshot = await kiteExecution({
    positions: [position],
  }).adapter.getSnapshot(signal());
  assert.deepEqual(snapshot.positions, { [kiteIntent.instrument]: 10 });
  assert.equal(snapshot.grossExposurePaise, 10000);
  assert.equal(snapshot.dailyPnlPaise, -1000);
  assert.equal(snapshot.availablePaise, 10000000);
  assert.equal(snapshot.cashBalancePaise, null);
});
test("Zerodha CNC opening carry plus today's net sales does not subtract used holdings twice", async () => {
  const contract = {
    ...kiteContract,
    masterToken: "zerodha:cash:123",
    market: "cash",
    name: "TEST",
    lotSize: 1,
  };
  const holding = {
    exchange: "NSE",
    product: "CNC",
    instrument_token: 123,
    tradingsymbol: "TEST",
    opening_quantity: 10,
    used_quantity: 2,
    collateral_quantity: 0,
    short_quantity: 0,
    discrepancy: false,
    average_price: 8,
    day_change: 1,
  };
  const position = { ...holding, quantity: -2, multiplier: 1, m2m: 0 };
  const snapshot = await kiteExecution({
    contract,
    holdings: [holding],
    positions: [position],
  }).adapter.getSnapshot(signal());
  assert.deepEqual(snapshot.positions, { "zerodha:cash:123": 8 });
});
for (const options of [
  { current: false },
  { quote: { timestamp: "2020-01-01 10:00:00" } },
  { quote: { instrument_token: 999 } },
  { quote: { depth: { buy: [], sell: [] } } },
  { margin: { enabled: true } },
  {
    positions: [
      {
        ...kiteBookRow(),
        quantity: -10,
        average_price: 10,
        multiplier: 1,
        m2m: 0,
      },
    ],
  },
  {
    positions: [
      {
        ...kiteBookRow(),
        product: "MIS",
        quantity: 10,
        average_price: 10,
        multiplier: 1,
        m2m: 0,
      },
    ],
  },
]) {
  test(`Zerodha missing/stale/unsupported inputs fail closed ${JSON.stringify(options)}`, async () => {
    const { adapter } = kiteExecution(options);
    if (options.quote) {
      await assert.rejects(
        adapter.getQuote(kiteIntent.instrument, "buy", signal()),
      );
    } else {
      await assert.rejects(adapter.getSnapshot(signal()));
    }
  });
}
test("Kite master excludes futures/indices and separates broker tokens", async () => {
  const row = {
    instrument_token: 123,
    tradingsymbol: kiteContract.name,
    name: "NIFTY",
    exchange: "NFO",
    segment: "NFO-OPT",
    instrument_type: "CE",
    lot_size: 10,
    tick_size: 0.05,
    expiry: "2099-09-29",
    strike: 25000,
  };
  const catalog = new InstrumentCatalog();
  await catalog.loadZerodha("options", async () => [
    row,
    {
      ...row,
      instrument_token: 456,
      segment: "NFO-FUT",
      instrument_type: "FUT",
      tick_size: 0,
    },
  ]);
  assert.equal(catalog.resolveLive(kiteIntent.instrument).tickPaise, 5);
  assert.throws(() => catalog.resolveLive("kotak:options:123"));
  assert.equal(
    catalog.search("zerodha", { market: "options", query: "NIFTY", offset: 0 })
      .items.length,
    1,
  );
  assert.throws(
    () => parseZerodhaInstruments("options", [row, row]),
    /Duplicate/,
  );
});
function kotak(options = {}) {
  const calls = [];
  const adapter = new KotakLiveAdapter(
    {
      accountBinding: "fixture",
      isCurrent: () => options.current !== false,
      request: async (path, body) => {
        calls.push({ path, body });
        if (options.failure) {
          throw options.failure;
        }
        return options.response ?? { stat: "Ok", stCode: 200, nOrdNo: "12345" };
      },
    },
    () => ({
      masterToken: intent.instrument,
      market: "cash",
      name: "TEST-EQ",
      lotSize: 10,
      tickPaise: 5,
      ...options.contract,
    }),
    async () => [intent],
    async () => options.quote ?? { pricePaise: 1000, observedAt: Date.now() },
  );
  return { adapter, calls };
}
test("Kotak sends exactly one LIMIT/DAY request and treats acknowledgement as unfilled", async () => {
  const { adapter, calls } = kotak();
  const result = await adapter.placeOrder(intent, signal());
  assert.equal(result.status, "acknowledged");
  assert.equal(result.filledQuantity, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    path: "/quick/order/rule/ms/place",
    body: {
      am: "NO",
      dq: "0",
      es: "nse_cm",
      mp: "0",
      pc: "CNC",
      pr: "10.00",
      pt: "L",
      qt: "10",
      rt: "DAY",
      tp: "0",
      ts: "TEST-EQ",
      tt: "B",
      ig: kotakOrderTag(intent.key),
      os: "NEOTRADEAPI",
    },
  });
});
for (const patch of [
  { quantity: 11 },
  { limitPaise: 1001 },
  { side: "sell" },
]) {
  test(`Kotak rejects invalid terms ${JSON.stringify(patch)} before network`, async () => {
    const { adapter, calls } = kotak();
    await assert.rejects(adapter.placeOrder({ ...intent, ...patch }, signal()));
    assert.equal(calls.length, 0);
  });
}
for (const response of [
  null,
  {},
  { stat: "Not_Ok", stCode: 400 },
  { stat: "Ok", stCode: 200 },
  { stat: "Ok", stCode: 200, nOrdNo: "invalid" },
]) {
  test(`Kotak malformed acknowledgement is never a fill or a retried order: ${JSON.stringify(response)}`, async () => {
    const { adapter, calls } = kotak({ response: response ?? [] });
    await assert.rejects(adapter.placeOrder(intent, signal()));
    assert.equal(calls.length, 1);
  });
}
test("Kotak ambiguous transport failure is not retried", async () => {
  const { adapter, calls } = kotak({
    failure: new Error("timeout after acceptance"),
  });
  await assert.rejects(adapter.placeOrder(intent, signal()), /timeout/);
  assert.equal(calls.length, 1);
});
for (const options of [
  { current: false },
  { quote: { pricePaise: 0, observedAt: Date.now() } },
  { quote: { pricePaise: 1000, observedAt: 1 } },
  { quote: { pricePaise: 1000, observedAt: Date.now() + 60000 } },
]) {
  test(`Kotak rejects invalid quote/session ${JSON.stringify(options)}`, async () => {
    await assert.rejects(
      kotak(options).adapter.getQuote(intent.instrument, "buy", signal()),
      /Fresh broker quote/,
    );
  });
}
test("Kotak cannot cancel a foreign/manual order", async () => {
  const { adapter, calls } = kotak({
    response: {
      stat: "Ok",
      stCode: 200,
      data: [{ GuiOrdId: "manual", nOrdNo: "987" }],
    },
  });
  await assert.rejects(adapter.cancelOrder("987", signal()), /not managed/);
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/quick/user/orders"],
  );
});
test("Kotak incomplete books and missing funds fail closed", async () => {
  for (const response of [
    { stat: "Ok", stCode: 200 },
    { stat: "Ok", stCode: 200, data: [] },
  ]) {
    await assert.rejects(kotak({ response }).adapter.getSnapshot(signal()));
  }
});

function kite(overrides = {}) {
  const clients = [];
  const sdk = createZerodhaSdk(
    { apiKey: "test-fixture-key", apiSecret: "test-fixture-secret-not-real" },
    () => {
      const client = {
        token: null,
        getLoginURL: () => "https://kite.zerodha.com/connect/login?v=3",
        setAccessToken(token) {
          this.token = token;
        },
        getProfile: async () => ({ user_id: "TEST", user_name: "Fixture" }),
        generateSession: async () => ({
          user_id: "TEST",
          user_name: "Fixture",
          access_token: "test-fixture-token",
        }),
        invalidateAccessToken: async () => {},
        ...overrides,
      };
      clients.push(client);
      return client;
    },
  );
  return { sdk, clients };
}
test("Zerodha builder reads current/next stock expiries and caches only its session master", async () => {
  let masters = 0,
    reservations = 0;
  const { sdk } = kite({
    getInstruments: async () => {
      masters++;
      return ["2099-01-29", "2099-02-26", "2099-03-26"].flatMap((expiry, i) =>
        ["CE", "PE"].map((right, j) => ({
          name: "RELIANCE",
          tradingsymbol: `REL${i}${right}`,
          instrument_type: right,
          expiry,
          strike: 1400,
          lot_size: 500,
          instrument_token: i * 2 + j + 1,
        })),
      );
    },
    getQuote: async (keys) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          { last_price: key.startsWith("NSE:") ? 1410 : 25, oi: 1000 },
        ]),
      ),
  });
  const session = sdk.restore({
    accessToken: "fixture",
    account: { user_id: "TEST", user_name: "Fixture" },
  });
  const reserve = async () => {
    reservations++;
  };
  const metadata = await session.optionSnapshot(
    { query: "REL", underlying: "RELIANCE", offset: 0 },
    reserve,
  );
  assert.deepEqual(metadata.expiries, ["2099-01-29", "2099-02-26"]);
  assert.equal(metadata.items.length, 0);
  const page = await session.optionSnapshot(
    {
      query: "REL",
      underlying: "RELIANCE",
      expiryDate: metadata.expiries[0],
      offset: 0,
    },
    reserve,
  );
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].price, 25);
  assert.equal(page.items[0].lotSize, 500);
  assert.equal(page.underlyingPrice, 1410);
  assert.equal(page.dataMode, "historical");
  assert.equal(masters, 1);
  assert.equal(reservations, 2);
  await assert.rejects(
    session.optionSnapshot(
      {
        query: "REL",
        underlying: "RELIANCE",
        expiryDate: "2099-03-26",
        offset: 0,
      },
      reserve,
    ),
    /current or next/,
  );
});
test("Zerodha quote denial preserves contracts without fabricating premiums", async () => {
  const { sdk } = kite({
    getInstruments: async () => [
      {
        name: "RELIANCE",
        tradingsymbol: "RELCE",
        instrument_type: "CE",
        expiry: "2099-01-29",
        strike: 1400,
        lot_size: 500,
        instrument_token: 1,
      },
    ],
    getQuote: async () => {
      throw {
        status: "error",
        error_type: "PermissionException",
        message: "private provider payload",
      };
    },
  });
  const session = sdk.restore({
    accessToken: "fixture",
    account: { user_id: "TEST", user_name: "Fixture" },
  });
  const result = await session.optionSnapshot(
    {
      query: "REL",
      underlying: "RELIANCE",
      expiryDate: "2099-01-29",
      offset: 0,
    },
    async () => {},
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, null);
  assert.equal(result.underlyingPrice, null);
  assert.equal(result.quotesUnavailable, true);
  assert.match(result.warning, /denied quote access/);
  assert.ok(!JSON.stringify(result).includes("private provider payload"));
});
test("Zerodha restores isolated SDK clients and verifies the bound account", async () => {
  const { sdk, clients } = kite();
  const a = sdk.restore({
    accessToken: "token-a",
    account: { user_id: "TEST", user_name: "Fixture" },
  });
  sdk.restore({
    accessToken: "token-b",
    account: { user_id: "OTHER", user_name: "Other" },
  });
  assert.notEqual(clients[0], clients[1]);
  assert.equal(clients[0].token, "token-a");
  assert.equal(clients[1].token, "token-b");
  assert.equal((await a.verify()).user_id, "TEST");
});
test("Zerodha account mismatch is rejected and SDK errors are redacted", async () => {
  const { sdk } = kite({
    getProfile: async () => ({ user_id: "FOREIGN", user_name: "Other" }),
    generateSession: async () => {
      throw new Error("secret-access-token");
    },
  });
  await assert.rejects(
    sdk
      .restore({
        accessToken: "fixture",
        account: { user_id: "TEST", user_name: "Test" },
      })
      .verify(),
    /session verification unavailable/,
  );
  await assert.rejects(
    sdk.exchange("request-token"),
    (error) =>
      !error.message.includes("secret-access-token") &&
      /login failed/.test(error.message),
  );
});
test("Zerodha rejects unexpected authorization destinations", () => {
  const { sdk } = kite({ getLoginURL: () => "https://attacker.invalid/login" });
  assert.throws(() => sdk.loginUrl("a".repeat(43)), /Unexpected Kite/);
});
test("Zerodha failed revocation reports failure, not success", async () => {
  const { sdk } = kite({
    invalidateAccessToken: async () => {
      throw new Error("network");
    },
  });
  assert.equal(
    await sdk
      .restore({
        accessToken: "fixture",
        account: { user_id: "TEST", user_name: "Test" },
      })
      .revoke(),
    false,
  );
});

test("Zerodha wire capability is allowlisted, abortable, non-retrying and redacts transport errors", async (t) => {
  const { sdk } = kite();
  const client = sdk.restore({
    accessToken: "test-private-fixture-token",
    account: { user_id: "TEST", user_name: "Test" },
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(url, "https://api.kite.trade/orders/regular");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    throw new Error("private-fixture-token in transport error");
  });
  await assert.rejects(
    client.executionRequest(
      "/orders/regular",
      "POST",
      { quantity: "1" },
      signal(),
    ),
    (error) => !error.message.includes("private-fixture-token"),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.executionRequest("/user/profile", "POST", {}, signal()),
  );
  await assert.rejects(
    client.executionRequest(
      "https://other.invalid",
      "GET",
      undefined,
      signal(),
    ),
  );
  assert.equal(calls, 1);
});

test("Zerodha execution capability rejects another owner and becomes stale on disconnect", async () => {
  let requests = 0;
  const sdk = {
    restore: () => ({
      account: { user_id: "TEST" },
      verify: async () => {},
      revoke: async () => true,
      executionRequest: async () => {
        requests++;
        return [];
      },
      executionInstruments: async () => [],
    }),
  };
  const owner = {
    user_id: "owner",
    token_hash: "app-session",
    expires: Date.now() / 1000 + 600,
  };
  const connection = createZerodhaConnection({}, sdk, undefined, {
    load: async () => ({ value: {}, expires: Date.now() + 600000 }),
  });
  try {
    await connection.restore(owner);
    assert.throws(() =>
      connection.executionSession("someone-else", owner.token_hash),
    );
    const session = connection.executionSession(
      owner.user_id,
      owner.token_hash,
    );
    await session.request("/orders", "GET", undefined, signal());
    assert.equal(requests, 1);
    await connection.disconnect(owner.user_id);
    assert.equal(session.isCurrent(), false);
    await assert.rejects(
      session.request("/orders/regular", "POST", {}, signal()),
    );
    assert.equal(requests, 1);
  } finally {
    connection.close();
  }
});
