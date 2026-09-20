import test from "node:test";
import assert from "node:assert/strict";
import { KotakLiveManager } from "../backend/live/kotak-live-manager.ts";
import { tradingDay } from "../backend/market-contracts.ts";
import {
  livePermissionDeadline,
  LIVE_SESSION_BUFFER_MS,
} from "../backend/live/session-window.ts";

const now = 1_000_000;
// Provider selection and deployment readiness are checked without connecting to any broker.
test("live manager keeps static-IP gates separate for Kotak and Zerodha", async () => {
  const manager = new KotakLiveManager(
    {},
    {},
    {},
    { LIVE_TRADING_ENABLED: "true", ZERODHA_STATIC_IP_CONFIRMED: "true" },
    {},
    {},
  );
  assert.equal(manager.executionBlocker("zerodha"), null);
  assert.match(manager.executionBlocker("kotak"), /static-IP/);
  assert.match(manager.executionBlocker("unknown"), /not implemented/);
  await manager.close();
});
test("live manager requires operator configuration before any provider can activate", () => {
  assert.throws(
    () =>
      new KotakLiveManager(
        {},
        {},
        {},
        { LIVE_TRADING_ENABLED: "true" },
        {},
        {},
      ),
    /static-IP/,
  );
});
test("closed market rejects enablement before broker access or MFA consumption", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-20T06:00:00Z"));
  const manager = Object.assign(Object.create(KotakLiveManager.prototype), {
    entry: () => assert.fail("closed market must not contact broker"),
  });
  await assert.rejects(manager.arm({}, "123456"), { status: 409 });
});
test("live permission is capped at five minutes", () => {
  assert.equal(
    livePermissionDeadline(now + 600_000, now + 600_000, now),
    now + 300_000,
  );
});
for (const source of ["app", "broker"]) {
  test(`${source} expiry caps permission with cancellation buffer`, () => {
    const expiries =
      source === "app"
        ? [now + 60_000, now + 600_000]
        : [now + 600_000, now + 60_000];
    assert.equal(
      livePermissionDeadline(...expiries, now),
      now + 60_000 - LIVE_SESSION_BUFFER_MS,
    );
  });
  for (const remaining of [
    -1,
    0,
    LIVE_SESSION_BUFFER_MS - 1,
    LIVE_SESSION_BUFFER_MS,
  ]) {
    test(`${source} session rejects ${remaining}ms remaining`, () => {
      const expiries =
        source === "app"
          ? [now + remaining, now + 600_000]
          : [now + 600_000, now + remaining];
      assert.throws(() => livePermissionDeadline(...expiries, now), {
        status: 409,
      });
    });
  }
}
for (const value of [
  undefined,
  NaN,
  Infinity,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`invalid expiry/clock fails closed: ${value}`, () => {
    assert.throws(() => livePermissionDeadline(value, now + 600_000, now));
    assert.throws(() => livePermissionDeadline(now + 600_000, value, now));
    if (value !== undefined) {
      assert.throws(() =>
        livePermissionDeadline(now + 600_000, now + 600_000, value),
      );
    }
  });
}

test("dispatch rejects an expiring broker before any DB work", async () => {
  const manager = Object.assign(Object.create(KotakLiveManager.prototype), {
    enabled: true,
    closed: false,
  });
  await assert.rejects(
    manager.authorize(() => assert.fail("must not query"), {
      session: { expires: Math.floor(Date.now() / 1000) + 600 },
      connection: { expiresAt: Date.now() + 1000, isCurrent: () => true },
    }),
    { status: 409 },
  );
});

test("dispatch checks the durable app session with the same expiry buffer", async () => {
  const manager = Object.assign(Object.create(KotakLiveManager.prototype), {
    enabled: true,
    closed: false,
  });
  const started = Date.now();
  let checkedSession = false;
  const query = async (sql, params) => {
    if (sql.includes("FROM live_permissions")) {
      return [
        { armed_until: started + 60_000, trading_day: tradingDay(started) },
      ];
    }
    assert.match(sql, /FROM sessions/);
    assert.ok(params[2] >= (started + LIVE_SESSION_BUFFER_MS) / 1000);
    checkedSession = true;
    return [];
  };
  await assert.rejects(
    manager.authorize(query, {
      id: "fixture",
      permissionKey: "fixture",
      session: {
        expires: Math.floor(started / 1000) + 600,
        token_hash: "fixture",
        user_id: "fixture",
      },
      connection: { expiresAt: started + 600_000, isCurrent: () => true },
    }),
    { status: 409 },
  );
  assert.equal(checkedSession, true);
});
