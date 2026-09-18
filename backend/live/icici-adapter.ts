/** ICICI NSE cash adapter. Broker conventions are normalized here, not in the OMS.
 * Unknown fields/statuses or inconsistent books fail closed. This first release supports
 * same-day, long-only cash positions established through this app, not pre-existing holdings.
 */
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import type { BreezeCredentials } from "../breeze.js";
import {
  brokerSnapshotSchema,
  type BrokerOrder,
  type BrokerSnapshot,
  type ExecutionBrokerAdapter,
  type OrderIntent,
} from "./contracts.js";

type Row = Record<string, unknown>;
export interface IciciRpc {
  call(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): void;
}
export type IciciRpcFactory = (credentials: BreezeCredentials) => IciciRpc;
/** Serial worker RPC with per-request deadlines. Timeout/abort terminates the realm so an
 * old queued task cannot execute later. Broker acceptance may still have happened remotely.
 */
export class IciciExecutionConnection implements IciciRpc {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private pending: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  } | null = null;
  constructor(credentials: BreezeCredentials) {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../dist/backend/live/icici-thread.js"
          : "./icici-thread.js",
        import.meta.url,
      ),
      {
        workerData: credentials,
        execArgv: [],
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on("message", (message) => {
      const pending = this.pending;
      if (!pending || pending.id !== message.id) return;
      pending.cleanup();
      this.pending = null;
      if (message.error)
        pending.reject(
          new Error(
            "ICICI operation failed; verify broker state before retrying",
          ),
        );
      else pending.resolve(message.result);
    });
    this.worker.on("error", () => this.close());
    this.worker.on("exit", () => this.close());
  }
  /** Never auto-retry a command or return raw SDK exceptions. */
  call(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || this.pending || signal?.aborted)
      return Promise.reject(
        new Error("ICICI execution connection unavailable"),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.sequence,
        abort = () => this.close();
      const timer = setTimeout(abort, method === "connect" ? 90000 : 2500);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending = { id, resolve, reject, cleanup };
      signal?.addEventListener("abort", abort, { once: true });
      this.worker.postMessage({ id, method, params });
    });
  }
  /** Idempotent teardown rejects any in-flight RPC; it does not assert broker-side cancellation. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending?.cleanup();
    this.pending?.reject(
      new Error("ICICI connection ended; order outcome may be unknown"),
    );
    this.pending = null;
    void this.worker.terminate();
  }
}

/** Require a documented success envelope; missing/failed responses are never empty books. */
export function breezeSuccess(response: unknown): unknown {
  const value = response as Row;
  if (
    !value ||
    Number(value.Status) !== 200 ||
    value.Error ||
    value.Success == null
  )
    throw new Error("ICICI did not return a verified successful response");
  return value.Success;
}
/** Convert broker decimal rupees without silently accepting null, NaN or unsafe integers. */
function paise(value: unknown): number {
  if (
    !["number", "string"].includes(typeof value) ||
    String(value).trim() === ""
  )
    throw new Error("Missing broker money field");
  const amount = Number(value) * 100,
    rounded = Math.round(amount);
  if (
    !Number.isFinite(amount) ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(amount - rounded) > 0.001
  )
    throw new Error("Invalid broker money field");
  return rounded;
}
/** Require whole exchange units, accepting signed quantities only when explicitly requested. */
function units(value: unknown, signed = false): number {
  if (value == null || String(value).trim() === "")
    throw new Error("Missing broker quantity");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (!signed && n < 0))
    throw new Error("Invalid broker quantity");
  return n;
}
/** Arrays are bounded; reaching the cap is treated as potential truncation, never completeness. */
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length >= 500)
    throw new Error("Broker book is missing or may be truncated");
  return value as Row[];
}
/** Alphanumeric durable tag fits the broker remark restrictions. DB key uniqueness remains
 * authoritative: broker remarks help reconciliation but are NOT broker idempotency keys.
 */
export const iciciOrderTag = (key: string) =>
  `NR${createHash("sha256").update(key).digest("hex").slice(0, 28)}`;
export const iciciTradingDay = () =>
  new Date(Date.now() + 19800000).toISOString().slice(0, 10);
/** Breeze quote timestamps are exchange-local IST. Never label an old holiday/illiquid
 * quote fresh merely because the HTTP response arrived just now.
 */
function quoteTimestamp(value: unknown) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    String(value),
  );
  if (!match) throw new Error("Broker quote timestamp unavailable");
  const month = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(match[2].toLowerCase());
  if (month < 0) throw new Error("Invalid quote timestamp");
  const timestamp =
    Date.UTC(
      Number(match[3]),
      month,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ) - 19800000;
  if (Date.now() - timestamp > 60000 || timestamp > Date.now() + 1000)
    throw new Error("Broker quote is stale; no live preview is allowed");
  return timestamp;
}

/** Normalize a coherent cash snapshot. Allocated-minus-blocked cash is conservative capacity;
 * adding still-resting BUY holds gives the cash ledger used to reconcile executed cash flows.
 * If ICICI reports a different allocation/settlement model, reconciliation halts on mismatch
 * instead of manufacturing funds. No derivatives margin or sell-proceeds leverage is assumed.
 */
export function normalizeIciciSnapshot(
  input: {
    orders: unknown;
    derivativeOrders: unknown;
    trades: unknown;
    positions: unknown;
    funds: unknown;
    margin: unknown;
  },
  known: Map<string, string>,
): BrokerSnapshot {
  const rawOrders = rows(input.orders),
    trades = rows(input.trades),
    rawPositions = rows(input.positions);
  if (
    rows(input.derivativeOrders).some(
      (row) =>
        !["executed", "cancelled", "rejected", "expired"].includes(
          String(row.status).toLowerCase(),
        ),
    )
  )
    throw new Error("An unsupported derivative order is pending");
  const seen = new Set<string>(),
    orders: BrokerOrder[] = [];
  let restingBuyHold = 0,
    totalCashDelta = 0;
  for (const row of rawOrders) {
    if (
      row.exchange_code !== "NSE" ||
      String(row.product_type).toLowerCase() !== "cash"
    )
      throw new Error("Unsupported order in cash execution account");
    const id = String(row.order_id || "").trim(),
      tag = String(row.user_remark || "");
    if (!id || seen.has(id))
      throw new Error("Duplicate/missing broker order ID");
    seen.add(id);
    const key = known.get(tag) || `external:${id}`,
      quantity = units(row.quantity),
      pending = units(row.pending_quantity),
      cancelled = units(row.cancelled_quantity);
    const side = String(row.action).toLowerCase();
    if (side !== "buy" && side !== "sell")
      throw new Error("Unknown order side");
    const matched = trades.filter(
      (trade) => String(trade.order_id).trim() === id,
    );
    let filled = 0,
      cash = 0;
    for (const trade of matched) {
      if (
        trade.stock_code !== row.stock_code ||
        String(trade.action).toLowerCase() !== side ||
        trade.exchange_code !== "NSE"
      )
        throw new Error("Trade/order mismatch");
      const qty = units(trade.quantity);
      filled += qty;
      const cost = qty * paise(trade.average_cost),
        fees = paise(trade.brokerage_amount) + paise(trade.total_taxes);
      if (
        units(trade.eatm_withheld_amount) !== 0 ||
        units(trade.cash_withheld_amount) !== 0
      )
        throw new Error("Withheld settlements require manual verification");
      cash += (side === "buy" ? -cost : cost) - fees;
    }
    const statusText = String(row.status).toLowerCase();
    let status: BrokerOrder["status"];
    if (statusText === "executed") status = "filled";
    else if (["cancelled", "expired"].includes(statusText))
      status = "cancelled";
    else if (statusText === "rejected") status = "rejected";
    else if (
      [
        "ordered",
        "requested",
        "partially executed",
        "partially filled",
      ].includes(statusText)
    )
      status = filled ? "partially_filled" : "open";
    else throw new Error("Unknown ICICI order status");
    if (
      quantity <= 0 ||
      filled > quantity ||
      (filled + pending + cancelled !== quantity && status !== "rejected") ||
      (status === "filled" && filled !== quantity)
    )
      throw new Error("Order and trade books are not yet consistent");
    if (!["filled", "cancelled", "rejected"].includes(status) && side === "buy")
      restingBuyHold += pending * paise(row.price);
    totalCashDelta += cash;
    orders.push({
      brokerOrderId: id,
      clientOrderKey: key,
      instrument: `NSE:${row.stock_code}`,
      side,
      quantity,
      status,
      filledQuantity: filled,
      cashDeltaPaise: cash,
    });
  }
  if (trades.some((trade) => !seen.has(String(trade.order_id).trim())))
    throw new Error("Trade without a visible order");
  const positions: Record<string, number> = {};
  let gross = 0,
    markedPositionValue = 0;
  for (const row of rawPositions) {
    const qty = units(row.quantity, true);
    if (!qty) continue;
    if (
      row.exchange_code !== "NSE" ||
      String(row.product_type).toLowerCase() !== "cash"
    )
      throw new Error("Unsupported open position");
    const action = String(row.action).toLowerCase();
    if (!["buy", "sell"].includes(action))
      throw new Error("Unknown position direction");
    const signed = action === "sell" ? -Math.abs(qty) : qty,
      ltp = paise(row.ltp);
    if (ltp <= 0) throw new Error("Position mark unavailable");
    const symbol = `NSE:${row.stock_code}`;
    positions[symbol] = (positions[symbol] || 0) + signed;
    gross += Math.abs(signed) * ltp;
    markedPositionValue += signed * ltp;
  }
  const funds = input.funds as Row,
    margin = input.margin as Row;
  const allocated = paise(funds.allocated_equity),
    blocked = paise(funds.block_by_trade_equity);
  const available = Math.max(
    0,
    Math.min(
      allocated - blocked,
      paise(margin.cash_limit),
      paise(margin.amount_allocated) - paise(margin.block_by_trade),
    ),
  );
  return brokerSnapshotSchema.parse({
    capturedAt: Date.now(),
    sessionHealthy: true,
    complete: true,
    orders,
    positions,
    availablePaise: available,
    cashBalancePaise: allocated - blocked + restingBuyHold,
    grossExposurePaise: gross,
    dailyPnlPaise: totalCashDelta + markedPositionValue,
  });
}

/** Real adapter receives only server-decrypted credentials and a persistent request-budget hook.
 * Snapshot caching is at most one second and is invalidated after every attempted mutation.
 */
export class IciciCashAdapter implements ExecutionBrokerAdapter {
  accountBinding = "";
  private connection: IciciRpc;
  private cache: BrokerSnapshot | null = null;
  private known = new Map<string, string>();
  private connected = false;
  constructor(
    private readonly credentials: BreezeCredentials,
    private readonly charge: (cancel: boolean) => Promise<void>,
    factory: IciciRpcFactory = (creds) => new IciciExecutionConnection(creds),
  ) {
    this.connection = factory(credentials);
  }
  /** Authenticate in a private SDK realm; only a one-way account binding leaves the SDK worker. */
  async connect() {
    await this.charge(false);
    const response = (await this.connection.call("connect")) as {
      binding: string;
    };
    if (!/^icici:[a-f0-9]{64}$/.test(response?.binding))
      throw new Error("Broker identity unavailable");
    this.accountBinding = response.binding;
    this.connected = true;
  }
  /** Supply durable key/tag mappings before reconciliation; unknown tags stay external orders. */
  setKnownIntents(keys: string[]) {
    this.known = new Map(keys.map((key) => [iciciOrderTag(key), key]));
  }
  /** Count each authenticated REST call before dispatch, with separate cancellation headroom. */
  private async request(
    method: string,
    params?: unknown,
    signal?: AbortSignal,
    cancellationRecovery = false,
  ) {
    if (!this.connected) throw new Error("Connect ICICI live first");
    if (signal?.aborted) throw new Error("Request aborted");
    await this.charge(cancellationRecovery || method === "cancelOrder");
    if (signal?.aborted) throw new Error("Request aborted");
    return breezeSuccess(await this.connection.call(method, params, signal));
  }
  /** Read all account evidence serially to avoid the SDK's shared mutable request variables. */
  async getSnapshot(signal: AbortSignal) {
    if (this.cache && Date.now() - this.cache.capturedAt < 1000)
      return structuredClone(this.cache);
    const started = Date.now();
    const day = iciciTradingDay(),
      dates = {
        fromDate: `${day}T00:00:00.000Z`,
        toDate: `${day}T23:59:59.000Z`,
      };
    const orders = await this.request(
      "getOrderList",
      { ...dates, exchangeCode: "NSE" },
      signal,
    );
    const derivativeOrders = await this.request(
      "getOrderList",
      { ...dates, exchangeCode: "NFO" },
      signal,
    );
    const trades = await this.request(
      "getTradeList",
      { ...dates, exchangeCode: "NSE" },
      signal,
    );
    const positions = await this.request(
      "getPortfolioPositions",
      undefined,
      signal,
    );
    const funds = await this.request("getFunds", undefined, signal);
    const margin = await this.request("getMargin", "NSE", signal);
    this.cache = normalizeIciciSnapshot(
      { orders, derivativeOrders, trades, positions, funds, margin },
      this.known,
    );
    this.cache.capturedAt = started;
    return structuredClone(this.cache);
  }
  /** Send only a validated NSE cash DAY LIMIT. Long-only exits require a fresh owned position;
   * unknown broker responses throw, which the OMS records as UNKNOWN without resubmitting.
   */
  async placeOrder(
    intent: OrderIntent,
    signal: AbortSignal,
  ): Promise<BrokerOrder> {
    const match = /^NSE:([A-Z0-9 &_.-]{1,30})$/.exec(intent.instrument);
    if (!match) throw new Error("Only NSE cash is supported");
    if (
      intent.side === "sell" &&
      (!intent.reduceOnly ||
        !this.cache ||
        Date.now() - this.cache.capturedAt > 5000 ||
        (this.cache.positions[intent.instrument] || 0) < intent.quantity)
    )
      throw new Error(
        "Short selling and selling pre-existing holdings are disabled",
      );
    this.known.set(iciciOrderTag(intent.key), intent.key);
    this.cache = null;
    const result = (await this.request(
      "placeOrder",
      {
        stockCode: match[1],
        exchangeCode: "NSE",
        product: "cash",
        action: intent.side,
        orderType: "limit",
        quantity: String(intent.quantity),
        price: (intent.limitPaise / 100).toFixed(2),
        validity: "day",
        disclosedQuantity: "0",
        userRemark: iciciOrderTag(intent.key),
      },
      signal,
    )) as Row;
    if (typeof result.order_id !== "string" || !result.order_id)
      throw new Error("ICICI acknowledgement lacks an order ID");
    return {
      brokerOrderId: result.order_id.trim(),
      clientOrderKey: intent.key,
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      status: "acknowledged",
      filledQuantity: 0,
      cashDeltaPaise: 0,
    };
  }
  /** Cancel only a known app-tagged order, never an unrelated manual/broker order. */
  async cancelOrder(id: string, signal: AbortSignal) {
    if (!this.cancellableIds.has(id))
      throw new Error("Unmanaged broker order: cancel directly at ICICI");
    this.cache = null;
    await this.request(
      "cancelOrder",
      { exchangeCode: "NSE", orderId: id },
      signal,
    );
  }
  private cancellableIds = new Set<string>();
  /** Kill-switch discovery must still work when positions/funds are inconsistent. Inspect
   * only app-tagged cash orders; never cancel unrelated orders in the same ICICI account.
   */
  async getCancellationOrders(signal: AbortSignal): Promise<BrokerOrder[]> {
    const day = iciciTradingDay();
    const book = rows(
      await this.request(
        "getOrderList",
        {
          exchangeCode: "NSE",
          fromDate: `${day}T00:00:00.000Z`,
          toDate: `${day}T23:59:59.000Z`,
        },
        signal,
        true,
      ),
    );
    const orders: BrokerOrder[] = [];
    this.cancellableIds.clear();
    for (const row of book) {
      const key = this.known.get(String(row.user_remark || ""));
      if (
        !key ||
        ["executed", "cancelled", "rejected", "expired"].includes(
          String(row.status).toLowerCase(),
        )
      )
        continue;
      if (
        row.exchange_code !== "NSE" ||
        String(row.product_type).toLowerCase() !== "cash" ||
        !row.order_id
      )
        throw new Error("Invalid cancellation identity");
      const id = String(row.order_id).trim();
      this.cancellableIds.add(id);
      orders.push({
        brokerOrderId: id,
        clientOrderKey: key,
        instrument: `NSE:${row.stock_code}`,
        side: String(row.action).toLowerCase() === "buy" ? "buy" : "sell",
        quantity: units(row.quantity),
        status: "open",
        filledQuantity: 0,
        cashDeltaPaise: 0,
      });
    }
    return orders;
  }
  /** Fetch a positive executable-side quote; stale/empty prices cannot authorize an order. */
  async getQuote(
    instrument: string,
    side: OrderIntent["side"],
    signal: AbortSignal,
  ) {
    const stockCode = instrument.replace(/^NSE:/, "");
    const quote = rows(
      await this.request(
        "getQuotes",
        { stockCode, exchangeCode: "NSE", productType: "cash" },
        signal,
      ),
    )[0];
    if (
      !quote ||
      quote.stock_code !== stockCode ||
      quote.exchange_code !== "NSE"
    )
      throw new Error("Quote identity mismatch");
    const pricePaise = paise(
      side === "buy" ? quote.best_offer_price : quote.best_bid_price,
    );
    if (pricePaise <= 0) throw new Error("No executable market quote");
    return { pricePaise, observedAt: quoteTimestamp(quote.ltt) };
  }
  /** Close sockets/SDK state without asserting that resting broker orders disappeared. */
  close() {
    this.connected = false;
    this.cache = null;
    this.connection.close();
  }
}
