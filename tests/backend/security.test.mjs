/** Offline regressions for connection revocation and production credential boundaries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { KotakMarketDataClient } from "../../dist/backend/kotak-market-data-client.js";
import { createApiApplication } from "../../dist/backend/main.js";
import {
  provisionBackupRole,
  runDatabaseMigrations,
} from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { passwordHash } from "../../dist/backend/security.js";
import { TOTP } from "otpauth";

test("Kotak handshake completing after app-session expiry discards tokens", async (t) => {
  const realNow = Date.now;
  let now = realNow(),
    count = 0;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  const manager = new KotakMarketDataClient(async () => {
    if (++count === 2) {
      now += 2000;
    }
    return {
      data: {
        status: "success",
        kType: count === 1 ? "View" : "Trade",
        token: "offline-token",
        sid: "offline-sid",
        baseUrl: "https://cis.kotaksecurities.com",
      },
    };
  });
  t.after(() => manager.close());
  await assert.rejects(
    manager.connect("owner", "session", now + 1000, {
      accessToken: "offline-access",
      mobileNumber: "+919999999999",
      ucc: "offline",
      totp: "123456",
      mpin: "123456",
    }),
  );
  assert.equal(manager.isConnected("owner", "session"), false);
});
test("MFA enrollment and removal disconnect Kotak data", async (t) => {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const revoked = [];
  const kotak = { disconnect: (id) => revoked.push(["kotak", id]), close() {} };
  const app = createApiApplication(
    store,
    { BROKER_ENCRYPTION_KEY: "ab".repeat(32) },
    kotak,
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  let cookie = "",
    csrf = "";
  const password = "offline-password-long";
  async function post(path, body) {
    const response = await fetch(
      "http://127.0.0.1:" + server.address().port + path,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (response.headers.get("set-cookie")) {
      cookie = response.headers.get("set-cookie").split(";")[0];
    }
    const data = await response.json();
    if (data.csrf) {
      csrf = data.csrf;
    }
    assert.equal(response.status, 200, path);
    return data;
  }
  await post("/api/auth/setup", { username: "security-owner", password });
  const setup = await post("/api/auth/mfa/setup", { password });
  const confirmed = await post("/api/auth/mfa/confirm", {
    token: new TOTP({ secret: setup.secret }).generate(),
  });
  assert.deepEqual(
    revoked.map((entry) => entry[0]),
    ["kotak"],
  );
  await post("/api/auth/mfa/disable", {
    password,
    token: confirmed.recovery_codes[0],
  });
  assert.deepEqual(
    revoked.map((entry) => entry[0]),
    ["kotak", "kotak"],
  );
});

test("password hashing rejects overflow and releases capacity when native work completes", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      passwordHash("offline-concurrency-password"),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    4,
  );
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((result) => result.reason.status === 429));
  assert.match(
    await passwordHash("offline-after-pressure"),
    /^[a-f0-9]{32}:[a-f0-9]{128}$/,
  );
});

test("backup provisioning validates passwords before SQL and grants only read access", async () => {
  const sql = [];
  const store = {
    transaction: async (fn) =>
      fn(async (statement) => {
        sql.push(statement);
        return [];
      }),
  };
  await assert.rejects(provisionBackupRole(store, "bad'password"));
  assert.equal(sql.length, 0);
  await provisionBackupRole(store, "ad".repeat(32));
  assert.ok(sql.some((s) => s.includes("NOBYPASSRLS")));
  assert.ok(
    sql.some(
      (s) =>
        s === "GRANT SELECT ON ALL TABLES IN SCHEMA public TO nexus_backup",
    ),
  );
  assert.ok(sql.some((s) => s.includes("ALTER DEFAULT PRIVILEGES")));
  assert.ok(
    sql
      .filter((s) => s.includes("GRANT"))
      .every((s) => !/INSERT|UPDATE|DELETE|ALL PRIVILEGES/.test(s)),
  );
});
test("missing and malformed session cookies never access the database", async (t) => {
  let queries = 0;
  const store = {
    transaction: async (fn) => {
      queries++;
      return fn(async () => []);
    },
  };
  const app = createApiApplication(store, {
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
  });
  queries = 0; // Startup performs its own live-permission cleanup query.
  for (const cookie of [
    "",
    "nexus_session=bad",
    "nexus_session=" + "a".repeat(65),
  ]) {
    const response = await fetch(
      "http://127.0.0.1:" + server.address().port + "/api/workspace",
      { headers: { Cookie: cookie } },
    );
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  }
  assert.equal(queries, 0);
});
