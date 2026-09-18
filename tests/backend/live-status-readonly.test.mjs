/** Verify GET status cannot initialize the execution control plane or mutate permissions. */
import assert from "node:assert/strict";
import test from "node:test";
import { KotakLiveManager } from "../../dist/backend/live/kotak-live-manager.js";

test("cold live status performs only owner-scoped durable reads", async () => {
  const calls = [];
  const session = {
    user_id: "owner-1",
    token_hash: "session-1",
    expires: Date.now() / 1000 + 100,
  };
  const store = {
    /** Any write, account lock or broker dispatch makes this regression fail. */
    async transaction(work) {
      return work(async (sql, values) => {
        calls.push({ sql, values });
        assert.match(sql, /^SELECT /);
        assert.doesNotMatch(sql, /FOR UPDATE/);
        if (sql.includes("FROM live_accounts")) {
          assert.deepEqual(values, [session.user_id, "kotak:test-account"]);
          return [{ id: "account-1", limits: "{}", snapshot: "" }];
        }
        assert.deepEqual(values, ["account-1"]);
        return [];
      });
    },
  };
  const client = {
    /** Status may check the already-authenticated binding but cannot obtain broker data. */
    executionSession(user, token) {
      assert.equal(user, session.user_id);
      assert.equal(token, session.token_hash);
      return {
        accountBinding: "kotak:test-account",
        isCurrent: () => true,
        request: () => {
          throw new Error("Broker I/O forbidden");
        },
      };
    },
  };
  const manager = new KotakLiveManager(
    store,
    client,
    {},
    { LIVE_TRADING_ENABLED: "true", KOTAK_STATIC_IP_CONFIRMED: "true" },
    {},
  );
  const status = await manager.status(session);
  assert.equal(status.armed, false);
  assert.equal(status.halted, true);
  assert.equal(status.accountId, "account-1");
  assert.deepEqual(status.orders, []);
  assert.equal(calls.length, 2);
  // Closing a read-only manager must have no started entries, timers or cancellation work.
  await manager.close();
  assert.equal(calls.length, 2);
});
