import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createIciciConnection } from "../backend/icici-connection.ts";
import {
  normalizeIciciFunds,
  normalizeIciciPortfolioRows,
} from "../backend/broker-portfolio-normalizer.ts";

test("ICICI positions preserve NFO derivative identity and P&L", () => {
  assert.deepEqual(
    normalizeIciciPortfolioRows("positions", [
      {
        stock_code: "NIFTY",
        exchange_code: "NFO",
        quantity: "50",
        average_price: "120.50",
        current_market_price: "130.25",
        unrealized_profit: "487.50",
        product_type: "Options",
        expiry_date: "24-Sep-2026",
        strike_price: "23500",
        right: "Call",
      },
    ])[0],
    {
      symbol: "NIFTY",
      isin: "",
      underlying: "NIFTY",
      instrumentToken: "NFO:NIFTY",
      exchange: "nse_fo",
      product: "Options",
      quantity: 50,
      pledgedQuantity: null,
      t1Quantity: null,
      mtfQuantity: null,
      averagePrice: 120.5,
      markPrice: 130.25,
      pnl: 487.5,
      pnlBase: null,
      pnlPerMark: null,
      expiry: "24-Sep-2026",
      right: "Call",
      strike: "23500",
    },
  );
});

/** Exercise the real route handlers and injected wire transport; never contact a broker. */
function fixture(t, overrides = {}) {
  const owner = {
    user_id: "icici-fixture-owner",
    token_hash: "icici-fixture-login",
    expires: Math.floor(Date.now() / 1000) + 86400,
  };
  const credentials = {
    appKey: "fixture-app-key",
    secretKey: "fixture-secret-key",
  };
  const account = {
    idirect_userid: "FIXTURE",
    idirect_user_name: "Fixture account",
    session_token: "fixture-broker-session",
  };
  let saved = { expires: Date.now() + 600000, value: account };
  const calls = [],
    writes = [],
    events = [],
    routes = new Map();
  const envelope = (Success) => ({
    status: 200,
    text: JSON.stringify({ Success, Status: 200, Error: null }),
  });
  const sessionStore = {
    load: async () => saved,
    save: async (_owner, provider, expires, value) => {
      writes.push({ provider, value });
      saved = { expires, value };
    },
    remove: async () => {
      saved = null;
    },
    ...overrides.sessions,
  };
  const adapter = createIciciConnection(
    {
      connected: async (...args) => {
        events.push("connected");
        await overrides.connected?.(...args);
      },
      disconnected: async () => {
        events.push("disconnected");
      },
    },
    sessionStore,
    {
      load: async () => credentials,
      save: async (_owner, provider, value) => {
        writes.push({ provider, value });
      },
    },
    async (url, body, headers) => {
      calls.push({ url, body, headers });
      return overrides.transport
        ? overrides.transport(url, body, headers, envelope)
        : envelope(
            url.endsWith("customerdetails")
              ? account
              : url.endsWith("funds")
                ? { available_margin: 1000 }
                : [],
          );
    },
  );
  adapter.register({
    use() {},
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path, handler) {
      routes.set(`POST ${path}`, handler);
    },
  });
  t.after(() => adapter.close());
  const invoke = async (route, body = {}, session = owner) => {
    let response;
    await routes.get(route)(
      { body },
      {
        locals: { session },
        json(value) {
          response = value;
        },
      },
    );
    return response;
  };
  return {
    adapter,
    owner,
    credentials,
    account,
    calls,
    writes,
    events,
    invoke,
    saved: () => saved,
    connect: (extra = {}) =>
      invoke("POST /api/brokers/icici/connect", {
        ...credentials,
        sessionKey: "fixture-daily-key",
        ...extra,
      }),
  };
}

/** Deterministic gates reproduce races without sleeps or real credential changes. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("ICICI valid login verifies signed access, saves only separated credentials and redacts status", async (t) => {
  const f = fixture(t);
  const result = await f.connect();
  assert.equal(result.connected, true);
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    true,
  );
  assert.equal(
    f.adapter.isConnected("another-owner", f.owner.token_hash),
    false,
  );
  assert.equal(f.adapter.isConnected(f.owner.user_id, "another-login"), false);
  assert.deepEqual(JSON.parse(f.calls[0].body), {
    SessionToken: "fixture-daily-key",
    AppKey: f.credentials.appKey,
  });
  assert.deepEqual(
    f.writes.map((write) => write.value),
    [f.credentials, f.account],
  );
  assert.equal(JSON.stringify(f.writes).includes("fixture-daily-key"), false);
  assert.deepEqual(f.events, ["connected"]);
  const verification = f.calls[1];
  assert.ok(verification.url.endsWith("/funds"));
  assert.equal(verification.headers["X-SessionToken"], f.account.session_token);
  assert.equal(
    verification.headers["X-Checksum"],
    `token ${createHash("sha256")
      .update(
        verification.headers["X-Timestamp"] +
          verification.body +
          f.credentials.secretKey,
      )
      .digest("hex")}`,
  );
  const status = JSON.stringify(await f.invoke("GET /api/brokers/icici"));
  for (const secret of [
    f.credentials.appKey,
    f.credentials.secretKey,
    f.account.session_token,
  ]) {
    assert.ok(!status.includes(secret));
  }
  assert.equal(
    new Date(result.expiresAt).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Kolkata",
    }),
    "00:00:00",
  );
});

test("ICICI rejects unexpected login fields before transport", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.connect({ unexpected: true }), { name: "ZodError" });
  assert.equal(f.calls.length, 0);
});

test("ICICI restoration verifies before publishing and never extends the saved expiry", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, {
    transport: async (_url, _body, _headers, envelope) => {
      started.resolve();
      await release.promise;
      return envelope({ available_margin: 1000 });
    },
  });
  const expires = f.saved().expires;
  const restoring = f.adapter.restore(f.owner);
  await started.promise;
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
  release.resolve();
  await restoring;
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    true,
  );
  assert.equal((await f.invoke("GET /api/brokers/icici")).expiresAt, expires);
  assert.equal(f.writes.length, 0);
});

for (const response of [
  { status: 401, text: "private-provider-error" },
  {
    status: 200,
    text: JSON.stringify({
      Success: null,
      Status: 500,
      Error: "private-provider-error",
    }),
  },
  { status: 200, text: "not json private-provider-error" },
  {
    status: 200,
    text: JSON.stringify({ Success: [], Status: 200, Error: null }),
  },
]) {
  test(`ICICI restoration fails closed on rejected/malformed verification ${response.text.slice(0, 18)}`, async (t) => {
    const f = fixture(t, { transport: async () => response });
    await assert.rejects(
      f.adapter.restore(f.owner),
      (error) =>
        error.status === 502 &&
        !error.message.includes("private-provider-error"),
    );
    assert.equal(
      f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
      false,
    );
    assert.equal(
      f.adapter.portfolioReader(f.owner.user_id, f.owner.token_hash),
      null,
    );
  });
}

test("ICICI disconnect fences restoration while storage is loading", async (t) => {
  const loaded = deferred(),
    release = deferred();
  const f = fixture(t, {
    sessions: {
      load: async () => {
        loaded.resolve();
        return release.promise;
      },
    },
  });
  const restoring = assert.rejects(
    f.adapter.restore(f.owner),
    (error) => error.status === 409,
  );
  await loaded.promise;
  const disconnecting = f.adapter.disconnect(f.owner.user_id);
  release.resolve({ expires: Date.now() + 600000, value: f.account });
  await Promise.all([restoring, disconnecting]);
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
  assert.equal(f.saved(), null);
  assert.equal(f.calls.length, 0);
});

for (const action of ["disconnect", "close"]) {
  test(`ICICI ${action} fences an in-flight verification response`, async (t) => {
    const started = deferred(),
      release = deferred();
    const f = fixture(t, {
      transport: async (_url, _body, _headers, envelope) => {
        started.resolve();
        await release.promise;
        return envelope({});
      },
    });
    const restoring = assert.rejects(
      f.adapter.restore(f.owner),
      (error) => error.status === 409,
    );
    await started.promise;
    const ending =
      action === "disconnect"
        ? f.adapter.disconnect(f.owner.user_id)
        : f.adapter.close();
    release.resolve();
    await Promise.all([restoring, ending]);
    assert.equal(
      f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
      false,
    );
  });
}

test("ICICI disconnect during login cannot persist or publish the late reply", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, {
    transport: async (_url, _body, _headers, envelope) => {
      started.resolve();
      await release.promise;
      return envelope(f.account);
    },
  });
  const connecting = assert.rejects(
    f.connect(),
    (error) => error.status === 409,
  );
  await started.promise;
  const disconnecting = f.adapter.disconnect(f.owner.user_id);
  release.resolve();
  await Promise.all([connecting, disconnecting]);
  assert.equal(f.writes.length, 0);
  assert.equal(f.saved(), null);
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
});

test("ICICI disconnect orders cleanup after an in-flight encrypted save", async (t) => {
  const started = deferred(),
    release = deferred();
  let durable;
  const f = fixture(t, {
    sessions: {
      save: async () => {
        started.resolve();
        await release.promise;
        durable = "saved";
      },
      remove: async () => {
        durable = null;
      },
    },
  });
  const connecting = assert.rejects(
    f.connect(),
    (error) => error.status === 409,
  );
  await started.promise;
  const disconnecting = f.adapter.disconnect(f.owner.user_id);
  release.resolve();
  await Promise.all([connecting, disconnecting]);
  assert.equal(durable, null);
  assert.ok(!f.events.includes("connected"));
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
});

test("ICICI disconnect wins a delayed registry callback and allows a subsequent fresh login", async (t) => {
  const started = deferred(),
    release = deferred();
  const f = fixture(t, {
    connected: async () => {
      started.resolve();
      await release.promise;
    },
  });
  const connecting = assert.rejects(
    f.connect(),
    (error) => error.status === 409,
  );
  await started.promise;
  const disconnecting = f.adapter.disconnect(f.owner.user_id);
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
  release.resolve();
  await Promise.all([connecting, disconnecting]);
  assert.equal(f.events.at(-1), "disconnected");
  assert.equal(f.saved(), null);
  await f.connect();
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    true,
  );
});

test("ICICI captured readers cannot access the broker after disconnect", async (t) => {
  const f = fixture(t);
  await f.adapter.restore(f.owner);
  const reader = f.adapter.portfolioReader(f.owner.user_id, f.owner.token_hash);
  await f.adapter.disconnect(f.owner.user_id);
  const count = f.calls.length;
  await assert.rejects(reader.loadFunds(), (error) => error.status === 409);
  assert.equal(f.calls.length, count);
});

test("ICICI rejects expired saved sessions without calling Breeze", async (t) => {
  const f = fixture(t, {
    sessions: {
      load: async () => ({ expires: Date.now() - 1, value: f.account }),
    },
  });
  await f.adapter.restore(f.owner);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    false,
  );
});

test("ICICI failed re-login preserves the previously verified session and redacts transport errors", async (t) => {
  let rejectLogin = false;
  const f = fixture(t, {
    transport: async (url, _body, _headers, envelope) => {
      if (rejectLogin) {
        throw new Error("private-provider-credential");
      }
      return envelope(url.endsWith("customerdetails") ? f.account : {});
    },
  });
  await f.connect();
  const saved = f.saved();
  rejectLogin = true;
  await assert.rejects(
    f.connect(),
    (error) =>
      error.status === 502 &&
      !error.message.includes("private-provider-credential"),
  );
  assert.equal(
    f.adapter.isConnected(f.owner.user_id, f.owner.token_hash),
    true,
  );
  assert.equal(f.saved(), saved);
});

test("ICICI coalesces duplicate restoration and rejects late portfolio reads after disconnect", async (t) => {
  const started = deferred(),
    release = deferred();
  let hold = false;
  const f = fixture(t, {
    transport: async (_url, _body, _headers, envelope) => {
      if (hold) {
        started.resolve();
        await release.promise;
      }
      return envelope({});
    },
  });
  await Promise.all([f.adapter.restore(f.owner), f.adapter.restore(f.owner)]);
  assert.equal(f.calls.length, 1);
  hold = true;
  const reader = f.adapter.portfolioReader(f.owner.user_id, f.owner.token_hash);
  const reading = assert.rejects(
    reader.loadFunds(),
    (error) => error.status === 409,
  );
  await started.promise;
  await f.adapter.disconnect(f.owner.user_id);
  release.resolve();
  await reading;
});

test("ICICI fresh login fences an older restoration and keeps the newer account", async (t) => {
  const started = deferred(),
    release = deferred();
  let first = true;
  const f = fixture(t, {
    transport: async (url, _body, _headers, envelope) => {
      if (first) {
        first = false;
        started.resolve();
        await release.promise;
      }
      return envelope(
        url.endsWith("customerdetails")
          ? { ...f.account, idirect_userid: "NEW-FIXTURE" }
          : {},
      );
    },
  });
  const restoring = assert.rejects(
    f.adapter.restore(f.owner),
    (error) => error.status === 409,
  );
  await started.promise;
  const connecting = f.connect();
  release.resolve();
  await Promise.all([restoring, connecting]);
  assert.equal(
    (await f.invoke("GET /api/brokers/icici")).account.user_id,
    "NEW-FIXTURE",
  );
});

test("ICICI normalizer rejects MCX because Breeze does not expose it", () => {
  assert.throws(
    () =>
      normalizeIciciPortfolioRows("positions", [
        { stock_code: "GOLD", exchange_code: "MCX", quantity: "1" },
      ]),
    /only NSE and NFO/,
  );
});

test("ICICI funds keep buying power separate from cash and collateral", () => {
  assert.deepEqual(
    normalizeIciciFunds([
      {
        available_margin: "10000",
        cash_balance: "6000",
        margin_used: "2500",
        collateral_value: "4000",
        mtm: "-125.50",
      },
    ]),
    {
      availableMargin: 10000,
      cashBalance: 6000,
      usedMargin: 2500,
      collateralValue: 4000,
      positionMtm: -125.5,
    },
  );
});
