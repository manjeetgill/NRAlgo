/** Offline quote packet, SDK transport and stream lifecycle regressions.
 * Real SDK signing is tested only with an intercepted transport; no broker connection is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  decodeResearchTick,
  ResearchStreamCache,
} from "../dist/backend/research-stream.js";
import {
  createBreezeData,
  loadBreeze,
  requestNfoOptionChain,
} from "../dist/backend/breeze.js";
import { normalizeOptionChain } from "../dist/backend/strategy-lab.js";

/** Build the pinned SDK's NSE quote packet; field 19/21 is an epoch, not a local date string. */
function packet(token = "4.1!101", market = "cash", time = Date.now()) {
  const raw = Array(market === "cash" ? 21 : 23).fill(0);
  raw[0] = token;
  raw[2] = 100;
  raw[6] = 99;
  raw[8] = 101;
  raw[market === "cash" ? 19 : 21] = Math.floor(time / 1000);
  return raw;
}
test("stream decoding accepts only the expected token and cash/options packet layout", () => {
  const now = Date.now();
  const quote = decodeResearchTick(
    packet("4.1!101", "cash", now),
    "4.1!101",
    "cash",
    "TEST",
    now,
  );
  assert.equal(quote.price, 100);
  assert.equal(quote.stale, false);
  assert.equal(quote.observedAt, Math.floor(now / 1000) * 1000);
  assert.equal(decodeResearchTick(packet(), "4.1!999", "cash", "TEST"), null);
  assert.equal(
    decodeResearchTick(packet(), "4.1!101", "options", "TEST"),
    null,
  );
  assert.equal(
    decodeResearchTick(packet("4.2!101"), "4.2!101", "cash", "TEST"),
    null,
  );
  const future = packet("4.1!101", "cash", now + 60000);
  assert.equal(
    decodeResearchTick(future, "4.1!101", "cash", "TEST", now),
    null,
  );
  const malformed = packet();
  malformed[6] = 999;
  assert.equal(decodeResearchTick(malformed, "4.1!101", "cash", "TEST"), null);
});
test("multi-leg cache cannot reuse another leg, accept time regression, or keep stale prices after reconnect", () => {
  const now = Date.now(),
    cache = new ResearchStreamCache("stream", "strategy", ["ONE", "TWO"]);
  const quote = decodeResearchTick(packet(), "4.1!101", "cash", "ONE", now);
  cache.accept(0, quote);
  assert.equal(cache.snapshot(now).quotes[1].stale, true);
  cache.accept(1, quote);
  assert.equal(cache.snapshot(now).quotes[1].observedAt, null);
  cache.accept(0, {
    ...quote,
    observedAt: quote.observedAt - 1000,
    price: 999,
  });
  assert.equal(cache.snapshot(now).quotes[0].price, 100);
  assert.equal(cache.snapshot(now + 31000).quotes[0].stale, true);
  cache.invalidate("disconnected");
  assert.equal(cache.snapshot(now).quotes[0].observedAt, null);
  cache.invalidate("waiting");
  assert.equal(cache.snapshot(now).state, "waiting");
});
test("abandoned feed expires even if market ticks continue to arrive", () => {
  const cache = new ResearchStreamCache("stream", "strategy", ["TEST"]);
  cache.heartbeat(1000);
  cache.accept(0, decodeResearchTick(packet(), "4.1!101", "cash", "TEST"));
  assert.equal(cache.leaseExpired(46000), false);
  assert.equal(cache.leaseExpired(46001), true);
  cache.heartbeat(46001);
  assert.equal(cache.leaseExpired(46001), false);
});
test("SDK basket uses one raw listener, rejoins exact tokens, and removes listeners on stop", async () => {
  let instance;
  class FakeSocket extends EventEmitter {
    joins = [];
    disconnected = false;
    emit(event, value) {
      if (event === "join") this.joins.push(value);
      return super.emit(event, value);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  class FakeSdk {
    constructor() {
      instance = this;
    }
    async generateSession() {}
    getStockTokenValue(params) {
      return {
        exch_quote_token: params.stockCode === "ONE" ? "4.1!101" : "4.1!102",
      };
    }
    wsConnect() {
      this.socket = new FakeSocket();
    }
  }
  const adapter = createBreezeData(
      { apiKey: "fake", apiSecret: "fake", sessionToken: "fake" },
      FakeSdk,
    ),
    received = [],
    states = [];
  await adapter.connect();
  await adapter.subscribeBasket(
    [
      { stockCode: "ONE", productType: "cash" },
      { stockCode: "TWO", productType: "options" },
    ],
    (index, quote) => received.push({ index, quote }),
    (state) => states.push(state),
  );
  const socket = instance.socket;
  assert.equal(socket.listenerCount("stock"), 1);
  assert.deepEqual(socket.joins, ["4.1!101", "4.1!102"]);
  socket.emit("stock", packet("4.1!102", "options"));
  assert.equal(received.length, 1);
  assert.equal(received[0].index, 1);
  assert.equal(received[0].quote.stockCode, "TWO");
  socket.emit("stock", packet("4.1!999"));
  assert.equal(received.length, 1);
  socket.emit("disconnect");
  assert.equal(states.at(-1), "disconnected");
  socket.emit("connect");
  assert.equal(states.at(-1), "waiting");
  assert.equal(socket.listenerCount("stock"), 1);
  assert.equal(socket.joins.length, 4);
  adapter.stopStreaming();
  assert.equal(socket.disconnected, true);
  assert.equal(socket.listenerCount("stock"), 0);
  adapter.disconnect();
});
test("pinned SDK option-chain bug is bypassed by one fixed read-only signed request", async () => {
  const Real = loadBreeze(),
    sdk = new Real({ appKey: "fake-key" });
  sdk.secretKey = "fake-secret";
  sdk.apiSession = "fake-session";
  const requests = [];
  sdk.makeRequest = async (method, endpoint, body, headers) => {
    requests.push({ method, endpoint, body, headers });
    return { data: { Status: 200, Error: null, Success: [] } };
  };
  const params = {
    stockCode: "NIFTY",
    exchangeCode: "NFO",
    productType: "options",
    expiryDate: "2030-01-31T00:00:00.000Z",
    right: "call",
  };
  assert.equal((await sdk.getOptionChainQuotes(params)).Status, 500);
  assert.equal(requests.length, 0);
  assert.equal((await requestNfoOptionChain(sdk, params)).Status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].endpoint, "optionchain");
  assert.ok(requests[0].headers["X-Checksum"]);
  await assert.rejects(
    requestNfoOptionChain(sdk, { ...params, exchangeCode: "NSE" }),
  );
  assert.equal(requests.length, 1);
});
test("chain parser rejects wrong expiry/type, duplicates and truncation, while keeping stale contracts selectable for research", () => {
  const row = {
    stock_code: "NIFTY",
    exchange_code: "NFO",
    expiry_date: "31-Jan-2030",
    right: "Call",
    strike_price: 24000,
    ltp: 0,
    best_bid_price: 0,
    best_offer_price: 0,
    ltt: "",
    open_interest: 0,
    total_quantity_traded: 0,
  };
  assert.equal(
    normalizeOptionChain([row], "NIFTY", "2030-01-31", "call")[0].stale,
    true,
  );
  assert.throws(
    () => normalizeOptionChain([row, row], "NIFTY", "2030-01-31", "call"),
    /duplicate/,
  );
  assert.throws(
    () => normalizeOptionChain([row], "NIFTY", "2030-01-31", "put"),
    /contract/,
  );
  assert.throws(
    () =>
      normalizeOptionChain(
        Array(1000).fill(row),
        "NIFTY",
        "2030-01-31",
        "call",
      ),
    /truncated/,
  );
});
