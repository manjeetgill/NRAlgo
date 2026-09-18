/** Network-free ICICI response fixture, shaped like the official SDK envelopes.
 * All keys, account bindings and order IDs are fake. This never constructs a real SDK worker.
 */
export class FakeIciciRpc {
  constructor() {
    this.orders = [];
    this.calls = [];
    this.placementCalls = 0;
    this.cancelCalls = 0;
    this.losePlacementResponse = false;
    this.binding = `icici:${"ab".repeat(32)}`;
  }
  /** Return deterministic broker-shaped cash books and quotes; record mutations locally only. */
  async call(method, params) {
    this.calls.push({ method, params });
    const ok = (Success) => ({ Status: 200, Error: null, Success });
    if (method === "connect") return { binding: this.binding };
    if (method === "getOrderList")
      return ok(
        params.exchangeCode === "NFO" ? [] : structuredClone(this.orders),
      );
    if (method === "getTradeList" || method === "getPortfolioPositions")
      return ok([]);
    const blocked = this.orders
      .filter((order) => order.status === "Ordered")
      .reduce(
        (sum, order) => sum + Number(order.quantity) * Number(order.price),
        0,
      );
    if (method === "getFunds")
      return ok({
        allocated_equity: 10000,
        block_by_trade_equity: blocked,
        bank_account: "MUST-NOT-REACH-UI",
      });
    if (method === "getMargin")
      return ok({
        cash_limit: 10000 - blocked,
        amount_allocated: 10000,
        block_by_trade: blocked,
      });
    if (method === "getQuotes")
      return ok([
        {
          ltt: (() => {
            const now = new Date(Date.now() + 19800000);
            return `${String(now.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][now.getUTCMonth()]}-${now.getUTCFullYear()} ${now.toISOString().slice(11, 19)}`;
          })(),
          exchange_code: "NSE",
          stock_code: params.stockCode,
          best_offer_price: 10,
          best_bid_price: 10,
        },
      ]);
    if (method === "placeOrder") {
      this.placementCalls++;
      const order_id = `FAKE${this.placementCalls}`;
      this.orders.push({
        order_id,
        user_remark: params.userRemark,
        exchange_code: "NSE",
        product_type: "Cash",
        stock_code: params.stockCode,
        action: params.action,
        quantity: params.quantity,
        pending_quantity: params.quantity,
        cancelled_quantity: "0",
        status: "Ordered",
        price: params.price,
      });
      return this.losePlacementResponse ? undefined : ok({ order_id });
    }
    if (method === "cancelOrder") {
      this.cancelCalls++;
      const order = this.orders.find(
        (order) => order.order_id === params.orderId,
      );
      if (order) {
        order.status = "Cancelled";
        order.cancelled_quantity = order.quantity;
        order.pending_quantity = "0";
      }
      return ok({ order_id: params.orderId });
    }
    throw new Error(`Unexpected mocked method ${method}`);
  }
  /** No resources or sockets exist in this fixture. */
  close() {}
}
