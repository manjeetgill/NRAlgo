/** Offline API admission regression. No broker is connected and no live permission is enabled. */
import assert from "node:assert/strict";
import test from "node:test";
import { createApiApplication } from "../../dist/backend/main.js";
import { runDatabaseMigrations } from "../../dist/backend/database.js";
import { createPostgresTestStore } from "../helpers/postgres.mjs";

test("exhausted workspace reads cannot consume the independent halt budget", async (t) => {
  const store = await createPostgresTestStore();
  await runDatabaseMigrations(store, {});
  const app = createApiApplication(store, {
    BROKER_ENCRYPTION_KEY: "ab".repeat(32),
  });
  const server = app.listen(0, "127.0.0.1");
  /** Wait for the local disposable server, not a deployed broker connection. */
  await new Promise((resolve) => server.once("listening", resolve));
  /** Dispose only this server and its randomly allocated test schema. */
  t.after(async () => {
    await app.locals.shutdown();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const setup = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "halt-test",
      password: "offline-test-password-123",
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const { csrf } = await setup.json();
  for (let i = 0; i < 181; i++) {
    const response = await fetch(`${base}/live/status`, {
      headers: { cookie },
    });
    await response.json();
    assert.equal(response.status, i < 180 ? 200 : 429);
  }
  const blocked = await fetch(`${base}/live/halt`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(blocked.status, 403, "halt still requires CSRF");
  const halt = await fetch(`${base}/live/halt`, {
    method: "POST",
    headers: {
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(
    halt.status,
    409,
    "the disabled live manager, not the exhausted normal limiter, handles halt",
  );
  assert.match((await halt.json()).detail, /disabled/);
});
