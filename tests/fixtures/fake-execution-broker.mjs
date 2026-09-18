/** Offline execution adapter: in-memory books and deterministic failures, with NO SDK,
 * HTTP client, socket, credentials or network calls. Used only by live-foundation tests.
 */
import { DefinitiveOrderRejection } from "../../dist/backend/live/contracts.js";

export class FakeExecutionBroker {
  constructor(binding = "fake-broker-account") {
    this.accountBinding = binding;
    this.orders = [];
    this.intents = new Map();
    this.quotes = new Map();
    this.placeCalls = 0;
    this.cancelCalls = [];
    this.behavior = "open";
    this.healthy = true;
    this.complete = true;
    this.unavailable = false;
    this.cancelFails = false;
    this.cashAdjustment = 0;
    this.extraPositions = {};
  }
  /** Accept/reject before returning; timeout variants deliberately leave the outcome ambiguous. */
  async placeOrder(intent, signal) {
    this.placeCalls++;
    if (signal.aborted) {
      throw new Error("aborted before dispatch");
    }
    if (this.behavior === "reject") {
      throw new DefinitiveOrderRejection("definitively rejected");
    }
    if (this.behavior === "timeout_without_order") {
      return new Promise(() => {});
    }
    const order = {
      brokerOrderId: `fake-${this.placeCalls}`,
      clientOrderKey: intent.key,
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      status: "open",
      filledQuantity: 0,
      cashDeltaPaise: 0,
    };
    this.intents.set(order.brokerOrderId, structuredClone(intent));
    this.orders.push(order);
    if (!this.quotes.has(intent.instrument)) {
      this.quotes.set(intent.instrument, intent.limitPaise);
    }
    if (this.behavior === "filled") {
      this.fill(order.brokerOrderId, intent.quantity);
    }
    if (this.behavior === "partial") {
      this.fill(
        order.brokerOrderId,
        Math.max(1, Math.floor(intent.quantity / 2)),
      );
    }
    if (this.behavior === "accept_then_timeout") {
      return new Promise(() => {});
    }
    return structuredClone(order);
  }
  /** Apply a cumulative fill and its cash movement to the fake book. */
  fill(id, quantity) {
    const order = this.orders.find((order) => order.brokerOrderId === id),
      intent = this.intents.get(id);
    order.filledQuantity = quantity;
    order.status = quantity === order.quantity ? "filled" : "partially_filled";
    order.cashDeltaPaise =
      (order.side === "buy" ? -1 : 1) * quantity * intent.limitPaise;
  }
  /** A successful cancel changes the fake book, but OMS still needs a later snapshot to know. */
  async cancelOrder(id) {
    this.cancelCalls.push(id);
    if (this.cancelFails) {
      throw new Error("cancel unavailable");
    }
    const order = this.orders.find((order) => order.brokerOrderId === id);
    if (order && !["filled", "cancelled", "rejected"].includes(order.status)) {
      order.status = "cancelled";
    }
  }
  /** Produce complete normalized cash/order/position state without any network operation. */
  async getSnapshot() {
    if (this.unavailable) {
      throw new Error("session unavailable");
    }
    const positions = { ...this.extraPositions };
    let cashBalancePaise = 1000000 + this.cashAdjustment,
      reserved = 0;
    for (const order of this.orders) {
      positions[order.instrument] =
        (positions[order.instrument] || 0) +
        (order.side === "buy" ? 1 : -1) * order.filledQuantity;
      cashBalancePaise += order.cashDeltaPaise;
      if (!["filled", "cancelled", "rejected"].includes(order.status)) {
        reserved +=
          (order.quantity - order.filledQuantity) *
          this.intents.get(order.brokerOrderId).limitPaise;
      }
    }
    return {
      capturedAt: Date.now(),
      sessionHealthy: this.healthy,
      complete: this.complete,
      orders: structuredClone(this.orders),
      positions,
      availablePaise: Math.max(0, cashBalancePaise - reserved),
      cashBalancePaise,
      grossExposurePaise: Object.entries(positions).reduce(
        (sum, [symbol, quantity]) =>
          sum + Math.abs(quantity) * (this.quotes.get(symbol) || 1000),
        0,
      ),
      dailyPnlPaise: this.dailyPnlPaise || 0,
    };
  }
  /** Return a controlled executable-side quote for the spread slippage tests. */
  async getQuote(instrument) {
    return {
      pricePaise: this.quotes.get(instrument) || 1000,
      observedAt: Date.now(),
    };
  }
}
