/** Offline read-only transport tests: no broker connection or execution is allowed. */
import assert from "node:assert/strict";
import test from "node:test";
import { loadLiveOrders } from "../../frontend/src/features/orders/live-orders-api";

test("live orders use only the OMS GET and preserve broker filled quantities", /** Never substitute research jobs or virtual-account fills for live records. */ async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method?: string }[] = [];
  const payload = {
    enabled: true,
    orders: [
      {
        id: "intent-1",
        state: "PARTIALLY_FILLED",
        intent: {
          instrument: "nse_cm:123",
          side: "buy",
          quantity: 5,
          limitPaise: 12500,
        },
        brokerOrder: { brokerOrderId: "broker-1", filledQuantity: 2 },
      },
    ],
  };
  /** Capture the transport boundary without any external requests. */
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    assert.deepEqual(await loadLiveOrders(), payload);
    assert.deepEqual(calls, [{ url: "/api/live/status", method: "GET" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disabled execution does not invent an empty order history", /** Missing history is distinct from a successfully loaded empty book. */ async () => {
  const originalFetch = globalThis.fetch;
  /** Return the server's disabled status without synthesizing an orders array. */
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ enabled: false, reason: "Live execution disabled" }),
    );
  try {
    assert.equal((await loadLiveOrders()).orders, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed order reads surface errors without retries or a fallback ledger", /** A network/API error cannot be interpreted as no orders. */ async () => {
  const originalFetch = globalThis.fetch;
  let count = 0;
  /** Fail deterministically and record whether any retry was attempted. */
  globalThis.fetch = async () => {
    count++;
    return new Response(JSON.stringify({ detail: "Broker unavailable" }), {
      status: 503,
    });
  };
  try {
    await assert.rejects(loadLiveOrders(), /Broker unavailable/);
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
