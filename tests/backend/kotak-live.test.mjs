/** Offline-only Kotak execution tests: real isolated PostgreSQL, fake HTTP/broker books. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  KotakLiveAdapter,
  kotakOrderTag,
} from "../../dist/backend/live/kotak-live-adapter.js";
import { brokerSnapshotSchema } from "../../dist/backend/live/contracts.js";
import { KotakMarketDataClient } from "../../dist/backend/kotak-market-data-client.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { digest } from "../../dist/backend/security.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";

const contract = {
  masterToken: "kotak:cash:123",
  instrument: "123",
  symbol: "TEST",
  name: "TEST-EQ",
  market: "cash",
  lotSize: 1,
  tickPaise: 5,
};
const intent = {
  key: "test-intent",
  instrument: contract.masterToken,
  side: "buy",
  quantity: 2,
  limitPaise: 1000,
  reduceOnly: false,
};
const risk = {
  maxReservedPaise: 50000,
  maxGrossExposurePaise: 100000,
  maxPositionUnits: 50,
  maxDailyLossPaise: 5000,
  maxOrdersPerMinute: 10,
  fundsDriftTolerancePaise: 0,
};
function broker() {
  const state = {
    book: [],
    positions: [],
    calls: [],
    current: true,
    malformedAck: false,
  };
  const session = {
    accountBinding: "kotak:test-account",
    isCurrent: () => state.current,
    async request(path, body, signal) {
      signal.throwIfAborted();
      state.calls.push({ path, body });
      if (path === "/quick/user/orders") {
        return { stat: "Ok", stCode: 200, data: structuredClone(state.book) };
      }
      if (path === "/quick/user/positions") {
        return {
          stat: "ok",
          stCode: 200,
          data: structuredClone(state.positions),
        };
      }
      if (path === "/quick/user/limits") {
        return {
          stat: "Ok",
          stCode: 200,
          Net: "10000.00",
          RealizedMtomPrsnt: "0",
          UnrealizedMtomPrsnt: "0",
          BrokeragePrsnt: "0",
        };
      }
      if (path === "/quick/order/rule/ms/place") {
        const id = String(1000 + state.book.length);
        state.book.push({
          nOrdNo: id,
          GuiOrdId: body.ig,
          exSeg: body.es,
          prod: body.pc,
          tok: "123",
          trdSym: body.ts,
          trnsTp: body.tt,
          qty: body.qt,
          fldQty: "0",
          ordSt: "open",
          prc: body.pr,
          prcTp: body.pt,
          vldt: body.rt,
        });
        return state.malformedAck
          ? { stat: "Ok", stCode: 200 }
          : { stat: "Ok", stCode: 200, nOrdNo: id };
      }
      if (path === "/quick/order/cancel") {
        state.book.find((r) => r.nOrdNo === body.on).ordSt = "cancelled";
        return { stat: "Ok", stCode: 200 };
      }
      throw new Error("Unexpected offline broker path");
    },
  };
  const resolve = (token) => {
    assert.equal(token, contract.masterToken);
    return contract;
  };
  const adapter = new KotakLiveAdapter(
    session,
    resolve,
    async () => [intent],
    async () => ({ pricePaise: 1000, observedAt: Date.now() }),
  );
  return { state, session, adapter, resolve };
}
test("Kotak live adapter sends exact documented LIMIT/DAY payload and correlates book acknowledgement", async () => {
  const { state, adapter } = broker();
  const signal = new AbortController().signal;
  const ack = await adapter.placeOrder(intent, signal);
  assert.equal(ack.status, "acknowledged");
  assert.equal(ack.cashDeltaPaise, null);
  assert.deepEqual(state.calls[0], {
    path: "/quick/order/rule/ms/place",
    body: {
      am: "NO",
      dq: "0",
      es: "nse_cm",
      mp: "0",
      pc: "CNC",
      pr: "10.00",
      pt: "L",
      qt: "2",
      rt: "DAY",
      tp: "0",
      ts: "TEST-EQ",
      tt: "B",
      ig: kotakOrderTag(intent.key),
      os: "NEOTRADEAPI",
    },
  });
  const snapshot = await adapter.getSnapshot(signal);
  assert.equal(snapshot.orders[0].clientOrderKey, intent.key);
  assert.equal(snapshot.orders[0].status, "open");
  assert.equal(snapshot.fundsBasis, "broker-rms");
  assert.equal(snapshot.cashBalancePaise, null);
  assert.equal(snapshot.availablePaise, 1000000);
  assert.throws(() =>
    brokerSnapshotSchema.parse({ ...snapshot, fundsBasis: "cash-ledger" }),
  );
});
test("Kotak live adapter rejects shorts, bad ticks, stale quotes and unrelated cancellation", async () => {
  const { state, session, adapter, resolve } = broker(),
    signal = new AbortController().signal;
  await assert.rejects(
    adapter.placeOrder({ ...intent, side: "sell" }, signal),
    /short/,
  );
  await assert.rejects(
    adapter.placeOrder({ ...intent, limitPaise: 1001 }, signal),
    /tick/,
  );
  assert.equal(state.calls.length, 0);
  await adapter.placeOrder(intent, signal);
  state.book.push({ ...state.book[0], nOrdNo: "9999", GuiOrdId: "manual" });
  await assert.rejects(adapter.cancelOrder("9999", signal), /not managed/);
  await adapter.cancelOrder("1000", signal);
  assert.deepEqual(
    state.calls.filter((c) => c.path.endsWith("cancel")).map((c) => c.body.on),
    ["1000"],
  );
  const stale = new KotakLiveAdapter(
    session,
    resolve,
    async () => [],
    async () => ({ pricePaise: 1000, observedAt: Date.now() - 10000 }),
  );
  await assert.rejects(
    stale.getQuote(contract.masterToken, "buy", signal),
    /Fresh/,
  );
});
test("Kotak quantities remain exchange units and contradictory or unsupported books fail closed", async () => {
  const { state, adapter } = broker(),
    signal = new AbortController().signal;
  await adapter.placeOrder(intent, signal);
  state.book[0].fldQty = "1";
  assert.equal(
    (await adapter.getSnapshot(signal)).orders[0].status,
    "partially_filled",
  );
  state.book[0].ordSt = "complete";
  await assert.rejects(adapter.getSnapshot(signal), /Contradictory/);
  state.book[0].fldQty = "2";
  state.positions = [
    {
      exSeg: "nse_cm",
      prod: "CNC",
      tok: "123",
      cfBuyQty: "0",
      cfSellQty: "0",
      flBuyQty: "2",
      flSellQty: "0",
      multiplier: "1",
      genNum: "1",
      genDen: "1",
      prcNum: "1",
      prcDen: "1",
      cfBuyAmt: "0",
      cfSellAmt: "0",
      buyAmt: "20",
      sellAmt: "0",
    },
  ];
  const snapshot = await adapter.getSnapshot(signal);
  assert.equal(snapshot.positions[contract.masterToken], 2);
  assert.equal(snapshot.grossExposurePaise, 2000);
  state.positions[0].prod = "MIS";
  await assert.rejects(adapter.getSnapshot(signal), /unsupported/);
});

test("manual modification is detected without preventing cancellation of the managed order", async () => {
  const { state, adapter } = broker(),
    signal = new AbortController().signal;
  await adapter.placeOrder(intent, signal);
  state.book[0].prc = "50.00";
  await assert.rejects(adapter.getSnapshot(signal), /terms changed/);
  await adapter.cancelOrder("1000", signal);
  assert.equal(state.book[0].ordSt, "cancelled");
});

test("long option orders use NRML and exact lot quantities without multiplying quantity again", async () => {
  const { state, session } = broker(),
    signal = new AbortController().signal;
  const option = {
    ...contract,
    masterToken: "kotak:options:123",
    market: "options",
    name: "TEST26SEP100CE",
    lotSize: 25,
    option: {
      expiryDate: "2099-09-30",
      right: "call",
      strikePrice: 100,
      lotSize: 25,
    },
  };
  const order = { ...intent, instrument: option.masterToken, quantity: 25 };
  const adapter = new KotakLiveAdapter(
    session,
    () => option,
    async () => [order],
    async () => ({ pricePaise: 1000, observedAt: Date.now() }),
  );
  await assert.rejects(
    adapter.placeOrder({ ...order, quantity: 26 }, signal),
    /whole lots/,
  );
  await adapter.placeOrder(order, signal);
  assert.equal(state.calls[0].body.es, "nse_fo");
  assert.equal(state.calls[0].body.pc, "NRML");
  assert.equal(state.calls[0].body.qt, "25");
  assert.equal(state.calls[0].body.ts, option.name);
});

async function fixture(t, enabled = true) {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const fake = broker();
  const client = {
    executionSession: () => fake.session,
    isConnected: () => true,
    getPaperFillQuote: async () => ({
      bid: 1000,
      ask: 1000,
      observedAt: Date.now(),
      receivedAt: Date.now(),
    }),
    disconnect() {},
    close() {},
  };
  const catalog = { resolveLive: fake.resolve };
  const app = createApiApplication(
    store,
    {
      BROKER_ENCRYPTION_KEY: "ab".repeat(32),
      LIVE_TRADING_ENABLED: String(enabled),
      KOTAK_STATIC_IP_CONFIRMED: "true",
    },
    client,
    catalog,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  let cookie = "",
    csrf = "";
  async function request(path, method = "GET", body, extra = {}) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api${path}`,
      {
        method,
        headers: {
          cookie,
          "x-csrf-token": csrf,
          "content-type": "application/json",
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  }
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  const setup = await request("/auth/setup", "POST", {
    username: "liveowner",
    password: "test-password-long",
  });
  assert.equal(setup.status, 200);
  const [user] = await store.transaction((q) =>
    q("SELECT id FROM users WHERE username='liveowner'"),
  );
  async function mfa() {
    const recovery = "offline-live-proof";
    await store.transaction((q) =>
      q(
        "INSERT INTO user_security VALUES($1,'unused',TRUE,-1,$2,0) ON CONFLICT(user_id) DO UPDATE SET recovery_hashes=EXCLUDED.recovery_hashes",
        [user.id, JSON.stringify([digest(recovery)])],
      ),
    );
    return request("/live/arm", "POST", {
      token: recovery,
      confirmation: "ENABLE REAL MONEY",
    });
  }
  async function preview() {
    return request("/live/preview", "POST", {
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      limitPaise: intent.limitPaise,
      reduceOnly: false,
    });
  }
  return { ...fake, store, request, mfa, preview, app };
}
test("live routes are disabled by default and enforce auth/CSRF/MFA before any execution", async (t) => {
  const disabled = await fixture(t, false);
  assert.equal((await disabled.request("/live/status")).data.enabled, false);
  assert.equal(
    (await disabled.request("/live/configure", "POST", risk)).status,
    409,
  );
  assert.equal(disabled.state.calls.length, 0);
  const { request, state, preview } = await fixture(t);
  assert.equal(
    (await request("/live/configure", "POST", risk, { cookie: "" })).status,
    401,
  );
  assert.equal(
    (
      await request("/live/configure", "POST", risk, {
        "x-csrf-token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal((await request("/live/configure", "POST", risk)).status, 200);
  assert.equal((await preview()).status, 409);
  assert.equal(
    (
      await request("/live/arm", "POST", {
        token: "123456",
        confirmation: "ENABLE REAL MONEY",
      })
    ).status,
    409,
  );
  assert.equal(state.calls.length, 0);
});
test("live API runs MFA → preview → OMS → Kotak once, reconciles, and halts only managed orders", async (t) => {
  const { request, mfa, preview, state } = await fixture(t);
  assert.equal((await request("/live/configure", "POST", risk)).status, 200);
  assert.equal((await mfa()).status, 200);
  const p = await preview();
  assert.equal(p.status, 200);
  const body = {
    previewId: p.data.previewId,
    confirmation: "PLACE LIVE ORDER",
  };
  assert.equal(
    (await request("/live/orders", "POST", { ...body, confirmation: "yes" }))
      .status,
    422,
  );
  const outcomes = await Promise.all([
    request("/live/orders", "POST", body),
    request("/live/orders", "POST", body),
  ]);
  assert.ok(
    outcomes.every((r) => r.status === 200),
    JSON.stringify(outcomes),
  );
  assert.equal(state.calls.filter((c) => c.path.endsWith("/place")).length, 1);
  assert.equal((await request("/live/reconcile", "POST", {})).data.clean, true);
  state.book.push({ ...state.book[0], nOrdNo: "9999", GuiOrdId: "MANUAL" });
  assert.equal((await request("/live/halt", "POST", {})).status, 200);
  assert.equal(state.book[0].ordSt, "cancelled");
  assert.equal(state.book[1].ordSt, "open");
  assert.equal((await request("/live/status")).data.armed, false);
});
test("accepted order with malformed acknowledgement becomes UNKNOWN and never retries", async (t) => {
  const { request, mfa, preview, state } = await fixture(t);
  await request("/live/configure", "POST", risk);
  await mfa();
  const p = await preview();
  state.malformedAck = true;
  const body = {
    previewId: p.data.previewId,
    confirmation: "PLACE LIVE ORDER",
  };
  const result = await request("/live/orders", "POST", body);
  assert.equal(result.status, 200);
  assert.equal(result.data.state, "unknown");
  await request("/live/orders", "POST", body);
  assert.equal(state.calls.filter((c) => c.path.endsWith("/place")).length, 1);
  assert.equal((await request("/live/status")).data.halted, true);
});
test("expired previews and permissions reject without placement; session fencing disarms", async (t) => {
  const { request, mfa, preview, state, store } = await fixture(t);
  await request("/live/configure", "POST", risk);
  await mfa();
  const p = await preview();
  await store.transaction((q) => q("UPDATE live_previews SET expires=0"));
  assert.equal(
    (
      await request("/live/orders", "POST", {
        previewId: p.data.previewId,
        confirmation: "PLACE LIVE ORDER",
      })
    ).status,
    409,
  );
  await store.transaction((q) =>
    q("UPDATE live_permissions SET armed_until=0"),
  );
  assert.equal((await preview()).status, 409);
  assert.equal(
    (
      await request("/live/orders", "POST", {
        previewId: randomUUID(),
        confirmation: "PLACE LIVE ORDER",
      })
    ).status,
    409,
  );
  state.current = false;
  assert.equal((await request("/live/status")).data.armed, false);
  assert.equal(state.calls.filter((c) => c.path.endsWith("/place")).length, 0);
});
test("Kotak execution session sends form-encoded jData with auth, propagates abort, fences disconnect", async () => {
  const calls = [];
  const client = new KotakMarketDataClient(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("tradeApiLogin")) {
      return {
        data: {
          status: "success",
          kType: "View",
          token: "viewtoken",
          sid: "viewsid",
        },
      };
    }
    if (url.endsWith("tradeApiValidate")) {
      return {
        data: {
          status: "success",
          kType: "Trade",
          token: "tradetoken",
          sid: "tradesid",
          baseUrl: "https://mis.kotaksecurities.com",
        },
      };
    }
    return { stat: "Ok", stCode: 200, data: [] };
  });
  await client.connect("owner", "hash", Date.now() + 3600000, {
    accessToken: "offline-access-token",
    mobileNumber: "+919876543210",
    ucc: "OFFLINE",
    totp: "123456",
    mpin: "123456",
  });
  const session = client.executionSession("owner", "hash"),
    controller = new AbortController();
  await session.request(
    "/quick/user/limits",
    { seg: "ALL", exch: "ALL", prod: "ALL" },
    controller.signal,
  );
  const last = calls.at(-1);
  assert.equal(last.init.signal, controller.signal);
  assert.equal(last.init.headers.Auth, "tradetoken");
  assert.deepEqual(
    JSON.parse(new URLSearchParams(last.init.body).get("jData")),
    { seg: "ALL", exch: "ALL", prod: "ALL" },
  );
  await assert.rejects(
    session.request("https://evil.invalid", undefined, controller.signal),
  );
  controller.abort();
  await assert.rejects(
    session.request("/quick/user/orders", undefined, controller.signal),
  );
  client.disconnect("owner");
  assert.equal(session.isCurrent(), false);
  await assert.rejects(
    session.request(
      "/quick/user/orders",
      undefined,
      new AbortController().signal,
    ),
  );
  client.close();
});
