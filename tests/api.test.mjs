/** Regression tests against compiled production modules. PostgreSQL schemas are disposable,
 * broker traffic is mocked and no real account credentials or live orders are used.
 * Each test name describes the security/reliability invariant it protects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabaseStore,
  runDatabaseMigrations,
  root,
} from "../dist/backend/database.js";
import { fileURLToPath } from "node:url";
import {
  createApiApplication,
  hashPasswordForLegacyCompatibility,
} from "../dist/backend/main.js";
import {
  processNextPaperJob,
  recoverInterruptedPaperJobs,
  refreshWorkerLease,
} from "../dist/backend/worker.js";
import { BrokerManager } from "../dist/backend/brokers.js";
import { credentialVault } from "../dist/backend/security.js";
import { simulateSyntheticStrategy } from "../dist/backend/simulator.js";
import { createBreezeData, loadBreeze } from "../dist/backend/breeze.js";
import { createRequire } from "node:module";
import { TOTP } from "otpauth";
import { createHash } from "node:crypto";
import { createPostgresTestStore } from "./postgres-fixture.mjs";

const creds = { username: "testowner", password: "test-password-long" };
test("compiled backend retains the original workspace path", () => {
  assert.equal(root, fileURLToPath(new URL("../", import.meta.url)));
});
test("production cannot fall back to a local database", () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    assert.throws(() => openDatabaseStore(""), /PostgreSQL/);
    assert.throws(() => openDatabaseStore("sqlite://:memory:"), /PostgreSQL/);
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
  assert.throws(() => openDatabaseStore("https://example.com"), /PostgreSQL/);
});
/** Start an isolated HTTP API with independent cookie jars; always release sockets and stores. */
async function fixture(t, env = {}, options = {}) {
  const store = await createPostgresTestStore();
  if (options.seed) await options.seed(store);
  await runDatabaseMigrations(store, {});
  const app = createApiApplication(
    store,
    { BROKER_ENCRYPTION_KEY: "ab".repeat(32), ...env },
    options.brokers,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const client = () => {
    let cookie = "",
      csrf = "";
    return async (path, method = "GET", body, headers = {}) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${path}`,
        {
          method,
          headers: {
            cookie,
            "x-csrf-token": csrf,
            "content-type": "application/json",
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const data = await response.json();
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    };
  };
  const request = client();
  t.after(async () => {
    app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  return {
    store,
    request,
    client,
    owner: () => request("/api/auth/setup", "POST", creds),
  };
}
const strategy = {
  name: "Momentum test",
  symbol: "NIFTY",
  capital: 100000,
  fast: 9,
  slow: 21,
};

test("owner authentication, CSRF, origin rejection and logout", async (t) => {
  const { request, owner } = await fixture(t);
  assert.equal((await request("/api/workspace")).status, 401);
  assert.equal((await owner()).status, 200);
  assert.equal((await owner()).status, 409);
  assert.equal(
    (await request("/api/strategies", "POST", strategy, { "x-csrf-token": "" }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/controls",
        "POST",
        { halted: true },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal((await request("/api/auth/logout", "POST", {})).status, 200);
  assert.equal((await request("/api/workspace")).status, 401);
});
test("validation and live orders disabled", async (t) => {
  const { request, owner } = await fixture(t);
  await owner();
  for (const fields of [
    { capital: -5 },
    { capital: 500001 },
    { capital: "10000" },
    { fast: 30, slow: 10 },
    { name: "  " },
    { mode: "live" },
  ]) {
    assert.equal(
      (await request("/api/strategies", "POST", { ...strategy, ...fields }))
        .status,
      422,
    );
  }
  assert.equal((await request("/api/health")).data.live_enabled, false);
});
test("replay end-to-end, duplicate prevention and login persistence", async (t) => {
  const { request, owner, store } = await fixture(t);
  await owner();
  const {
    data: { id },
  } = await request("/api/strategies", "POST", strategy);
  const statuses = await Promise.all(
    [1, 2].map(
      async () =>
        (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    ),
  );
  assert.deepEqual(statuses.sort(), [202, 409]);
  assert.equal(await processNextPaperJob(store), true);
  const data = (await request("/api/workspace")).data;
  assert.equal(data.jobs[0].status, "completed");
  const result = data.jobs[0].result;
  assert.equal(result.equity.length, 240);
  assert.ok(result.trades.length);
  assert.equal(result.source, "synthetic");
  assert.ok(
    Math.abs(result.trades.reduce((s, t) => s + (t.pnl || 0), 0) - result.pnl) <
      0.02,
  );
  assert.equal(await processNextPaperJob(store), false);
  await request("/api/auth/logout", "POST", {});
  assert.equal((await request("/api/auth/login", "POST", creds)).status, 200);
  assert.equal((await request("/api/workspace")).data.strategies[0].id, id);
});
test("pause cancels work, blocks new work and can resume", async (t) => {
  const { request, owner, store } = await fixture(t);
  await owner();
  const {
    data: { id },
  } = await request("/api/strategies", "POST", strategy);
  await request(`/api/strategies/${id}/run`, "POST", {});
  await request("/api/controls", "POST", { halted: true });
  assert.equal(await processNextPaperJob(store), false);
  assert.equal(
    (await request("/api/workspace")).data.jobs[0].status,
    "cancelled",
  );
  assert.equal(
    (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    409,
  );
  await request("/api/controls", "POST", { halted: false });
  assert.equal(
    (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    202,
  );
});
test("login throttles by source and username, not by victim account", async (t) => {
  const { request, owner } = await fixture(t);
  await owner();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          ...creds,
          password: "wrong-password-long",
        })
      ).status,
      401,
    );
  assert.equal((await request("/api/auth/login", "POST", creds)).status, 429);
});
test("production setup token and secure cookie", async (t) => {
  const token = "x".repeat(64);
  const { request } = await fixture(t, {
    APP_ENV: "production",
    APP_ORIGIN: "https://algo.example.com",
    SETUP_TOKEN: token,
  });
  assert.equal((await request("/api/auth/setup", "POST", creds)).status, 403);
  const response = await request("/api/auth/setup", "POST", {
    ...creds,
    setup_token: token,
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("set-cookie"),
    /HttpOnly; Secure; SameSite=Strict/,
  );
});
test("production config rejects unsafe origins and short tokens", () => {
  for (const origin of [
    "http://example.com",
    "https://example.com/path",
    "https://user@example.com",
  ])
    assert.throws(() =>
      createApiApplication(
        {},
        {
          APP_ENV: "production",
          APP_ORIGIN: origin,
          SETUP_TOKEN: "x".repeat(64),
        },
      ),
    );
  assert.throws(() =>
    createApiApplication(
      {},
      {
        APP_ENV: "production",
        APP_ORIGIN: "https://example.com",
        SETUP_TOKEN: "short",
      },
    ),
  );
});
test("health detects unavailable schema, request body is bounded", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await request("/api/health")).status, 200);
  assert.equal(
    (await request("/api/auth/setup", "POST", { password: "x".repeat(17000) }))
      .status,
    413,
  );
  await store.transaction((query) => query("DELETE FROM settings"));
  assert.equal((await request("/api/health")).status, 503);
});
test("migrations preserve legacy rows and password hashes", async (t) => {
  const salt = "0123456789abcdef0123456789abcdef";
  const hash = hashPasswordForLegacyCompatibility(creds.password, salt);
  assert.equal(hash.split(":")[1].length, 128);
  const { store, request } = await fixture(
    t,
    {},
    {
      seed: async (store) => {
        await store.transaction(async (query) => {
          await query(
            "CREATE TABLE owners (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, failed_logins INTEGER, locked_until DOUBLE PRECISION)",
          );
          await query("INSERT INTO owners VALUES (1,$1,$2,0,0)", [
            creds.username,
            hash,
          ]);
          await query(
            "CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT, symbol TEXT, fast INTEGER, slow INTEGER, capital INTEGER, status TEXT, pnl DOUBLE PRECISION, created_at TEXT)",
          );
          await query(
            "INSERT INTO strategies VALUES ('legacy','Legacy strategy','NIFTY',9,21,100000,'draft',0,'2026-01-01')",
          );
        });
      },
    },
  );
  await runDatabaseMigrations(store, {});
  await runDatabaseMigrations(store, {});
  assert.equal((await request("/api/auth/login", "POST", creds)).status, 200);
  assert.equal(
    (await request("/api/workspace")).data.strategies[0].id,
    "legacy",
  );
});

test("nonexistent username cannot lock the real account", async (t) => {
  const { request, owner } = await fixture(t);
  await owner();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          username: "nobody",
          password: "incorrect-password",
        })
      ).status,
      401,
    );
  assert.equal((await request("/api/auth/login", "POST", creds)).status, 200);
});
test("two accounts isolate strategies, jobs, pause state and audit events", async (t) => {
  const { request: alice, client, owner, store } = await fixture(t);
  await owner();
  const bob = client();
  assert.equal(
    (
      await bob("/api/auth/register", "POST", {
        username: "bob",
        password: "bob-password-long",
      })
    ).status,
    200,
  );
  const a = await alice("/api/strategies", "POST", {
    ...strategy,
    name: "Alice private",
  });
  const b = await bob("/api/strategies", "POST", {
    ...strategy,
    name: "Bob private",
  });
  assert.equal(
    (await bob(`/api/strategies/${a.data.id}/run`, "POST", {})).status,
    404,
  );
  await alice(`/api/strategies/${a.data.id}/run`, "POST", {});
  await bob(`/api/strategies/${b.data.id}/run`, "POST", {});
  await alice("/api/controls", "POST", { halted: true });
  assert.equal(await processNextPaperJob(store), true);
  const aw = (await alice("/api/workspace")).data,
    bw = (await bob("/api/workspace")).data;
  assert.equal(aw.jobs[0].status, "cancelled");
  assert.equal(bw.jobs[0].status, "completed");
  assert.equal(bw.halted, false);
  assert.equal(bw.strategies.length, 1);
  assert.ok(!JSON.stringify(bw).includes("Alice private"));
  assert.ok(!JSON.stringify(aw).includes("Bob private"));
});
test("production registrations require invitation by default", async (t) => {
  const token = "s".repeat(40),
    invite = "i".repeat(40);
  const { request } = await fixture(t, {
    APP_ENV: "production",
    APP_ORIGIN: "https://algo.example.com",
    SETUP_TOKEN: token,
    REGISTRATION_TOKEN: invite,
  });
  await request("/api/auth/setup", "POST", { ...creds, setup_token: token });
  assert.equal(
    (
      await request("/api/auth/register", "POST", {
        username: "bob",
        password: "bob-password-long",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/auth/register", "POST", {
        username: "bob",
        password: "bob-password-long",
        invite_token: invite,
      })
    ).status,
    200,
  );
});
test("password changes revoke existing sessions and preserve current session", async (t) => {
  const { request, owner, client } = await fixture(t);
  await owner();
  const other = client();
  await other("/api/auth/login", "POST", creds);
  assert.equal(
    (
      await request("/api/auth/password", "POST", {
        current_password: creds.password,
        new_password: "replacement-password",
      })
    ).status,
    200,
  );
  assert.equal((await other("/api/workspace")).status, 401);
  assert.equal((await request("/api/workspace")).status, 200);
  assert.equal((await other("/api/auth/login", "POST", creds)).status, 401);
  assert.equal(
    (
      await other("/api/auth/login", "POST", {
        ...creds,
        password: "replacement-password",
      })
    ).status,
    200,
  );
});
test("readiness and worker lease detect missing, duplicate and stale workers", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await request("/api/ready")).status, 503);
  await refreshWorkerLease(store, "worker-a");
  assert.equal((await request("/api/ready")).status, 200);
  await assert.rejects(refreshWorkerLease(store, "worker-b"), /Another worker/);
  await store.transaction((query) =>
    query("UPDATE worker_health SET heartbeat=0"),
  );
  assert.equal((await request("/api/ready")).status, 503);
  await refreshWorkerLease(store, "worker-b");
  await assert.rejects(processNextPaperJob(store, "worker-a"), /lease lost/);
});
test("credential encryption is randomized, authenticated and bound to the account", () => {
  const vault = credentialVault({ BROKER_ENCRYPTION_KEY: "aa".repeat(32) }),
    secret = { apiSecret: "secret" };
  const encrypted = vault.seal("alice", secret);
  assert.notEqual(encrypted, vault.seal("alice", secret));
  assert.deepEqual(vault.open("alice", encrypted), secret);
  assert.throws(() => vault.open("bob", encrypted));
  assert.throws(() => vault.open("alice", encrypted.slice(0, -4) + "xxxx"));
  assert.throws(() => credentialVault({ APP_ENV: "production" }));
});
test("MFA enrollment, token replay prevention, recovery codes and broker enforcement", async (t) => {
  const setupToken = "s".repeat(40);
  const { request, client } = await fixture(t, {
    APP_ENV: "production",
    APP_ORIGIN: "https://example.com",
    SETUP_TOKEN: setupToken,
  });
  await request("/api/auth/setup", "POST", {
    ...creds,
    setup_token: setupToken,
  });
  assert.equal(
    (
      await request("/api/brokers/icici/connect", "POST", {
        apiKey: "fake-key",
        apiSecret: "fake-secret",
        sessionToken: "fake-token",
      })
    ).status,
    403,
  );
  const setup = await request("/api/auth/mfa/setup", "POST", {
    password: creds.password,
  });
  assert.equal(setup.status, 200);
  const verifier = new TOTP({ secret: setup.data.secret });
  const confirmed = await request("/api/auth/mfa/confirm", "POST", {
    token: verifier.generate(),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.recovery_codes.length, 8);
  const other = client();
  assert.equal((await other("/api/auth/login", "POST", creds)).status, 401);
  assert.equal(
    (
      await other("/api/auth/login", "POST", {
        ...creds,
        token: verifier.generate(),
      })
    ).status,
    401,
  );
  const recovery = confirmed.data.recovery_codes[0];
  assert.equal(
    (await other("/api/auth/login", "POST", { ...creds, token: recovery }))
      .status,
    200,
  );
  assert.equal(
    (await other("/api/auth/login", "POST", { ...creds, token: recovery }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/auth/mfa/disable", "POST", {
        password: creds.password,
        token: confirmed.data.recovery_codes[1],
      })
    ).status,
    200,
  );
  assert.equal((await other("/api/workspace")).status, 401);
});
test("installed Breeze SDK signs v1 and sends the documented historical-v2 headers", async () => {
  const Client = loadBreeze(),
    sdk = new Client({ appKey: "example-app-key" });
  sdk.secretKey = "example-secret";
  sdk.apiSession = "exchanged-session";
  const payload = { stock_code: "RELIND" };
  const headers = sdk.generateHeaders(payload);
  assert.equal(headers["X-AppKey"], "example-app-key");
  assert.equal(headers["X-SessionToken"], "exchanged-session");
  assert.match(headers["X-Timestamp"], /\.000Z$/);
  assert.equal(
    headers["X-Checksum"],
    "token " +
      createHash("sha256")
        .update(
          headers["X-Timestamp"] + JSON.stringify(payload) + "example-secret",
        )
        .digest("hex"),
  );
  const require = createRequire(import.meta.url),
    axios = require("axios"),
    previous = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    assert.equal(config.headers.apikey, "example-app-key");
    assert.equal(config.headers["X-SessionToken"], "exchanged-session");
    assert.equal(config.headers["X-Checksum"], undefined);
    return {
      data: { Status: 200, Success: [] },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  try {
    await sdk.getHistoricalDatav2({
      interval: "1minute",
      fromDate: "2025-01-01T09:15:00.000Z",
      toDate: "2025-01-01T10:15:00.000Z",
      stockCode: "RELIND",
      exchangeCode: "NSE",
    });
  } finally {
    axios.defaults.adapter = previous;
  }
});
test("ICICI credentials and data are private, encrypted, removable and CSRF protected", async (t) => {
  const brokers = new BrokerManager((creds) => ({
    async call(method) {
      return method === "historical"
        ? [{ close: creds.apiKey === "alice-key" ? 101 : 202 }]
        : { ok: true };
    },
    close() {},
    snapshot() {
      return { state: "connected", tick: null, receivedAt: null };
    },
  }));
  const {
    request: alice,
    owner,
    client,
    store,
  } = await fixture(t, {}, { brokers });
  await owner();
  const bob = client();
  await bob("/api/auth/register", "POST", {
    username: "bob",
    password: "bob-password-long",
  });
  const a = {
    apiKey: "alice-key",
    apiSecret: "alice-secret",
    sessionToken: "alice-token",
  };
  assert.equal(
    (
      await alice("/api/brokers/icici/connect", "POST", a, {
        "x-csrf-token": "",
      })
    ).status,
    403,
  );
  assert.equal(
    (await alice("/api/brokers/icici/connect", "POST", a)).status,
    200,
  );
  assert.equal((await bob("/api/brokers/icici")).data.saved, false);
  assert.equal(
    (await bob("/api/brokers/icici/reconnect", "POST", {})).status,
    409,
  );
  assert.equal(
    (
      await bob("/api/brokers/icici/connect", "POST", {
        apiKey: "bobby-key",
        apiSecret: "bobby-secret",
        sessionToken: "bobby-token",
      })
    ).status,
    200,
  );
  const history = {
    stockCode: "RELIND",
    exchangeCode: "NSE",
    interval: "1minute",
    fromDate: "2025-01-01T09:15:00Z",
    toDate: "2025-01-01T10:15:00Z",
  };
  assert.equal(
    (await alice("/api/brokers/icici/historical", "POST", history)).data
      .candles[0].close,
    101,
  );
  assert.equal(
    (await bob("/api/brokers/icici/historical", "POST", history)).data
      .candles[0].close,
    202,
  );
  const rows = await store.transaction((query) =>
    query("SELECT * FROM broker_credentials"),
  );
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes("alice-secret"));
  assert.ok(
    !JSON.stringify((await alice("/api/brokers/icici")).data).includes(
      "alice-key",
    ),
  );
  assert.equal((await alice("/api/brokers/icici", "DELETE")).status, 200);
  assert.equal((await bob("/api/brokers/icici")).data.saved, true);
  assert.equal(
    (await alice("/api/brokers/icici/historical", "POST", history)).status,
    409,
  );
});
test("real SDK can reconnect after explicit disconnect without network access", async () => {
  const Real = loadBreeze();
  let latest,
    connects = 0;
  function Mock(params) {
    latest = new Real(params);
    latest.generateSession = async () => {};
    latest.connect = () => {
      connects++;
      latest.socket = {
        connected: true,
        disconnect() {
          this.connected = false;
        },
      };
    };
    latest.subscribeFeeds = async () => ({ ok: true });
    return latest;
  }
  const adapter = createBreezeData(
    { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
    Mock,
  );
  await adapter.connect();
  await adapter.subscribe({}, () => {});
  adapter.disconnect();
  await adapter.connect();
  await adapter.subscribe({}, () => {});
  assert.equal(connects, 2);
  assert.equal(latest.socket.connected, true);
  adapter.disconnect();
});
test("restart recovery requeues interrupted jobs", async (t) => {
  const { store, owner, request } = await fixture(t);
  await owner();
  const {
    data: { id },
  } = await request("/api/strategies", "POST", strategy);
  await request(`/api/strategies/${id}/run`, "POST", {});
  await store.transaction((query) => query("UPDATE jobs SET status='running'"));
  await recoverInterruptedPaperJobs(store);
  assert.equal(await processNextPaperJob(store), true);
});
test("synthetic results deterministic and no unfunded fills", () => {
  assert.deepEqual(
    simulateSyntheticStrategy("NIFTY", 100000, 9, 21),
    simulateSyntheticStrategy("NIFTY", 100000, 9, 21),
  );
  assert.deepEqual(simulateSyntheticStrategy("SENSEX", 1000, 9, 21).trades, []);
});
test("Breeze wrapper has no order interface and redacts SDK errors", async () => {
  class Fake {
    async generateSession() {}
    async getHistoricalDatav2() {
      return { Status: 200, Success: [{ close: 42 }] };
    }
  }
  const adapter = createBreezeData(
    { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
    Fake,
  );
  assert.equal(adapter.placeOrder, undefined);
  await assert.rejects(adapter.historical({}), /Connect/);
  await adapter.connect();
  assert.deepEqual(await adapter.historical({}), [{ close: 42 }]);
  adapter.disconnect();
  class Failed {
    async generateSession() {
      throw new Error("SECRET");
    }
  }
  const failed = createBreezeData(
    { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
    Failed,
  );
  await assert.rejects(
    failed.connect(),
    (error) => !error.message.includes("SECRET"),
  );
});
test("real SDK keeps TLS enabled and patched HTTP/CSV/ZIP dependencies load", async () => {
  const Client = loadBreeze();
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
  const require = createRequire(import.meta.url);
  const axios = require("axios");
  const previous = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => ({
    data: { Status: 200, Success: [{ close: 42 }] },
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  });
  try {
    const sdk = new Client({ appKey: "fake" });
    const result = await sdk.getHistoricalDatav2({
      interval: "1minute",
      fromDate: "2026-09-01T09:15:00.000Z",
      toDate: "2026-09-01T09:16:00.000Z",
      stockCode: "RELIND",
      exchangeCode: "NSE",
      productType: "cash",
    });
    assert.equal(result.Status, 200);
    assert.equal(
      require("csv-parse/sync").parse("a,b\n1,2", { columns: true })[0].a,
      "1",
    );
    const Zip = require("adm-zip"),
      zip = new Zip();
    zip.addFile("test.csv", Buffer.from("a,b"));
    assert.equal(
      new Zip(zip.toBuffer()).getEntry("test.csv").getData().toString(),
      "a,b",
    );
  } finally {
    axios.defaults.adapter = previous;
  }
});
