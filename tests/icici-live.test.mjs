/** Real API/OMS/PostgreSQL integration using only fake ICICI RPC and synthetic credentials.
 * No test constructs a real worker, authenticates to ICICI or sends a real order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOTP } from "otpauth";
import { createApiApplication } from "../dist/backend/main.js";
import { credentialVault } from "../dist/backend/security.js";
import { runDatabaseMigrations } from "../dist/backend/database.js";
import { loadBreeze } from "../dist/backend/breeze.js";
import { configureExecutionTransport } from "../dist/backend/live/icici-thread.js";
import { isCashSubmissionWindow } from "../dist/backend/live/icici-routes.js";
import {
  normalizeIciciSnapshot,
  iciciOrderTag,
  IciciCashAdapter,
} from "../dist/backend/live/icici-adapter.js";
import { createPostgresTestStore } from "./postgres-fixture.mjs";
import { FakeIciciRpc } from "./fake-icici-rpc.mjs";

const creds = {
  username: "live-http-user",
  password: "live-test-password-long",
};
/** Allocate a disposable schema and cookie jar; install mocked RPC before any connection. */
async function fixture(t) {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const rpc = new FakeIciciRpc(),
    env = { BROKER_ENCRYPTION_KEY: "ab".repeat(32) };
  const app = createApiApplication(
      store,
      env,
      undefined,
      () => rpc,
      () => true,
    ),
    server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  function client() {
    let cookie = "",
      csrf = "";
    return async (path, body, headers = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie,
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      const data = await response.json();
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data };
    };
  }
  const request = client();
  assert.equal((await request("/auth/setup", creds)).status, 200);
  const [user] = await store.transaction((query) =>
    query("SELECT id FROM users"),
  );
  await store.transaction((query) =>
    query("INSERT INTO broker_credentials VALUES($1,$2,$3)", [
      user.id,
      credentialVault(env).seal(user.id, {
        apiKey: "fake-api-key",
        apiSecret: "fake-api-secret",
        sessionToken: "fake-token",
      }),
      new Date().toISOString(),
    ]),
  );
  async function enableMfa() {
    const setup = await request("/auth/mfa/setup", {
      password: creds.password,
    });
    assert.equal(setup.status, 200);
    const confirm = await request("/auth/mfa/confirm", {
      token: new TOTP({ secret: setup.data.secret }).generate(),
    });
    assert.equal(confirm.status, 200);
    return confirm.data.recovery_codes;
  }
  async function arm(token) {
    const result = await request("/live/icici/arm", {
      password: creds.password,
      token,
      capitalInr: 1000,
      confirmation: "ENABLE LIVE TRADING",
      staticIpConfirmed: true,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result;
  }
  return { store, rpc, request, client, enableMfa, arm };
}

test("real SDK cancellation transport sends signed JSON body without redirects or retries", async () => {
  const Real = loadBreeze(),
    sdk = new Real({ appKey: "fake" });
  sdk.secretKey = "fake-secret";
  sdk.apiSession = "fake-session";
  const requests = [];
  configureExecutionTransport(sdk, async (config) => {
    requests.push(config);
    return {
      data: { Status: 200, Error: null, Success: { order_id: "fake" } },
    };
  });
  await sdk.cancelOrder({ exchangeCode: "NSE", orderId: "fake" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "delete");
  assert.deepEqual(JSON.parse(requests[0].data), {
    exchange_code: "NSE",
    order_id: "fake",
  });
  assert.ok(requests[0].headers["X-Checksum"]);
  assert.equal(requests[0].maxRedirects, 0);
  assert.equal(requests[0].timeout, 1800);
});

test("live connection requires MFA, and selecting controls cannot submit an order", async (t) => {
  const { request, rpc } = await fixture(t);
  assert.equal((await request("/live/icici")).data.armed, false);
  assert.equal((await request("/live/icici/connect", {})).status, 403);
  assert.equal(
    (
      await request("/live/icici/orders", {
        previewId: "bad",
        confirmation: "PLACE LIVE ORDER",
      })
    ).status,
    403,
  );
  assert.equal(rpc.calls.length, 0);
});

test("ICICI live flow requires explicit preview confirmation and duplicate confirmation submits once", async (t) => {
  const { request, rpc, enableMfa, arm } = await fixture(t);
  const codes = await enableMfa();
  await arm(codes[0]);
  const preview = await request("/live/icici/preview", {
    stockCode: "TEST",
    side: "buy",
    quantity: 2,
    limitPaise: 1000,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(rpc.placementCalls, 0);
  assert.equal(
    (
      await request("/live/icici/orders", {
        previewId: preview.data.previewId,
        confirmation: "paper",
      })
    ).status,
    422,
  );
  const body = {
    previewId: preview.data.previewId,
    confirmation: "PLACE LIVE ORDER",
  };
  const placed = await request("/live/icici/orders", body);
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal(placed.data.state, "acknowledged");
  assert.equal((await request("/live/icici/orders", body)).status, 200);
  assert.equal(rpc.placementCalls, 1);
  const call = rpc.calls.find((call) => call.method === "placeOrder");
  assert.equal(call.params.product, "cash");
  assert.equal(call.params.orderType, "limit");
  assert.match(call.params.userRemark, /^NR[a-f0-9]{28}$/);
  const status = await request("/live/icici");
  assert.ok(!JSON.stringify(status.data).includes("MUST-NOT-REACH-UI"));
  assert.ok(!JSON.stringify(status.data).includes("fake-api-secret"));
  assert.equal((await request("/live/icici/halt", {})).data.halted, true);
  assert.equal(rpc.cancelCalls, 1);
  assert.equal((await request("/live/icici")).data.armed, false);
});

test("expired permission, missing CSRF and another session cannot place a live order", async (t) => {
  const { request, rpc, store, client, enableMfa, arm } = await fixture(t);
  const codes = await enableMfa();
  await arm(codes[0]);
  const otherSession = client();
  assert.equal(
    (await otherSession("/auth/login", { ...creds, token: codes[1] })).status,
    200,
  );
  assert.equal(
    (
      await otherSession("/live/icici/preview", {
        stockCode: "TEST",
        side: "buy",
        quantity: 1,
        limitPaise: 1000,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/live/icici/preview",
        { stockCode: "TEST", side: "buy", quantity: 1, limitPaise: 1000 },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  await store.transaction((query) =>
    query("UPDATE live_permissions SET armed_until=0"),
  );
  assert.equal(
    (
      await request("/live/icici/preview", {
        stockCode: "TEST",
        side: "buy",
        quantity: 1,
        limitPaise: 1000,
      })
    ).status,
    403,
  );
  assert.equal(rpc.placementCalls, 0);
});

test("lost placement acknowledgement becomes UNKNOWN and does not cause an automatic second order", async (t) => {
  const { request, rpc, enableMfa, arm } = await fixture(t);
  const codes = await enableMfa();
  await arm(codes[0]);
  rpc.losePlacementResponse = true;
  const preview = await request("/live/icici/preview", {
    stockCode: "TEST",
    side: "buy",
    quantity: 1,
    limitPaise: 1000,
  });
  const result = await request("/live/icici/orders", {
    previewId: preview.data.previewId,
    confirmation: "PLACE LIVE ORDER",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.state, "unknown");
  assert.equal(rpc.placementCalls, 1);
  assert.equal((await request("/live/icici")).data.armed, false);
});

test("normalizer rejects inconsistent fills/unsupported positions and accounts for cash holds", () => {
  const input = {
    orders: [],
    derivativeOrders: [],
    trades: [],
    positions: [],
    funds: { allocated_equity: 10000, block_by_trade_equity: 0 },
    margin: { cash_limit: 10000, amount_allocated: 10000, block_by_trade: 0 },
  };
  assert.equal(
    normalizeIciciSnapshot(input, new Map()).availablePaise,
    1000000,
  );
  assert.throws(
    () =>
      normalizeIciciSnapshot(
        {
          ...input,
          positions: [
            { quantity: "1", exchange_code: "NFO", product_type: "Options" },
          ],
        },
        new Map(),
      ),
    /Unsupported/,
  );
  const order = {
    order_id: "fake",
    exchange_code: "NSE",
    product_type: "Cash",
    stock_code: "TEST",
    action: "Buy",
    quantity: "2",
    pending_quantity: "2",
    cancelled_quantity: "0",
    status: "Ordered",
    price: "10",
    user_remark: iciciOrderTag("one"),
  };
  const reserved = normalizeIciciSnapshot(
    {
      ...input,
      orders: [order],
      funds: { allocated_equity: 10000, block_by_trade_equity: 20 },
      margin: { cash_limit: 9980, amount_allocated: 10000, block_by_trade: 20 },
    },
    new Map([[iciciOrderTag("one"), "one"]]),
  );
  assert.equal(reserved.cashBalancePaise, 1000000);
  assert.equal(reserved.orders[0].clientOrderKey, "one");
  assert.throws(
    () =>
      normalizeIciciSnapshot(
        {
          ...input,
          orders: [{ ...order, status: "Executed", pending_quantity: "0" }],
        },
        new Map(),
      ),
    /consistent/,
  );
});

test("adapter refuses to cancel unrelated manual orders", async () => {
  const rpc = new FakeIciciRpc(),
    adapter = new IciciCashAdapter(
      { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
      async () => {},
      () => rpc,
    );
  await adapter.connect();
  rpc.orders.push({
    order_id: "manual",
    stock_code: "TEST",
    exchange_code: "NSE",
    product_type: "Cash",
    quantity: "1",
    pending_quantity: "1",
    cancelled_quantity: "0",
    price: "10",
    status: "Ordered",
    action: "Buy",
    user_remark: "",
  });
  assert.deepEqual(
    await adapter.getCancellationOrders(new AbortController().signal),
    [],
  );
  await assert.rejects(
    adapter.cancelOrder("manual", new AbortController().signal),
    /Unmanaged/,
  );
  assert.equal(rpc.cancelCalls, 0);
  adapter.close();
});

test("cash orders are gated to the narrow weekday IST submission window", () => {
  assert.equal(
    isCashSubmissionWindow(Date.parse("2026-09-17T09:19:59+05:30")),
    false,
  );
  assert.equal(
    isCashSubmissionWindow(Date.parse("2026-09-17T09:20:00+05:30")),
    true,
  );
  assert.equal(
    isCashSubmissionWindow(Date.parse("2026-09-17T15:14:59+05:30")),
    true,
  );
  assert.equal(
    isCashSubmissionWindow(Date.parse("2026-09-17T15:15:00+05:30")),
    false,
  );
  assert.equal(
    isCashSubmissionWindow(Date.parse("2026-09-19T10:00:00+05:30")),
    false,
  );
});

test("stale broker quotes cannot authorize a live preview", async () => {
  const rpc = new FakeIciciRpc();
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async (method, params) => {
    const response = await originalCall(method, params);
    if (method === "getQuotes")
      response.Success[0].ltt = "01-Jan-2000 10:00:00";
    return response;
  };
  const adapter = new IciciCashAdapter(
    { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
    async () => {},
    () => rpc,
  );
  await adapter.connect();
  await assert.rejects(
    adapter.getQuote("NSE:TEST", "buy", new AbortController().signal),
  );
  assert.equal(rpc.placementCalls, 0);
  adapter.close();
});
