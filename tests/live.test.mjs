/** Real PostgreSQL plus a network-free broker double. These tests cannot reach a live account.
 * Test the LIVE core directly; the existing paper API/worker remains a separate code path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runDatabaseMigrations } from "../dist/backend/database.js";
import {
  createLiveAccount,
  LiveExecutionService,
} from "../dist/backend/live/execution.js";
import { planShadowOrder } from "../dist/backend/live/shadow.js";
import { createPostgresTestStore } from "./postgres-fixture.mjs";
import { FakeExecutionBroker } from "./fake-execution-broker.mjs";

const limits = {
  maxReservedPaise: 100000,
  maxGrossExposurePaise: 200000,
  maxPositionUnits: 100,
  maxDailyLossPaise: 10000,
  maxOrdersPerMinute: 10,
  fundsDriftTolerancePaise: 0,
};
const intent = (key = "one", quantity = 10) => ({
  key,
  instrument: "TEST",
  side: "buy",
  quantity,
  limitPaise: 1000,
});
/** Create a private test account, establish a flat broker baseline and explicitly resume. */
async function fixture(t, overrides = {}) {
  const store = await createPostgresTestStore();
  t.after(() => store.close());
  await runDatabaseMigrations(store, {});
  await store.transaction((query) =>
    query("INSERT INTO users VALUES('live-test','live-test','test-only-hash')"),
  );
  const broker = new FakeExecutionBroker();
  const accountId = await createLiveAccount(
    store,
    "live-test",
    broker.accountBinding,
    { ...limits, ...overrides },
  );
  const service = new LiveExecutionService(
    store,
    "live-test",
    accountId,
    broker,
    30,
  );
  assert.equal((await service.reconcile()).clean, true);
  await service.resumeAfterReconciliation();
  return { store, broker, service, accountId };
}
/** Make a two-leg plan whose policy cannot silently default to automatic liquidation. */
function spreadPlan() {
  return {
    hedge: { ...intent("unused"), instrument: "HEDGE" },
    exposure: { ...intent("unused"), instrument: "EXPOSURE", side: "sell" },
    maxSlippageBps: 20,
    legDeadlineMs: 30000,
    orphanPolicy: "cancel_and_require_manual_unwind",
  };
}

test("paper and shadow dependency paths cannot select real execution with a flag", async () => {
  for (const file of [
    "backend/worker.ts",
    "backend/simulator.ts",
    "backend/live/shadow.ts",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /from ["'][^"']*(execution|breeze|broker-thread)[^"']*["']/,
    );
  }
  const broker = new FakeExecutionBroker();
  const result = planShadowOrder(intent(), {
    snapshot: await broker.getSnapshot(),
    limits,
    reservedPaise: 0,
    outstandingUnits: {},
    ordersLastMinute: 0,
    now: Date.now(),
  });
  assert.equal(result.decision, "would_submit");
  assert.equal(broker.placeCalls, 0);
});

test("concurrent reservations cannot spend the same capital", async (t) => {
  const { service } = await fixture(t, { maxReservedPaise: 15000 });
  const attempts = await Promise.allSettled([
    service.reserveIntent(intent("a")),
    service.reserveIntent(intent("b")),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await service.status()).orders.length, 1);
});

test("duplicate intents and concurrent dispatches result in exactly one adapter call", async (t) => {
  const { service, broker } = await fixture(t);
  const order = await service.reserveIntent(intent());
  assert.equal((await service.reserveIntent(intent())).id, order.id);
  await assert.rejects(
    service.reserveIntent(intent("one", 11)),
    /different content/,
  );
  await Promise.all([
    service.submitReservedOrder(order.id),
    service.submitReservedOrder(order.id),
  ]);
  assert.equal(broker.placeCalls, 1);
});

test("accepted but timed-out submission stays unknown, never blindly retried", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "accept_then_timeout";
  const order = await service.reserveIntent(intent());
  assert.equal((await service.submitReservedOrder(order.id)).state, "unknown");
  assert.equal((await service.status()).halted, true);
  await service.submitReservedOrder(order.id);
  assert.equal(broker.placeCalls, 1);
  await service.reconcile();
  await service.reconcile();
  assert.equal((await service.status()).orders[0].state, "cancelled");
  assert.equal((await service.status()).halted, true);
  await service.resumeAfterReconciliation();
});

test("empty books cannot prove an unknown order was never accepted", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "timeout_without_order";
  const order = await service.reserveIntent(intent());
  await service.submitReservedOrder(order.id);
  assert.equal((await service.reconcile()).clean, false);
  assert.equal((await service.reconcile()).clean, false);
  await assert.rejects(
    service.resumeAfterReconciliation(),
    /reconciliation|Unresolved/,
  );
  await service.submitReservedOrder(order.id);
  assert.equal(broker.placeCalls, 1);
});

test("restart SUBMITTING marker is not requeued, and reconciliation locates accepted fills", async (t) => {
  const { service, broker, store, accountId } = await fixture(t);
  const order = await service.reserveIntent(intent());
  await store.transaction((query) =>
    query("UPDATE live_orders SET state='submitting' WHERE id=$1", [order.id]),
  );
  broker.behavior = "filled";
  await broker.placeOrder(intent(), new AbortController().signal);
  const restarted = new LiveExecutionService(
    store,
    "live-test",
    accountId,
    broker,
  );
  await restarted.haltAndCancel("restart");
  await restarted.reconcile();
  assert.equal((await restarted.status()).orders[0].state, "filled");
  await restarted.submitReservedOrder(order.id);
  assert.equal(broker.placeCalls, 1);
});

test("session expiry at final adapter gate blocks placement and latches a halt", async (t) => {
  const { service, broker } = await fixture(t);
  const order = await service.reserveIntent(intent());
  broker.healthy = false;
  assert.equal((await service.submitReservedOrder(order.id)).state, "blocked");
  assert.equal(broker.placeCalls, 0);
  assert.equal((await service.status()).halted, true);
  await assert.rejects(service.resumeAfterReconciliation(), /reconciliation/);
});

test("kill switch blocks reserved work and cancels broker rests without claiming confirmation", async (t) => {
  const { service, broker } = await fixture(t);
  const first = await service.reserveIntent(intent("first"));
  await service.submitReservedOrder(first.id);
  await service.reconcile();
  const second = await service.reserveIntent(intent("second"));
  const kill = await service.haltAndCancel();
  assert.equal(kill.cancellationConfirmed, false);
  assert.equal(broker.cancelCalls.length, 1);
  assert.equal((await service.submitReservedOrder(second.id)).state, "blocked");
  assert.equal(broker.placeCalls, 1);
  await assert.rejects(service.reserveIntent(intent("third")), /halted/);
  await service.reconcile();
  assert.equal((await service.status()).orders[0].state, "cancelled");
});

test("failed cancels remain unresolved and prevent resume", async (t) => {
  const { service, broker } = await fixture(t);
  const order = await service.reserveIntent(intent());
  await service.submitReservedOrder(order.id);
  broker.cancelFails = true;
  const killed = await service.haltAndCancel();
  assert.ok(killed.unresolved.length);
  await service.reconcile();
  await assert.rejects(service.resumeAfterReconciliation(), /Unresolved/);
});

test("position or cash drift remains halted across repeated polls, not silently adopted", async (t) => {
  const { service, broker } = await fixture(t);
  broker.extraPositions.TEST = 3;
  assert.equal((await service.reconcile()).clean, false);
  await assert.rejects(service.resumeAfterReconciliation(), /reconciliation/);
  assert.equal((await service.reconcile()).clean, false);
  broker.extraPositions = {};
  broker.cashAdjustment = 500;
  assert.match((await service.reconcile()).reason, /funds drift/);
  assert.match((await service.reconcile()).reason, /funds drift/);
});

test("post-trade loss limit halts and cancels resting orders", async (t) => {
  const { service, broker } = await fixture(t);
  const order = await service.reserveIntent(intent());
  await service.submitReservedOrder(order.id);
  broker.dailyPnlPaise = -10000;
  assert.match((await service.reconcile()).reason, /loss limit/);
  assert.ok(broker.cancelCalls.length);
  assert.equal((await service.status()).halted, true);
});

test("another tenant or mismatched adapter cannot access account or issue broker calls", async (t) => {
  const { store, broker, accountId } = await fixture(t);
  const other = new LiveExecutionService(
    store,
    "different-user",
    accountId,
    broker,
  );
  await assert.rejects(other.reconcile(), /unavailable/);
  await assert.rejects(other.haltAndCancel(), /unavailable/);
  const mismatched = new LiveExecutionService(
    store,
    "live-test",
    accountId,
    new FakeExecutionBroker("wrong-binding"),
  );
  await assert.rejects(mismatched.reserveIntent(intent()), /unavailable/);
  assert.equal(broker.placeCalls, 0);
  assert.equal(broker.cancelCalls.length, 0);
});

test("hedge-first spread never submits exposure after only a partial hedge fill", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "partial";
  const plan = await service.createHedgeFirstSpread(spreadPlan());
  assert.equal(await service.advanceHedgeFirstSpread(plan), "hedge_pending");
  await service.reconcile();
  await service.advanceHedgeFirstSpread(plan);
  assert.equal(broker.placeCalls, 1);
  assert.equal(broker.orders[0].instrument, "HEDGE");
});

test("second-leg slippage violation records orphan exposure and blocks resume", async (t) => {
  const { service, broker, store } = await fixture(t);
  broker.behavior = "filled";
  const plan = await service.createHedgeFirstSpread(spreadPlan());
  await service.advanceHedgeFirstSpread(plan);
  await service.reconcile();
  broker.quotes.set("EXPOSURE", 500);
  assert.equal(await service.advanceHedgeFirstSpread(plan), "unwind_required");
  assert.equal(broker.placeCalls, 1);
  const row = (
    await store.transaction((query) =>
      query("SELECT detail FROM live_spreads WHERE id=$1", [plan]),
    )
  )[0];
  assert.equal(JSON.parse(row.detail).knownFills[0].filledQuantity, 10);
  await assert.rejects(service.resumeAfterReconciliation(), /Unresolved/);
});

test("successful spread uses ordered full fills and repeated stepping cannot duplicate legs", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "filled";
  const plan = await service.createHedgeFirstSpread(spreadPlan());
  await service.advanceHedgeFirstSpread(plan);
  await service.reconcile();
  await service.advanceHedgeFirstSpread(plan);
  await service.reconcile();
  assert.equal(await service.advanceHedgeFirstSpread(plan), "complete");
  assert.equal(await service.advanceHedgeFirstSpread(plan), "complete");
  assert.deepEqual(
    broker.orders.map((order) => order.instrument),
    ["HEDGE", "EXPOSURE"],
  );
  assert.equal(broker.placeCalls, 2);
});

test("dispatch rechecks changed exposure even when the original reservation passed", async (t) => {
  const { service, broker } = await fixture(t, {
    maxGrossExposurePaise: 25000,
  });
  broker.behavior = "filled";
  const filled = await service.reserveIntent(intent("filled"));
  await service.submitReservedOrder(filled.id);
  await service.reconcile();
  const reserved = await service.reserveIntent(intent("reserved"));
  broker.quotes.set("TEST", 1800);
  assert.equal((await service.reconcile()).clean, true);
  assert.equal(
    (await service.submitReservedOrder(reserved.id)).state,
    "blocked",
  );
  assert.equal(broker.placeCalls, 1);
});

test("database write failure after broker acceptance preserves SUBMITTING for recovery", async (t) => {
  const { store, service, broker, accountId } = await fixture(t);
  broker.behavior = "filled";
  const order = await service.reserveIntent(intent());
  let failOnce = true;
  const faultyStore = {
    transaction: (callback) =>
      store.transaction((query) =>
        callback(async (sql, params) => {
          if (failOnce && sql.includes("SET state=$2,broker_order=$3")) {
            failOnce = false;
            await query("SELECT 1/0");
          }
          return query(sql, params);
        }),
      ),
    close: () => Promise.resolve(),
  };
  const faultyService = new LiveExecutionService(
    faultyStore,
    "live-test",
    accountId,
    broker,
  );
  await assert.rejects(faultyService.submitReservedOrder(order.id));
  assert.equal((await service.status()).orders[0].state, "submitting");
  assert.equal((await service.status()).halted, true);
  await service.reconcile();
  assert.equal((await service.status()).orders[0].state, "filled");
  await service.submitReservedOrder(order.id);
  assert.equal(broker.placeCalls, 1);
});

test("a late accepted order remains discoverable after an initial empty reconciliation", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "timeout_without_order";
  const reserved = await service.reserveIntent(intent());
  await service.submitReservedOrder(reserved.id);
  assert.equal((await service.reconcile()).clean, false);
  // Simulate the original timed-out network request appearing later; this is broker-side,
  // not an OMS retry. Reconciliation must find it and request cancellation while halted.
  broker.behavior = "open";
  await broker.placeOrder(intent(), new AbortController().signal);
  await service.reconcile();
  await service.reconcile();
  assert.equal((await service.status()).orders[0].state, "cancelled");
  assert.equal((await service.status()).halted, true);
});

test("incomplete books and stale reconciliation never authorize dispatch", async (t) => {
  const { service, broker, store, accountId } = await fixture(t);
  const order = await service.reserveIntent(intent());
  await store.transaction((query) =>
    query("UPDATE live_accounts SET reconciled_at=$2 WHERE id=$1", [
      accountId,
      Date.now() - 10000,
    ]),
  );
  assert.equal((await service.submitReservedOrder(order.id)).state, "blocked");
  assert.equal(broker.placeCalls, 0);
  broker.complete = false;
  assert.equal((await service.reconcile()).clean, false);
  await assert.rejects(service.resumeAfterReconciliation(), /reconciliation/);
});

test("partial second leg past deadline cancels remainder and records both known fills", async (t) => {
  const { service, broker, store } = await fixture(t);
  broker.behavior = "filled";
  const planId = await service.createHedgeFirstSpread(spreadPlan());
  await service.advanceHedgeFirstSpread(planId);
  await service.reconcile();
  broker.behavior = "partial";
  await service.advanceHedgeFirstSpread(planId);
  await service.reconcile();
  await store.transaction(async (query) => {
    const row = (
      await query("SELECT plan FROM live_spreads WHERE id=$1", [planId])
    )[0];
    const plan = JSON.parse(row.plan);
    plan.createdAt = Date.now() - 60000;
    await query("UPDATE live_spreads SET plan=$2 WHERE id=$1", [
      planId,
      JSON.stringify(plan),
    ]);
  });
  assert.equal(
    await service.advanceHedgeFirstSpread(planId),
    "unwind_required",
  );
  assert.equal(broker.orders[1].status, "cancelled");
  assert.equal(broker.placeCalls, 2);
  const row = (
    await store.transaction((query) =>
      query("SELECT detail FROM live_spreads WHERE id=$1", [planId]),
    )
  )[0];
  assert.equal(JSON.parse(row.detail).knownFills.length, 2);
});

test("shadow evaluation rejects stale data, rate/loss/position limits without dispatch", async () => {
  const broker = new FakeExecutionBroker();
  const snapshot = await broker.getSnapshot();
  const base = {
    snapshot,
    limits,
    reservedPaise: 0,
    outstandingUnits: {},
    ordersLastMinute: 0,
    now: Date.now(),
  };
  for (const context of [
    { ...base, ordersLastMinute: 10 },
    { ...base, snapshot: { ...snapshot, capturedAt: Date.now() - 10000 } },
    { ...base, snapshot: { ...snapshot, dailyPnlPaise: -10000 } },
    { ...base, outstandingUnits: { TEST: 100 } },
    { ...base, reservedPaise: NaN },
  ])
    assert.equal(planShadowOrder(intent(), context).decision, "rejected");
  assert.equal(broker.placeCalls, 0);
});

test("broker state regression and duplicate correlations halt instead of rewriting history", async (t) => {
  const { service, broker } = await fixture(t);
  broker.behavior = "filled";
  const order = await service.reserveIntent(intent());
  await service.submitReservedOrder(order.id);
  await service.reconcile();
  broker.orders[0].status = "open";
  assert.equal((await service.reconcile()).clean, false);
  assert.equal((await service.status()).orders[0].state, "filled");
  broker.orders[0].status = "filled";
  broker.orders.push(structuredClone(broker.orders[0]));
  assert.equal((await service.reconcile()).clean, false);
  assert.equal((await service.status()).halted, true);
});
