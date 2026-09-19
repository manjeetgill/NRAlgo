/** Isolated local PostgreSQL regression check; never calls real broker endpoints. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  openDatabaseStore,
  runDatabaseMigrations,
} from "../backend/database.ts";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";
import { credentialVault } from "../backend/security.ts";
import { BrokerSessionStore } from "../backend/broker-session-store.ts";
import { KotakMarketDataClient } from "../backend/kotak-market-data-client.ts";
import { createZerodhaConnection } from "../backend/zerodha-connection.ts";

const config = readLocalPostgresConfiguration();
assert(config, "Start local PostgreSQL first.");
const admin = new pg.Client({ connectionString: config.adminUrl });
const name = `broker_verify_${randomBytes(6).toString("hex")}`;
const url = new URL(config.adminUrl);
url.pathname = `/${name}`;
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const db = openDatabaseStore(url.href);
try {
  await runDatabaseMigrations(db);
  await runDatabaseMigrations(db);
  const owner = {
    user_id: "verification-user",
    token_hash: "a".repeat(64),
    expires: Math.floor(Date.now() / 1000) + 3600,
  };
  await db.transaction(async (q) => {
    await q(
      "INSERT INTO users(id,username,password_hash) VALUES($1,'verification-only','not-a-password')",
      [owner.user_id],
    );
    await q("INSERT INTO user_settings(user_id,halted) VALUES($1,true)", [
      owner.user_id,
    ]);
    await q(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES($1,$2,'test-only',$3)",
      [owner.token_hash, owner.user_id, owner.expires],
    );
  });
  const vault = credentialVault({ BROKER_ENCRYPTION_KEY: "12".repeat(32) });
  const saved = new BrokerSessionStore(db, vault);
  const payload = {
    sessionHash: owner.token_hash,
    expires: Date.now() + 1800000,
    accessToken: "test-api-token",
    token: "test-trade-token",
    sid: "test-sid",
    ucc: "TEST",
    baseUrl: "https://mis.kotaksecurities.com",
  };
  await saved.save(owner, "kotak", payload.expires, payload);
  const [encrypted] = await db.transaction((q) =>
    q("SELECT ciphertext FROM broker_sessions"),
  );
  assert(!encrypted.ciphertext.includes("test-api-token"));
  assert.deepEqual(
    (await new BrokerSessionStore(db, vault).load(owner, "kotak")).value,
    payload,
  );
  assert.equal(
    await saved.load({ ...owner, user_id: "another-user" }, "kotak"),
    null,
  );
  assert.equal(
    await saved.load({ ...owner, token_hash: "b".repeat(64) }, "kotak"),
    null,
  );
  assert.equal(await saved.load(owner, "zerodha"), null);
  console.debug(
    "PASS: migrations, encryption, restart read, owner/login/provider isolation",
  );

  let release;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const client = new KotakMarketDataClient(async () => response);
  const restoring = client.restoreSession(
    owner.user_id,
    owner.token_hash,
    payload.expires,
    payload,
  );
  assert.equal(client.isConnected(owner.user_id, owner.token_hash), false);
  release({ stat: "Ok", data: [] });
  await restoring;
  assert.equal(client.isConnected(owner.user_id, owner.token_hash), true);
  assert.equal(client.isConnected(owner.user_id, "wrong-login"), false);
  client.close();
  let unblock;
  const slow = new KotakMarketDataClient(
    () =>
      new Promise((resolve) => {
        unblock = resolve;
      }),
  );
  const pending = slow.restoreSession(
    owner.user_id,
    owner.token_hash,
    payload.expires,
    payload,
  );
  slow.disconnect(owner.user_id);
  unblock({ stat: "Ok", data: [] });
  await pending;
  assert.equal(slow.isConnected(owner.user_id, owner.token_hash), false);
  slow.close();
  const bad = new KotakMarketDataClient(async () => {
    throw new Error("simulated outage");
  });
  await assert.rejects(
    bad.restoreSession(
      owner.user_id,
      owner.token_hash,
      payload.expires,
      payload,
    ),
  );
  assert.equal(bad.isConnected(owner.user_id, owner.token_hash), false);
  bad.close();
  console.debug(
    "PASS: Kotak verified-before-publish, disconnect race and outage fail closed",
  );

  const sockets = [];
  const streaming = new KotakMarketDataClient(
    async () => ({ stat: "Ok", data: [] }),
    () => {
      const handlers = new Map();
      const socket = {
        addEventListener: (name, cb) => handlers.set(name, cb),
        send() {},
        close() {},
        emit: (name, value = {}) => handlers.get(name)?.(value),
      };
      sockets.push(socket);
      return socket;
    },
  );
  await streaming.restoreSession(
    owner.user_id,
    owner.token_hash,
    payload.expires,
    payload,
  );
  const subscription = {
    kind: "touchline",
    mode: "subscribe",
    instruments: [{ exchange: "nse_cm", instrument: "123" }],
  };
  streaming.startMarketDataStream(
    owner.user_id,
    owner.token_hash,
    subscription,
  );
  const originalNow = Date.now;
  let clock = Date.now();
  try {
    Date.now = () => clock;
    for (let i = 0; i < 8; i++) {
      sockets.at(-1).emit("error");
      streaming.getMarketDataStreamSnapshot(owner.user_id, owner.token_hash);
      clock += 31000;
      streaming.getMarketDataStreamSnapshot(owner.user_id, owner.token_hash);
    }
    assert.equal(sockets.length, 6, "only five automatic reconnects");
    streaming.startMarketDataStream(
      owner.user_id,
      owner.token_hash,
      subscription,
    );
    sockets
      .at(-1)
      .emit("message", { data: JSON.stringify({ message_code: 1120 }) });
    const count = sockets.length;
    clock += 60000;
    assert.equal(
      streaming.getMarketDataStreamSnapshot(owner.user_id, owner.token_hash)
        .state,
      "authentication-failed",
    );
    assert.equal(sockets.length, count, "no auth rejection retry");
  } finally {
    Date.now = originalNow;
    streaming.close();
  }
  console.debug(
    "PASS: bounded feed recovery and authentication rejection stops retries",
  );

  await saved.save(owner, "zerodha", payload.expires, {
    accessToken: "test-kite-token",
  });
  const kite = createZerodhaConnection(
    {},
    {
      restore: () => ({
        account: { user_id: "TEST", user_name: "Test" },
        verify: async () => {},
        revoke: async () => true,
      }),
    },
    undefined,
    saved,
  );
  await kite.restore(owner);
  assert(kite.isConnected(owner.user_id, owner.token_hash));
  kite.close();
  const rejectedKite = createZerodhaConnection(
    {},
    {
      restore: () => ({
        verify: async () => {
          throw new Error("expired");
        },
      }),
    },
    undefined,
    saved,
  );
  await assert.rejects(rejectedKite.restore(owner));
  assert.equal(
    rejectedKite.isConnected(owner.user_id, owner.token_hash),
    false,
  );
  rejectedKite.close();
  await saved.remove(owner.user_id, "kotak");
  assert.equal(await saved.load(owner, "kotak"), null);
  assert(await saved.load(owner, "zerodha"));
  await db.transaction((q) =>
    q("DELETE FROM sessions WHERE token_hash=$1", [owner.token_hash]),
  );
  assert.equal(await saved.load(owner, "zerodha"), null);
  assert.equal(
    (await db.transaction((q) => q("SELECT * FROM broker_sessions"))).length,
    0,
  );
  await assert.rejects(saved.save(owner, "kotak", payload.expires, payload));
  console.debug(
    "PASS: Zerodha verification, independent disconnect, logout cascade, late-save rejection",
  );
} finally {
  await db.close();
  // Only the randomly named, empty-before-this-run verification database is removed.
  await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
}
