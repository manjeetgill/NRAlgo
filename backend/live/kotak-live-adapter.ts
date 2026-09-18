/** Kotak execution wire boundary. LIMIT/DAY only: CNC equities and NRML long options.
 * Reference: official Kotak-Neo/kotak-neo-python services/order.py and settings.py.
 * No SDK retries. Missing correlation or malformed success means UNKNOWN, never rejection.
 */
import { createHash } from "node:crypto";
import type { CatalogInstrument } from "../instrument-master.js";
import {
  brokerOrderSchema,
  brokerSnapshotSchema,
  orderIntentSchema,
  type BrokerOrder,
  type ExecutionBrokerAdapter,
  type OrderIntent,
  type LimitQuote,
} from "./contracts.js";

export interface KotakExecutionSession {
  accountBinding: string;
  isCurrent(): boolean;
  request(
    path: string,
    body: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
}
type Row = Record<string, unknown>;
function record(raw: unknown): Row {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Kotak report");
  }
  return raw as Row;
}
function success(raw: unknown) {
  const row = record(raw);
  if (String(row.stat).toLowerCase() !== "ok" || Number(row.stCode) !== 200) {
    throw new Error("Kotak did not confirm success");
  }
  return row;
}
function rows(raw: unknown) {
  const result = success(raw);
  if (!Array.isArray(result.data) || result.data.length >= 10000) {
    throw new Error("Incomplete Kotak book");
  }
  return result.data.map(record);
}
function numeric(value: unknown) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === "" ||
    !Number.isFinite(Number(value))
  ) {
    throw new Error("Missing broker numeric field");
  }
  return Number(value);
}
function units(value: unknown) {
  const n = numeric(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error("Invalid broker quantity");
  }
  return n;
}
function paise(value: unknown) {
  const n = numeric(value) * 100,
    rounded = Math.round(n);
  if (!Number.isSafeInteger(rounded) || Math.abs(n - rounded) > 0.0001) {
    throw new Error("Invalid broker money precision");
  }
  return rounded;
}
export const kotakOrderTag = (key: string) =>
  `NA${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
function identity(row: Row) {
  const segment = row.exSeg,
    product = row.prod;
  if (
    (segment !== "nse_cm" || product !== "CNC") &&
    (segment !== "nse_fo" || product !== "NRML")
  ) {
    throw new Error("Account contains an unsupported execution product");
  }
  if (!/^[1-9]\d{0,14}$/.test(String(row.tok))) {
    throw new Error("Invalid broker instrument");
  }
  return `kotak:${segment === "nse_cm" ? "cash" : "options"}:${row.tok}`;
}

export class KotakLiveAdapter implements ExecutionBrokerAdapter {
  readonly accountBinding: string;
  constructor(
    private readonly session: KotakExecutionSession,
    private readonly resolve: (masterToken: string) => CatalogInstrument,
    private readonly knownIntents: () => Promise<OrderIntent[]>,
    private readonly quote: (
      contract: CatalogInstrument,
      signal: AbortSignal,
    ) => Promise<LimitQuote>,
  ) {
    this.accountBinding = session.accountBinding;
  }

  public validateIntent(raw: OrderIntent) {
    const intent = orderIntentSchema.parse(raw),
      contract = this.resolve(intent.instrument);
    if (
      contract.masterToken !== intent.instrument ||
      !contract.tickPaise ||
      intent.quantity % contract.lotSize ||
      intent.limitPaise % contract.tickPaise
    ) {
      throw new Error(
        "Use the exact master contract, whole lots and tick-aligned limit price",
      );
    }
    if (intent.side === "sell" && !intent.reduceOnly) {
      throw new Error(
        "Opening short positions is disabled; sells must reduce a tracked long position",
      );
    }
    return contract;
  }
  public async placeOrder(intent: OrderIntent, signal: AbortSignal) {
    const contract = this.validateIntent(intent);
    const raw = success(
      await this.session.request(
        "/quick/order/rule/ms/place",
        {
          am: "NO",
          dq: "0",
          es: contract.market === "cash" ? "nse_cm" : "nse_fo",
          mp: "0",
          pc: contract.market === "cash" ? "CNC" : "NRML",
          pr: (intent.limitPaise / 100).toFixed(2),
          pt: "L",
          qt: String(intent.quantity),
          rt: "DAY",
          tp: "0",
          ts: contract.name,
          tt: intent.side === "buy" ? "B" : "S",
          ig: kotakOrderTag(intent.key),
          os: "NEOTRADEAPI",
        },
        signal,
      ),
    );
    if (typeof raw.nOrdNo !== "string" || !/^\d{1,30}$/.test(raw.nOrdNo)) {
      throw new Error("Missing Kotak order acknowledgement");
    }
    // The placement response acknowledges receipt, not a fill. Durable reconciliation
    // subsequently verifies GuiOrdId, token, product, side, quantity and cumulative fills.
    return brokerOrderSchema.parse({
      brokerOrderId: raw.nOrdNo,
      clientOrderKey: intent.key,
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      status: "acknowledged",
      filledQuantity: 0,
      cashDeltaPaise: null,
    });
  }
  private normalize(
    row: Row,
    known: OrderIntent[],
    verifyTerms = true,
  ): BrokerOrder {
    const id = String(row.nOrdNo ?? "");
    if (!/^\d{1,30}$/.test(id)) {
      throw new Error("Missing order ID");
    }
    const matches = known.filter((i) => kotakOrderTag(i.key) === row.GuiOrdId);
    if (matches.length > 1) {
      throw new Error("Ambiguous order tag");
    }
    if (
      matches[0] &&
      verifyTerms &&
      (row.prcTp !== "L" ||
        row.vldt !== "DAY" ||
        paise(row.prc) !== matches[0].limitPaise)
    ) {
      throw new Error("Broker order terms changed outside the live OMS");
    }
    const quantity = units(row.qty),
      filled = units(row.fldQty);
    const state = String(row.ordSt).toLowerCase().trim();
    let status: BrokerOrder["status"];
    if (
      [
        "open",
        "pending",
        "put order req received",
        "validation pending",
        "open pending",
        "modify pending",
        "cancel pending",
        "trigger pending",
      ].includes(state)
    ) {
      status =
        filled === 0
          ? "open"
          : filled === quantity
            ? "filled"
            : "partially_filled";
    } else if (
      state === "complete" ||
      state === "traded" ||
      state === "filled"
    ) {
      status = "filled";
    } else if (state === "cancelled" || state === "canceled") {
      status = "cancelled";
    } else if (state === "rejected") {
      status = "rejected";
    } else {
      throw new Error("Unknown broker order status");
    }
    if (
      filled > quantity ||
      (status === "filled" && filled !== quantity) ||
      (status === "rejected" && filled !== 0)
    ) {
      throw new Error("Contradictory fill status");
    }
    if (row.trnsTp !== "B" && row.trnsTp !== "S") {
      throw new Error("Unknown side");
    }
    return brokerOrderSchema.parse({
      brokerOrderId: id,
      clientOrderKey: matches[0]?.key ?? `external:${id}`,
      instrument: identity(row),
      side: row.trnsTp === "B" ? "buy" : "sell",
      quantity,
      status,
      filledQuantity: filled,
      cashDeltaPaise: null,
    });
  }
  public async getCancellationOrders(signal: AbortSignal) {
    const known = await this.knownIntents();
    const book = rows(
      await this.session.request("/quick/user/orders", undefined, signal),
    );
    // Never cancel a manual/other application's order, even after account drift.
    return book
      .filter((r) => known.some((i) => kotakOrderTag(i.key) === r.GuiOrdId))
      .map((r) => this.normalize(r, known, false))
      .filter((r) =>
        known.some(
          (i) =>
            i.key === r.clientOrderKey &&
            i.instrument === r.instrument &&
            i.side === r.side &&
            i.quantity === r.quantity,
        ),
      );
  }
  public async cancelOrder(brokerOrderId: string, signal: AbortSignal) {
    const owned = await this.getCancellationOrders(signal);
    if (!owned.some((o) => o.brokerOrderId === brokerOrderId)) {
      throw new Error("Order not managed by this account");
    }
    success(
      await this.session.request(
        "/quick/order/cancel",
        { on: brokerOrderId, am: "NO" },
        signal,
      ),
    );
  }
  public async getQuote(
    instrument: string,
    _side: OrderIntent["side"],
    signal: AbortSignal,
  ) {
    const result = await this.quote(this.resolve(instrument), signal);
    if (
      signal.aborted ||
      !this.session.isCurrent() ||
      !Number.isSafeInteger(result.pricePaise) ||
      result.pricePaise <= 0 ||
      !Number.isSafeInteger(result.observedAt) ||
      result.observedAt > Date.now() ||
      Date.now() - result.observedAt > 5000
    ) {
      throw new Error("Fresh broker quote required");
    }
    return result;
  }
  public async getSnapshot(signal: AbortSignal) {
    const started = Date.now();
    const [orderRaw, positionRaw, limitRaw, known] = await Promise.all([
      this.session.request("/quick/user/orders", undefined, signal),
      this.session.request("/quick/user/positions", undefined, signal),
      this.session.request(
        "/quick/user/limits",
        { seg: "ALL", exch: "ALL", prod: "ALL" },
        signal,
      ),
      this.knownIntents(),
    ]);
    const limits = success(limitRaw),
      orders = rows(orderRaw).map((r) => this.normalize(r, known));
    const positions: Record<string, number> = {};
    let gross = 0;
    for (const row of rows(positionRaw)) {
      const instrument = identity(row);
      // These are exchange units, not lots. Carry-forward positions cannot be silently
      // adopted by a day-order ledger; reconciliation will halt on the unmatched quantity.
      const quantity =
        units(row.cfBuyQty) +
        units(row.flBuyQty) -
        units(row.cfSellQty) -
        units(row.flSellQty);
      if (instrument in positions) {
        throw new Error("Duplicate position row");
      }
      positions[instrument] = quantity;
      if (quantity) {
        if (quantity < 0) {
          throw new Error("Short exposure requires operator review");
        }
        for (const field of [
          "multiplier",
          "genNum",
          "genDen",
          "prcNum",
          "prcDen",
        ]) {
          if (numeric(row[field]) !== 1) {
            throw new Error("Unsupported contract multiplier");
          }
        }
        const quote = await this.getQuote(instrument, "sell", signal);
        const cost = Math.abs(
          paise(row.cfBuyAmt) +
            paise(row.buyAmt) -
            paise(row.cfSellAmt) -
            paise(row.sellAmt),
        );
        gross += Math.max(quantity * quote.pricePaise, cost);
      }
    }
    if (
      signal.aborted ||
      !this.session.isCurrent() ||
      Date.now() - started > 5000
    ) {
      throw new Error("Broker snapshot stale");
    }
    // RMS Net is buying power. Neither Net nor MTM is a cash-ledger balance.
    return brokerSnapshotSchema.parse({
      capturedAt: started,
      sessionHealthy: true,
      complete: true,
      orders: orders.sort((a, b) =>
        a.brokerOrderId.localeCompare(b.brokerOrderId),
      ),
      positions: Object.fromEntries(
        Object.entries(positions)
          .filter(([, v]) => v !== 0)
          .sort(),
      ),
      availablePaise: paise(limits.Net),
      fundsBasis: "broker-rms",
      cashBalancePaise: null,
      grossExposurePaise: gross,
      dailyPnlPaise:
        paise(limits.RealizedMtomPrsnt) +
        paise(limits.UnrealizedMtomPrsnt) -
        paise(limits.BrokeragePrsnt),
    });
  }
}
