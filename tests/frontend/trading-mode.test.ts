/** Offline regressions for workspace presentation and selected-account API isolation. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  getTradingMode,
  isTradingPageVisible,
  isTradingEventVisible,
} from "../../frontend/src/lib/trading-mode";
import { loadOverviewSnapshot } from "../../frontend/src/features/overview/load-overview-snapshot";
import type {
  AccountSnapshot,
  BrokerAccountAdapter,
} from "../../frontend/src/features/overview/overview-types";

/** Produce a known empty account without contacting any provider. */
function snapshot(mode: "live" | "paper"): AccountSnapshot {
  return {
    mode,
    availableFunds: 100,
    pnl: 0,
    positions: [],
    capturedAt: 1000,
    warnings: [],
  };
}

/** Record exactly which broker capabilities the selected mode invokes. */
function fakeAdapter(connected = true) {
  const calls: string[] = [];
  const adapter: BrokerAccountAdapter = {
    id: "test",
    name: "Test broker",
    /** Only broker authentication is read by the live path. */
    async loadConnectionStatus() {
      calls.push("status");
      return connected;
    },
    /** A simulated ledger may only be read in the explicitly enabled mode. */
    async loadPaperAccount() {
      calls.push("paper");
      return { connected, snapshot: snapshot("paper") };
    },
    /** No execution methods exist on this read-only fake. */
    async loadLiveAccount() {
      calls.push("live");
      return snapshot("live");
    },
    /** Streaming must not start implicitly while reading an empty book. */
    async startPositionFeed() {
      calls.push("subscribe");
    },
    /** Cache polling is separate from snapshot selection. */
    async readPriceTicks() {
      calls.push("ticks");
      return [];
    },
  };
  return { adapter, calls };
}

test("paper requires explicit true; absent/invalid settings select live-only", /** Do not interpret strings or missing configuration as permission to display virtual accounts. */ () => {
  assert.equal(getTradingMode(true), "paper");
  for (const value of [false, undefined, null, "true", "false", 1]) {
    assert.equal(getTradingMode(value), "live");
  }
});

test("live navigation excludes only paper trading and retains shared tools", /** Gate the wallet, not the strategy/research or live-order workflows. */ () => {
  assert.equal(isTradingPageVisible("Broker paper", "live"), false);
  assert.equal(isTradingPageVisible("Broker paper", "paper"), true);
  for (const page of [
    "Strategies",
    "Strategy lab",
    "Orders & trades",
    "Learn the stack",
  ]) {
    assert.equal(isTradingPageVisible(page, "live"), true);
    assert.equal(isTradingPageVisible(page, "paper"), true);
  }
  for (const page of [
    "Overview",
    "Brokers",
    "Account & security",
    "Activity log",
  ]) {
    assert.equal(isTradingPageVisible(page, "live"), true);
  }
  assert.equal(isTradingPageVisible("Live trading", "paper"), false);
});

test("live snapshots never read or initialize a paper wallet", /** Only status and live account reads are allowed, even with a connected broker. */ async () => {
  const { adapter, calls } = fakeAdapter();
  const result = await loadOverviewSnapshot(adapter, "test-csrf", "live");
  assert.equal(result.snapshot?.mode, "live");
  assert.deepEqual(calls, ["status", "live"]);
});

test("disconnected live account stays unknown rather than falling back to virtual funds", /** A disconnected broker cannot borrow the simulator's balance. */ async () => {
  const { adapter, calls } = fakeAdapter(false);
  assert.deepEqual(await loadOverviewSnapshot(adapter, "test-csrf", "live"), {
    connected: false,
    snapshot: null,
  });
  assert.deepEqual(calls, ["status"]);
});

test("paper mode reads only its ledger", /** Preserve the true-setting workflow without mixing in live funds or subscriptions. */ async () => {
  const { adapter, calls } = fakeAdapter();
  const result = await loadOverviewSnapshot(adapter, "test-csrf", "paper");
  assert.equal(result.snapshot?.mode, "paper");
  assert.deepEqual(calls, ["paper"]);
});

test("live activity hides paper account messages but retains research, security and broker events", /** Filtering is presentational and leaves the paper-mode audit intact. */ () => {
  for (const message of [
    "Private paper workspace initialized.",
    "Simulated fill recorded.",
  ]) {
    assert.equal(isTradingEventVisible(message, "live"), false);
    assert.equal(isTradingEventVisible(message, "paper"), true);
  }
  assert.equal(isTradingEventVisible("MFA enabled.", "live"), true);
  assert.equal(
    isTradingEventVisible(
      "Saved a research strategy (no execution enabled).",
      "live",
    ),
    true,
  );
  assert.equal(isTradingEventVisible("Replay completed.", "live"), true);
  assert.equal(isTradingEventVisible("Live order acknowledged.", "live"), true);
});
