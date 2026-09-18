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
} from "../../dist/backend/database.js";
import { fileURLToPath } from "node:url";
import { createApiApplication } from "../../dist/backend/main.js";
import { hashPasswordForLegacyCompatibility } from "../fixtures/legacy-password.mjs";
import {
  processNextPaperJob,
  recoverInterruptedPaperJobs,
  refreshWorkerLease,
} from "../../dist/backend/worker.js";
import { credentialVault } from "../../dist/backend/security.js";
import { simulateSyntheticStrategy } from "../../dist/backend/simulator.js";
import { TOTP } from "otpauth";
import { createPostgresTestStore } from "../helpers/postgres.mjs";

const creds = { username: "testowner", password: "test-password-long" };
test("compiled backend retains the original workspace path", () => {
  assert.equal(root, fileURLToPath(new URL("../../", import.meta.url)));
});
test("production cannot fall back to a local database", () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    assert.throws(() => openDatabaseStore(""), /PostgreSQL/);
    assert.throws(() => openDatabaseStore("sqlite://:memory:"), /PostgreSQL/);
  } finally {
    if (previous === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = previous;
    }
  }
  assert.throws(() => openDatabaseStore("https://example.com"), /PostgreSQL/);
});
/** Start an isolated HTTP API with independent cookie jars; always release sockets and stores. */
async function fixture(t, env = {}, options = {}) {
  const store = await createPostgresTestStore();
  if (options.seed) {
    await options.seed(store);
  }
  await runDatabaseMigrations(store, {});
  const app = createApiApplication(store, {
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
    ...env,
  });
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
      if (setCookie) {
        cookie = setCookie.split(";")[0];
      }
      const data = await response.json();
      if (data.csrf) {
        csrf = data.csrf;
      }
      return { status: response.status, data, headers: response.headers };
    };
  };
  const request = client();
  t.after(async () => {
    await app.locals.shutdown();
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
/** Seed legacy rows only inside an isolated test schema; no runtime enqueue capability exists. */
async function seedLegacyJob(store, strategyId) {
  await store.transaction(async (query) => {
    const [saved] = await query("SELECT user_id FROM strategies WHERE id=$1", [
      strategyId,
    ]);
    await query("UPDATE strategies SET status='queued' WHERE id=$1", [
      strategyId,
    ]);
    const stamp = new Date().toISOString();
    await query(
      "INSERT INTO jobs (id,strategy_id,status,result,created_at,updated_at,user_id) VALUES ($1,$2,'queued','{}',$3,$3,$4)",
      [crypto.randomUUID(), strategyId, stamp, saved.user_id],
    );
  });
}

const strategy = {
  name: "Momentum test",
  symbol: "NIFTY",
  capital: 100000,
  fast: 9,
  slow: 21,
};

test("MFA status reads do not consume the strict proof-attempt budget", async (t) => {
  const { request, owner } = await fixture(t);
  await owner();
  for (let index = 0; index < 12; index++) {
    assert.equal((await request("/api/auth/mfa")).status, 200);
  }
  for (let index = 0; index < 10; index++) {
    assert.equal(
      (await request("/api/auth/mfa/confirm", "POST", { token: "000000" }))
        .status,
      409,
    );
  }
  assert.equal(
    (await request("/api/auth/mfa/confirm", "POST", { token: "000000" }))
      .status,
    429,
  );
  assert.equal((await request("/api/auth/mfa")).status, 200);
});

test("session inventory is opaque, owner-scoped and revokes only another owned session", async (t) => {
  const { request, owner, client } = await fixture(t);
  await owner();
  const other = client();
  assert.equal((await other("/api/auth/login", "POST", creds)).status, 200);
  const inventory = await request("/api/auth/sessions");
  assert.equal(inventory.status, 200);
  assert.equal(inventory.data.sessions.length, 2);
  assert.doesNotMatch(JSON.stringify(inventory.data), /token_hash|csrf|cookie/);
  const current = inventory.data.sessions.find((session) => session.current);
  const target = inventory.data.sessions.find((session) => !session.current);
  const outsider = client();
  await outsider("/api/auth/register", "POST", {
    username: "outsider",
    password: "outsider-password-long",
  });
  assert.equal(
    (await outsider("/api/auth/sessions/revoke", "POST", { id: target.id }))
      .status,
    404,
  );
  assert.equal(
    (await request("/api/auth/sessions/revoke", "POST", { id: current.id }))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/auth/sessions/revoke",
        "POST",
        { id: target.id },
        { "x-csrf-token": "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/sessions/revoke", "POST", { id: "a".repeat(64) }))
      .status,
    404,
  );
  assert.equal(
    (await request("/api/auth/sessions/revoke", "POST", { id: target.id }))
      .status,
    200,
  );
  assert.equal((await other("/api/workspace")).status, 401);
  assert.equal((await request("/api/workspace")).status, 200);
});

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
test("retired replay API cannot enqueue generated prices; legacy records remain readable", async (t) => {
  const { request, owner, store } = await fixture(t);
  await owner();
  const {
    data: { id },
  } = await request("/api/strategies", "POST", strategy);
  assert.equal(
    (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    410,
  );
  assert.equal((await request("/api/workspace")).data.jobs.length, 0);
  await seedLegacyJob(store, id);
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
  await seedLegacyJob(store, id);
  await request("/api/controls", "POST", { halted: true });
  assert.equal(await processNextPaperJob(store), false);
  assert.equal(
    (await request("/api/workspace")).data.jobs[0].status,
    "cancelled",
  );
  assert.equal(
    (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    410,
  );
  await request("/api/controls", "POST", { halted: false });
  assert.equal(
    (await request(`/api/strategies/${id}/run`, "POST", {})).status,
    410,
  );
});
test("login throttles by source and username, not by victim account", async (t) => {
  const { request, owner } = await fixture(t);
  await owner();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          ...creds,
          password: "wrong-password-long",
        })
      ).status,
      401,
    );
  }
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
  ]) {
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
  }
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
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (
        await request("/api/auth/login", "POST", {
          username: "nobody",
          password: "incorrect-password",
        })
      ).status,
      401,
    );
  }
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
    410,
  );
  await seedLegacyJob(store, a.data.id);
  await seedLegacyJob(store, b.data.id);
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
test("readiness is independent of retired workers; legacy leases still fence stale processing", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await request("/api/ready")).status, 200);
  await refreshWorkerLease(store, "worker-a");
  assert.equal((await request("/api/ready")).status, 200);
  await assert.rejects(refreshWorkerLease(store, "worker-b"), /Another worker/);
  await store.transaction((query) =>
    query("UPDATE worker_health SET heartbeat=0"),
  );
  assert.equal((await request("/api/ready")).status, 200);
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
      await request("/api/paper/kotak/connect", "POST", {
        accessToken: "fake-kotak-token",
        mobileNumber: "+919999999999",
        ucc: "FAKE",
        totp: "123456",
        mpin: "123456",
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
test("restart recovery requeues interrupted jobs", async (t) => {
  const { store, owner, request } = await fixture(t);
  await owner();
  const {
    data: { id },
  } = await request("/api/strategies", "POST", strategy);
  await seedLegacyJob(store, id);
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

test("NODE_ENV production enforces HTTPS, setup proof, MFA policy and secure cookies", async (t) => {
  assert.throws(
    () =>
      createApiApplication(
        {},
        {
          NODE_ENV: "production",
          APP_ENV: "development",
          BROKER_ENCRYPTION_KEY: "ab".repeat(32),
        },
      ),
    /HTTPS origin/,
  );
  assert.throws(
    () => credentialVault({ NODE_ENV: "production", APP_ENV: "development" }),
    /BROKER_ENCRYPTION_KEY/,
  );
  const setupToken = "n".repeat(40);
  const { request } = await fixture(t, {
    NODE_ENV: "production",
    APP_ORIGIN: "https://example.com",
    SETUP_TOKEN: setupToken,
  });
  const created = await request("/api/auth/setup", "POST", {
    ...creds,
    setup_token: setupToken,
  });
  assert.equal(created.status, 200);
  assert.match(created.headers.get("set-cookie"), /Secure/);
  assert.equal(
    (await request("/api/auth/status")).data.registration_enabled,
    false,
  );
  assert.equal(
    (
      await request("/api/paper/kotak/connect", "POST", {
        accessToken: "fake-kotak-token",
        mobileNumber: "+919999999999",
        ucc: "FAKE",
        totp: "123456",
        mpin: "123456",
      })
    ).status,
    403,
  );
});

test("concurrent fresh migrations retain exactly one complete schema version history", async (t) => {
  const store = await createPostgresTestStore();
  t.after(() => store.close());
  await Promise.all(
    Array.from({ length: 4 }, () => runDatabaseMigrations(store, {})),
  );
  assert.deepEqual(
    (
      await store.transaction((query) =>
        query("SELECT version FROM schema_migrations ORDER BY version"),
      )
    ).map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    await store.transaction((query) => query("SELECT * FROM paper_accounts")),
    [],
  );
});
