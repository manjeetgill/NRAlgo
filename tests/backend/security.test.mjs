/** Offline regressions for connection revocation and production credential boundaries. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrokerManager } from "../../dist/backend/brokers.js";
import { KotakDataManager } from "../../dist/backend/kotak-data.js";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";
import { TOTP } from "otpauth";

function deferredConnection() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const connection = { closed: false, call: () => promise, snapshot: () => ({ state: "connected" }), close() { this.closed = true; } };
  return { connection, resolve, reject };
}
test("incomplete or revoked ICICI connections never become available", async (t) => {
  const pending = deferredConnection();
  const manager = new BrokerManager(() => pending.connection);
  t.after(() => manager.close());
  const attempt = manager.connect("owner", {}, Date.now() + 60000);
  assert.equal(manager.get("owner"), null);
  manager.disconnect("owner");
  pending.resolve();
  await assert.rejects(attempt);
  assert.equal(manager.get("owner"), null);
  assert.equal(pending.connection.closed, true);
});
test("failure from an old connection cannot remove its replacement", async (t) => {
  const first = deferredConnection(), second = deferredConnection();
  let calls = 0;
  const manager = new BrokerManager(() => (++calls === 1 ? first : second).connection);
  t.after(() => manager.close());
  const old = manager.connect("owner", {}, Date.now() + 60000);
  const oldRejected = assert.rejects(old);
  const current = manager.connect("owner", {}, Date.now() + 60000);
  second.resolve();
  await current;
  first.reject(new Error("late failure"));
  await oldRejected;
  assert.equal(manager.get("owner"), second.connection);
  assert.equal(second.connection.closed, false);
});
test("shutdown rejects new ICICI logins without creating worker threads", async () => {
  let calls = 0;
  const manager = new BrokerManager(() => { calls++; throw new Error("must not run"); });
  manager.close();
  await assert.rejects(manager.connect("owner", {}, Date.now() + 60000));
  assert.equal(calls, 0);
});
test("ICICI handshake completing after app-session expiry is discarded", async (t) => {
  const realNow = Date.now, pending = deferredConnection();
  let now = realNow();
  Date.now = () => now;
  const manager = new BrokerManager(() => pending.connection);
  t.after(() => { Date.now = realNow; manager.close(); });
  const attempt = manager.connect("owner", {}, now + 1000);
  now += 1001;
  pending.resolve();
  await assert.rejects(attempt);
  assert.equal(manager.get("owner"), null);
});
test("Kotak handshake completing after app-session expiry discards tokens", async (t) => {
  const realNow = Date.now;
  let now = realNow(), count = 0;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const manager = new KotakDataManager(async () => {
    if (++count === 2) now += 2000;
    return { data: { status: "success", kType: count === 1 ? "View" : "Trade", token: "offline-token", sid: "offline-sid", baseUrl: "https://cis.kotaksecurities.com" } };
  });
  t.after(() => manager.close());
  await assert.rejects(manager.connect("owner", "session", now + 1000, {
    accessToken: "offline-access", mobileNumber: "+919999999999", ucc: "offline", totp: "123456", mpin: "123456",
  }));
  assert.equal(manager.connected("owner", "session"), false);
});
test("MFA enrollment and removal disconnect both data brokers", async (t) => {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const revoked = [];
  const broker = { disconnect: id => revoked.push(["icici", id]), close() {} };
  const kotak = { disconnect: id => revoked.push(["kotak", id]), close() {} };
  const app = createApiApplication(store, { BROKER_ENCRYPTION_KEY: "ab".repeat(32) }, broker, undefined, undefined, kotak);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise(resolve => server.close(resolve));
    await store.close();
  });
  let cookie = "", csrf = "";
  const password = "offline-password-long";
  async function post(path, body) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + path, {
      method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json();
    if (data.csrf) csrf = data.csrf;
    assert.equal(response.status, 200, path);
    return data;
  }
  await post("/api/auth/setup", { username: "security-owner", password });
  const setup = await post("/api/auth/mfa/setup", { password });
  const confirmed = await post("/api/auth/mfa/confirm", { token: new TOTP({ secret: setup.secret }).generate() });
  assert.deepEqual(revoked.map(entry => entry[0]), ["icici", "kotak"]);
  await post("/api/auth/mfa/disable", { password, token: confirmed.recovery_codes[0] });
  assert.deepEqual(revoked.map(entry => entry[0]), ["icici", "kotak", "icici", "kotak"]);
});
