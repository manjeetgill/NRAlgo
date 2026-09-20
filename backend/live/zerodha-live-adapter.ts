/** Kite v3 execution boundary: regular LIMIT/DAY, NSE CNC and NFO long options only.
 * https://kite.trade/docs/connect/v3/orders/ — acknowledgement is not a fill.
 * No retries, token translation, foreign-order cancellation or fabricated cash balances.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CatalogInstrument } from "../instrument-master.js";
import {
  brokerOrderSchema,
  brokerSnapshotSchema,
  orderIntentSchema,
  PreflightRejection,
  type BrokerOrder,
  type ExecutionBrokerAdapter,
  type OrderIntent,
} from "./contracts.js";

export interface ZerodhaExecutionSession {
  accountBinding: string;
  expiresAt: number;
  isCurrent(): boolean;
  request(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
  instruments(market: "cash" | "options"): Promise<unknown>;
}
type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  z.record(z.string(), z.unknown()).parse(value);
const rows = (value: unknown) =>
  z.array(z.record(z.string(), z.unknown())).max(9999).parse(value);
const number = (value: unknown) => z.number().finite().parse(value);
const units = (value: unknown) => z.number().int().safe().parse(value);
/** Round broker accounting to paise, but never silently substitute absent numeric fields. */
const paise = (value: unknown) =>
  z
    .number()
    .int()
    .safe()
    .parse(Math.round(number(value) * 100));
export const zerodhaOrderTag = (key: string) =>
  `NA${createHash("sha256").update(key).digest("hex").slice(0, 18)}`;

/** Product/exchange and Kite instrument token form a provider-specific identity. */
function identity(row: Row) {
  const market =
    row.exchange === "NSE" && row.product === "CNC"
      ? "cash"
      : row.exchange === "NFO" &&
          row.product === "NRML" &&
          /(?:CE|PE)$/.test(String(row.tradingsymbol))
        ? "options"
        : null;
  if (!market || units(row.instrument_token) <= 0) {
    throw new Error(
      "Account contains an unsupported Zerodha execution product",
    );
  }
  return `zerodha:${market}:${row.instrument_token}`;
}

export class ZerodhaLiveAdapter implements ExecutionBrokerAdapter {
  readonly accountBinding: string;
  constructor(
    private readonly session: ZerodhaExecutionSession,
    private readonly resolve: (token: string) => CatalogInstrument,
    private readonly knownIntents: () => Promise<OrderIntent[]>,
  ) {
    this.accountBinding = session.accountBinding;
  }
  /** Master identity, lot and tick are resolved on the server; shorts never open through this adapter. */
  public validateIntent(raw: OrderIntent) {
    const intent = orderIntentSchema.parse(raw),
      contract = this.resolve(intent.instrument);
    if (
      !intent.instrument.startsWith("zerodha:") ||
      contract.masterToken !== intent.instrument ||
      !contract.tickPaise ||
      intent.quantity % contract.lotSize ||
      intent.limitPaise % contract.tickPaise ||
      (intent.side === "sell" && !intent.reduceOnly)
    ) {
      throw new Error(
        "Use an exact Zerodha contract, whole lots and a tick-aligned limit; sells must reduce tracked longs",
      );
    }
    return contract;
  }
  /** Dispatch once. HTTP failures, timeouts and malformed acknowledgements remain UNKNOWN in the OMS. */
  public async placeOrder(intent: OrderIntent, signal: AbortSignal) {
    let contract: CatalogInstrument;
    try {
      contract = this.validateIntent(intent);
    } catch (error) {
      throw new PreflightRejection(
        error instanceof Error ? error.message : "Invalid intent",
      );
    }
    const response = object(
      await this.session.request(
        "/orders/regular",
        "POST",
        {
          exchange: contract.market === "cash" ? "NSE" : "NFO",
          tradingsymbol: contract.name,
          transaction_type: intent.side.toUpperCase(),
          quantity: String(intent.quantity),
          product: contract.market === "cash" ? "CNC" : "NRML",
          order_type: "LIMIT",
          validity: "DAY",
          price: (intent.limitPaise / 100).toFixed(2),
          tag: zerodhaOrderTag(intent.key),
        },
        signal,
      ),
    );
    const id = z
      .string()
      .regex(/^\d{1,30}$/)
      .parse(response.order_id);
    return brokerOrderSchema.parse({
      brokerOrderId: id,
      clientOrderKey: intent.key,
      instrument: intent.instrument,
      side: intent.side,
      quantity: intent.quantity,
      status: "acknowledged",
      filledQuantity: 0,
      cashDeltaPaise: null,
    });
  }
  /** Correlate tags with durable intents; any contradictory identity, terms or fill status fails closed. */
  private normalize(
    row: Row,
    known: OrderIntent[],
    verifyTerms = true,
  ): BrokerOrder {
    const id = z
      .string()
      .regex(/^\d{1,30}$/)
      .parse(row.order_id);
    const matches = known.filter(
      (intent) => zerodhaOrderTag(intent.key) === row.tag,
    );
    if (matches.length > 1) {
      throw new Error("Ambiguous Zerodha order tag");
    }
    const match = matches[0],
      instrument = identity(row),
      quantity = units(row.quantity),
      filled = units(row.filled_quantity);
    const side =
      row.transaction_type === "BUY"
        ? "buy"
        : row.transaction_type === "SELL"
          ? "sell"
          : null;
    if (!side || row.variety !== "regular") {
      throw new Error("Unsupported Zerodha order");
    }
    if (
      match &&
      (instrument !== match.instrument ||
        side !== match.side ||
        quantity !== match.quantity ||
        (verifyTerms &&
          (row.order_type !== "LIMIT" ||
            row.validity !== "DAY" ||
            paise(row.price) !== match.limitPaise)))
    ) {
      throw new Error("Zerodha order changed outside this OMS");
    }
    const state = String(row.status);
    const pending = [
      "OPEN",
      "TRIGGER PENDING",
      "VALIDATION PENDING",
      "OPEN PENDING",
      "MODIFY VALIDATION PENDING",
      "MODIFY PENDING",
      "CANCEL PENDING",
      "PUT ORDER REQ RECEIVED",
    ];
    const status =
      state === "COMPLETE"
        ? "filled"
        : state === "CANCELLED"
          ? "cancelled"
          : state === "REJECTED"
            ? "rejected"
            : pending.includes(state)
              ? filled === 0
                ? "open"
                : filled === quantity
                  ? "filled"
                  : "partially_filled"
              : null;
    if (
      !status ||
      quantity <= 0 ||
      filled < 0 ||
      filled > quantity ||
      (status === "filled" && filled !== quantity) ||
      (status === "rejected" && filled !== 0)
    ) {
      throw new Error("Unknown or contradictory Zerodha fill status");
    }
    return brokerOrderSchema.parse({
      brokerOrderId: id,
      clientOrderKey: match?.key ?? `external:${id}`,
      instrument,
      side,
      quantity,
      status,
      filledQuantity: filled,
      cashDeltaPaise: null,
    });
  }
  /** Cancellation only considers exact owned tag/identity/quantity matches, never other account orders. */
  public async getCancellationOrders(signal: AbortSignal) {
    const known = await this.knownIntents();
    return rows(await this.session.request("/orders", "GET", undefined, signal))
      .filter((row) =>
        known.some((intent) => zerodhaOrderTag(intent.key) === row.tag),
      )
      .map((row) => this.normalize(row, known, false));
  }
  public async cancelOrder(id: string, signal: AbortSignal) {
    if (
      !(await this.getCancellationOrders(signal)).some(
        (row) => row.brokerOrderId === id,
      )
    ) {
      throw new Error("Order is not owned by this account");
    }
    const result = object(
      await this.session.request(
        `/orders/regular/${id}`,
        "DELETE",
        undefined,
        signal,
      ),
    );
    if (result.order_id !== id) {
      throw new Error("Unconfirmed Zerodha cancellation");
    }
  }
  /** Both sides of executable depth and the exchange packet timestamp must be present and fresh. */
  public async getQuote(
    instrument: string,
    _side: OrderIntent["side"],
    signal: AbortSignal,
  ) {
    if (!instrument.startsWith("zerodha:")) {
      throw new Error("Wrong broker contract");
    }
    const contract = this.resolve(instrument),
      key = `${contract.market === "cash" ? "NSE" : "NFO"}:${contract.name}`;
    const quote = object(
      object(
        await this.session.request(
          `/quote?i=${encodeURIComponent(key)}`,
          "GET",
          undefined,
          signal,
        ),
      )[key],
    );
    const timestamp = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      .parse(quote.timestamp);
    const observedAt = Date.parse(`${timestamp.replace(" ", "T")}+05:30`);
    const depth = object(quote.depth),
      buy = rows(depth.buy)[0],
      sell = rows(depth.sell)[0];
    if (
      !buy ||
      !sell ||
      String(quote.instrument_token) !== contract.instrument ||
      units(buy.quantity) <= 0 ||
      units(sell.quantity) <= 0 ||
      !Number.isFinite(observedAt) ||
      observedAt > Date.now() ||
      Date.now() - observedAt > 5000 ||
      !this.session.isCurrent() ||
      signal.aborted
    ) {
      throw new Error("Fresh Zerodha executable depth is required");
    }
    const bid = paise(buy.price),
      ask = paise(sell.price);
    if (bid <= 0 || ask < bid) {
      throw new Error("Invalid Zerodha depth");
    }
    return { pricePaise: ask, observedAt };
  }
  /** Include carry and same-day fills. Collateral, MTF, foreign products and untracked exposure never disappear. */
  public async getSnapshot(signal: AbortSignal) {
    const started = Date.now();
    const [book, positionRaw, holdingRaw, marginRaw, known] = await Promise.all(
      [
        this.session.request("/orders", "GET", undefined, signal),
        this.session.request("/portfolio/positions", "GET", undefined, signal),
        this.session.request("/portfolio/holdings", "GET", undefined, signal),
        this.session.request("/user/margins/equity", "GET", undefined, signal),
        this.knownIntents(),
      ],
    );
    const orders = rows(book).map((row) => this.normalize(row, known));
    const positions: Record<string, number> = {},
      costs: Record<string, number> = {};
    let dailyPnlPaise = 0;
    for (const row of rows(holdingRaw)) {
      const key = identity(row),
        opening = units(row.opening_quantity);
      if (
        opening < 0 ||
        units(row.collateral_quantity) !== 0 ||
        units(row.short_quantity) !== 0 ||
        row.discrepancy !== false ||
        (row.mtf !== null &&
          row.mtf !== undefined &&
          units(object(row.mtf).quantity) !== 0) ||
        key in positions
      ) {
        throw new Error(
          "Zerodha holdings require operator review (collateral, MTF or inconsistent quantities)",
        );
      }
      // Opening carry + today's CNC net position avoids subtracting holding sales twice.
      positions[key] = opening;
      costs[key] = paise(number(row.average_price) * opening);
      dailyPnlPaise += paise(number(row.day_change) * opening);
    }
    const seen = new Set<string>();
    for (const row of rows(object(positionRaw).net)) {
      const key = identity(row),
        qty = units(row.quantity);
      if (seen.has(key) || number(row.multiplier) !== 1) {
        throw new Error("Duplicate or unsupported Zerodha position");
      }
      seen.add(key);
      positions[key] = (positions[key] ?? 0) + qty;
      costs[key] =
        (costs[key] ?? 0) + paise(number(row.average_price) * Math.abs(qty));
      dailyPnlPaise += paise(row.m2m);
    }
    let gross = 0;
    for (const [key, qty] of Object.entries(positions)) {
      if (qty < 0) {
        throw new Error("Short exposure requires operator review");
      }
      if (qty) {
        gross += Math.max(
          qty * (await this.getQuote(key, "sell", signal)).pricePaise,
          costs[key],
        );
      }
    }
    const margin = object(marginRaw);
    if (
      margin.enabled !== true ||
      signal.aborted ||
      !this.session.isCurrent() ||
      Date.now() - started > 5000
    ) {
      throw new Error("Zerodha snapshot stale or margin unavailable");
    }
    return brokerSnapshotSchema.parse({
      capturedAt: started,
      sessionHealthy: true,
      complete: true,
      orders: orders.sort((a, b) =>
        a.brokerOrderId.localeCompare(b.brokerOrderId),
      ),
      positions: Object.fromEntries(
        Object.entries(positions)
          .filter(([, q]) => q !== 0)
          .sort(),
      ),
      availablePaise: paise(margin.net),
      fundsBasis: "broker-rms",
      cashBalancePaise: null,
      grossExposurePaise: gross,
      dailyPnlPaise,
    });
  }
}
