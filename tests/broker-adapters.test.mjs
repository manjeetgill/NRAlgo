import test from "node:test";
import assert from "node:assert/strict";
import {
  KotakLiveAdapter,
  kotakOrderTag,
} from "../backend/live/kotak-live-adapter.ts";
import { createZerodhaSdk } from "../backend/zerodha-connection.ts";
import { intent } from "./fixtures.mjs";

const signal = () => new AbortController().signal;
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
