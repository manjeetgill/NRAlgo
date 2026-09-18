/** Client history scope/transport contracts; isolated fixtures are not selectable application data. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  fetchMarketHistory,
  historyDay,
  historyRequestFor,
  validateHistoryDataset,
  type HistoryDataset,
} from "../../frontend/src/lib/market-history";

const instrument = {
  instrument: "123",
  masterToken: "123",
  symbol: "TEST",
  name: "TEST",
  market: "options" as const,
  lotSize: 25,
  option: {
    expiryDate: "2026-09-24",
    strikePrice: 25000,
    right: "call" as const,
    lotSize: 25,
  },
};
const request = historyRequestFor(
  instrument,
  "2026-09-01",
  "2026-09-02",
  "5minute",
);
/** Copy a complete provider payload for tests that mutate only the field being rejected. */
function dataset(): HistoryDataset {
  return {
    source: "fixture",
    instrument,
    request: { ...request },
    fetchedAt: "2026-09-18T06:00:00Z",
    adjustmentPolicy: "unknown",
    coverage: "fixture",
    candles: [
      {
        timestamp: "2026-09-01T03:45:00Z",
        open: 100,
        high: 105,
        low: 99,
        close: 101,
        volume: null,
        openInterest: null,
      },
    ],
  };
}
test("history request binds full option identity and IST dates rather than browser timezone", () => {
  assert.deepEqual(request, {
    market: "options",
    stockCode: "TEST",
    instrument: "123",
    expiryDate: "2026-09-24",
    right: "call",
    strikePrice: 25000,
    from: "2026-09-01",
    to: "2026-09-02",
    interval: "5minute",
  });
  assert.equal(historyDay(0, Date.parse("2026-09-17T19:00:00Z")), "2026-09-18");
  assert.equal(
    historyDay(-1, Date.parse("2026-09-17T19:00:00Z")),
    "2026-09-17",
  );
});
test("history response rejects wrong identity/range/interval and malformed or unordered prices", () => {
  assert.doesNotThrow(() => validateHistoryDataset(dataset(), request));
  for (const patch of [
    { instrument: "999" },
    { interval: "day" },
    { expiryDate: "2026-10-29" },
    { from: "2026-08-01" },
  ]) {
    const data = dataset();
    Object.assign(data.request, patch);
    assert.throws(() => validateHistoryDataset(data, request), /match/);
  }
  for (const patch of [
    { high: 98 },
    { open: NaN },
    { timestamp: "bad" },
    { timestamp: "2026-09-03T03:45:00Z" },
  ]) {
    const data = dataset();
    Object.assign(data.candles[0], patch);
    assert.throws(() => validateHistoryDataset(data, request), /invalid/);
  }
  const duplicate = dataset();
  duplicate.candles.push({ ...duplicate.candles[0] });
  assert.throws(() => validateHistoryDataset(duplicate, request), /unordered/);
  const empty = dataset();
  empty.candles = [];
  assert.throws(() => validateHistoryDataset(empty, request));
});
test("history uses one same-origin CSRF-protected provider request, propagating cancellation", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "/api/market/history");
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(
      (init?.headers as Record<string, string>)["X-CSRF-Token"],
      "test-csrf",
    );
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("Cancelled", "AbortError");
  };
  await assert.rejects(
    fetchMarketHistory(request, "test-csrf", controller.signal),
    /Cancelled/,
  );
  assert.equal(calls, 1);
});
test("research has no upload workflow and charts retain cancellation, lazy loading and explicit history reload", () => {
  const screen = readFileSync(
    "src/features/backtest-studio/backtest-studio-screen.tsx",
    "utf8",
  );
  assert.doesNotMatch(screen, /type="file"|selectFile|Upload daily CSV/);
  assert.match(screen, /Load broker history/);
  const hook = readFileSync(
    "src/features/option-chain/use-contract-history.ts",
    "utf8",
  );
  assert.match(hook, /JSON.stringify\(request\)/);
  assert.match(hook, /controller.abort\(\)/);
  assert.doesNotMatch(hook, /setInterval|setTimeout/);
  const chart = readFileSync(
    "src/features/option-chain/contract-price-chart.tsx",
    "utf8",
  );
  assert.match(chart, /instance.remove\(\)/);
  assert.match(chart, /attributionLogo: true/);
  assert.match(chart, /createPriceLine/);
  const chain = readFileSync("src/components/live-option-chain.tsx", "utf8");
  assert.match(chain, /ssr: false/);
  assert.match(chain, /showChart &&/);
});
