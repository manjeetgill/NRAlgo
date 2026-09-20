import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBrokerProgress,
  LiveExecutionService,
} from "../backend/live/execution.ts";
import { withBrokerDeadline } from "../backend/live/contracts.ts";
import { intent, order } from "./fixtures.mjs";

for (const scenario of [
  "missing account",
  "wrong binding",
  "wrong broker",
  "halted account",
  "denied authorization",
]) {
  test(`submission gate blocks ${scenario} before dispatch or state mutation`, async () => {
    let dispatches = 0;
    const queries = [];
    const account = {
      broker_binding: scenario === "wrong binding" ? "foreign" : "fixture",
      broker_id: scenario === "wrong broker" ? "other" : "broker",
      halted: scenario === "halted account",
    };
    const store = {
      transaction: async (callback) =>
        callback(async (sql, params) => {
          queries.push(sql);
          if (sql.includes("FROM live_accounts")) {
            assert.deepEqual(params, ["account", "owner"]);
            return scenario === "missing account" ? [] : [account];
          }
          if (sql.includes("FROM live_orders")) {
            return [{ id: "order", state: "reserved", broker_id: "broker" }];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
    };
    const adapter = {
      accountBinding: "fixture",
      placeOrder: async () => {
        dispatches++;
      },
    };
    const service = new LiveExecutionService(
      store,
      "owner",
      "account",
      adapter,
      100,
      async () => {
        if (scenario === "denied authorization") {
          throw new Error("Not authorized");
        }
      },
      "broker",
    );
    await assert.rejects(
      service.submitReservedOrder("order"),
      /unavailable|halted|Not authorized/,
    );
    assert.equal(dispatches, 0);
    assert.equal(
      queries.some((sql) => /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql)),
      false,
    );
  });
}

// Independent specification: all 36 pairs, including forbidden terminal resurrection.
const allowed = {
  acknowledged: [
    "acknowledged",
    "open",
    "partially_filled",
    "filled",
    "cancelled",
    "rejected",
  ],
  open: ["open", "partially_filled", "filled", "cancelled", "rejected"],
  partially_filled: ["partially_filled", "filled", "cancelled"],
  filled: ["filled"],
  cancelled: ["cancelled"],
  rejected: ["rejected"],
};
const filled = (state) =>
  state === "filled" ? 10 : state === "partially_filled" ? 4 : 0;
for (const from of Object.keys(allowed)) {
  for (const to of Object.keys(allowed)) {
    test(`order transition ${from} -> ${to}`, () => {
      const current = order(from, filled(from));
      const next = order(to, to === "cancelled" ? filled(from) : filled(to));
      const validate = () => validateBrokerProgress(intent, current, next);
      if (allowed[from].includes(to)) {
        assert.doesNotThrow(validate);
      } else {
        assert.throws(validate);
      }
    });
  }
}
for (const [field, value] of Object.entries({
  brokerOrderId: "different",
  clientOrderKey: "foreign",
  instrument: "other",
  side: "sell",
  quantity: 11,
})) {
  test(`reject changed ${field}`, () =>
    assert.throws(() =>
      validateBrokerProgress(intent, order(), { ...order(), [field]: value }),
    ));
}
for (const [status, quantity] of [
  ["filled", 9],
  ["rejected", 1],
  ["open", 1],
  ["acknowledged", 1],
  ["partially_filled", 0],
  ["partially_filled", 10],
  ["cancelled", 11],
]) {
  test(`reject inconsistent ${status} with ${quantity} fills`, () =>
    assert.throws(() =>
      validateBrokerProgress(intent, undefined, order(status, quantity)),
    ));
}
test("cumulative fills never decrease, including after cancellation", () => {
  assert.throws(() =>
    validateBrokerProgress(
      intent,
      order("partially_filled", 5),
      order("partially_filled", 4),
    ),
  );
  assert.throws(() =>
    validateBrokerProgress(
      intent,
      order("cancelled", 5),
      order("cancelled", 4),
    ),
  );
});
test("deadline aborts one stalled call without retry", async () => {
  let calls = 0,
    signal;
  await assert.rejects(
    withBrokerDeadline((s) => {
      calls++;
      signal = s;
      return new Promise(() => {});
    }, 10),
    /deadline/,
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});
