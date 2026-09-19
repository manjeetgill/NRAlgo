/** Disposable database + HTTP route checks; no broker credentials or live orders. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import express from "express";
import pg from "pg";
import {
  openDatabaseStore,
  runDatabaseMigrations,
} from "../backend/database.ts";
import { readLocalPostgresConfiguration } from "../backend/local-database.ts";
import { registerWatchlistRoutes } from "../backend/watchlist-routes.ts";
const config = readLocalPostgresConfiguration();
assert(config);
const admin = new pg.Client({ connectionString: config.adminUrl });
const name = `watchlist_verify_${randomBytes(6).toString("hex")}`;
await admin.connect();
await admin.query(`CREATE DATABASE ${name}`);
const url = new URL(config.adminUrl);
url.pathname = `/${name}`;
const db = openDatabaseStore(url.href);
let server;
try {
  await runDatabaseMigrations(db);
  await runDatabaseMigrations(db);
  await db.transaction(async (q) => {
    for (const owner of ["one", "two"]) {
      await q(
        "INSERT INTO users(id,username,password_hash) VALUES($1,$1,'test-only')",
        [owner],
      );
      await q("INSERT INTO user_settings(user_id,halted) VALUES($1,true)", [
        owner,
      ]);
    }
  });
  const catalog = [
    { id: "index:nifty", symbol: "NIFTY", name: "Nifty 50", kind: "index" },
    {
      id: "index:bank",
      symbol: "BANKNIFTY",
      name: "Nifty Bank",
      kind: "index",
    },
    { id: "equity:sbin", symbol: "SBIN", name: "State Bank", kind: "equity" },
  ];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.session = { user_id: req.headers["x-test-owner"] || "one" };
    next();
  });
  registerWatchlistRoutes(app, db, {
    searchInstruments: async () => catalog,
    readInstrument: async (id) => catalog.find((item) => item.id === id),
  });
  app.use((err, req, res, _next) =>
    res
      .status(err.status || (err.name === "ZodError" ? 422 : 500))
      .json({ error: "Rejected" }),
  );
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  async function call(path = "", method = "GET", body, owner = "one") {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/watchlists${path}`,
      {
        method,
        headers: { "Content-Type": "application/json", "x-test-owner": owner },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: response.status, data: await response.json() };
  }
  const first = (await call()).data.lists[0];
  assert.deepEqual(
    first.items.map((item) => item.symbol),
    ["NIFTY", "BANKNIFTY"],
  );
  assert.equal((await call()).data.lists.length, 1);
  const created = await call("", "POST", { name: "My stocks" });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal(
    (await call(`/${id}/items`, "POST", { instrumentId: "equity:sbin" }))
      .status,
    200,
  );
  await call(`/${id}/items`, "POST", { instrumentId: "equity:sbin" });
  assert.equal(
    (await call()).data.lists.find((list) => list.id === id).items.length,
    1,
  );
  assert.equal(
    (await call(`/${id}/items`, "POST", { instrumentId: "fake" })).status,
    404,
  );
  assert.equal(
    (await call(`/${id}/items`, "POST", { instrumentId: "index:nifty" }, "two"))
      .status,
    404,
  );
  assert.equal((await call(`/${id}`, "DELETE", undefined, "two")).status, 404);
  assert.equal((await call(`/${first.id}`, "DELETE")).status, 409);
  await call(`/${id}/items`, "DELETE", { id: "equity:sbin", symbol: "SBIN" });
  assert.equal(
    (await call()).data.lists.find((list) => list.id === id).items.length,
    0,
  );
  assert.equal((await call(`/${id}`, "DELETE")).status, 200);
  assert.equal((await call()).data.lists.length, 1);
  assert.equal((await call("", "POST", { name: " " })).status, 422);
  for (let i = 0; i < 9; i++) {
    assert.equal((await call("", "POST", { name: `List ${i}` })).status, 201);
  }
  assert.equal((await call("", "POST", { name: "Overflow" })).status, 409);
  console.debug(
    "PASS: defaults, persistence, create/add/remove/delete, deduplication, validation, owner isolation, list limit and migration replay",
  );
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.close();
  await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
}
