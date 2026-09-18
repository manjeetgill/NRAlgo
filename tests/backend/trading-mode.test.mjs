/** Runtime setting and authentication-only endpoint tests. Isolated PostgreSQL; no real broker login/orders. */
import assert from "node:assert/strict";
import test from "node:test";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";

/** Start a disposable API with an operator-supplied presentation setting and independent auth jar. */
async function createFixture(context, setting) {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const app = createApiApplication(store, {
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
    PAPER_TRADING_ENABLED: setting,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(
    /** Resolve only when the local fixture is listening. */ (resolve) =>
      server.once("listening", resolve),
  );
  let cookie = "";
  /** Perform local fixture HTTP only; no credential or order API on a real broker is called. */
  async function request(path, method = "GET", body) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (response.headers.get("set-cookie")) {
      cookie = response.headers.get("set-cookie").split(";")[0];
    }
    return { status: response.status, data: await response.json() };
  }
  context.after(
    /** Release the fixture's broker managers, HTTP server and isolated database. */ async () => {
      await app.locals.shutdown();
      await new Promise(
        /** Wait for local sockets to close before dropping the test schema. */ (
          resolve,
        ) => server.close(resolve),
      );
      await store.close();
    },
  );
  return { store, request };
}

for (const setting of [undefined, "false", "true"]) {
  test(`runtime presentation setting ${String(setting)} never enables live execution`, /** Verify both bootstrap and authenticated configuration without changing execution policy. */ async (context) => {
    const { store, request } = await createFixture(context, setting);
    assert.equal(
      (await request("/api/auth/status")).data.paper_trading_enabled,
      setting === "true",
    );
    assert.equal((await request("/api/brokers/kotak/status")).status, 401);
    assert.equal(
      (
        await request("/api/auth/setup", "POST", {
          username: "modeowner",
          password: "test-password-long",
        })
      ).status,
      200,
    );
    const workspace = await request("/api/workspace");
    assert.equal(workspace.data.paper_trading_enabled, setting === "true");
    assert.equal(workspace.data.live_configured, false);
    assert.deepEqual(await request("/api/brokers/kotak/status"), {
      status: 200,
      data: { connected: false },
    });
    const rows = await store.transaction(
      /** Read the isolated schema without touching application ledgers. */ (
        query,
      ) => query("SELECT COUNT(*)::int AS count FROM paper_accounts"),
    );
    assert.equal(
      rows[0].count,
      0,
      "broker status must not create a virtual wallet",
    );
  });
}
