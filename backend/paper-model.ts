/** Network-free, long-only NSE cash/options ledger. This module cannot call a broker.
 * Money is integer paise. Fills are illustrative full fills at top-of-book plus 5bps,
 * capped by the limit, with ₹5 per fill. Queue depth, taxes and partial fills are not modeled.
 */
import { z } from "zod";

export const paperBrokerSchema = z.enum(["icici", "kotak"]);
export type PaperBroker = z.infer<typeof paperBrokerSchema>;
/** Lot size is explicitly supplied for research, not certified against an exchange master. */
export const paperOptionSchema = z
  .object({
    expiryDate: z.iso.date(),
    right: z.enum(["call", "put"]),
    strikePrice: z.number().positive().max(1000000),
    lotSize: z.number().int().min(1).max(10000),
  })
  .strict();
export const paperOrderInput = z
  .object({
    key: z.string().uuid(),
    instrument: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9&_.-]{1,30}$/),
    side: z.enum(["buy", "sell"]),
    quantity: z.number().int().min(1).max(10000),
    limitPaise: z.number().int().min(1).max(100000000),
    option: paperOptionSchema.optional(),
    masterToken: z
      .string()
      .regex(/^(icici|kotak):(cash|options):[1-9]\d{0,14}$/)
      .optional(),
  })
  .strict();
export type PaperInput = z.infer<typeof paperOrderInput>;
/** Cash keys remain unchanged for existing wallets. Options cannot share cash/strike/expiry balances. */
export function paperInstrumentKey(
  input: Pick<PaperInput, "instrument" | "option">,
) {
  const o = input.option;
  return o
    ? `OPTION:${input.instrument}:${o.expiryDate}:${o.right}:${o.strikePrice}`
    : input.instrument;
}
/** Enforce whole declared lots and stop trading expired contracts; no invented expiry settlement. */
function validatePaperContract(input: PaperInput, now: number) {
  if (!input.option) return;
  if (input.quantity % input.option.lotSize !== 0)
    throw new Error(
      "Options quantity must be a multiple of the declared lot size.",
    );
  if (input.option.expiryDate < paperTradingDay(now))
    throw new Error(
      "Option contract has expired. Settlement is not simulated.",
    );
}
export interface PaperQuote {
  instrument: string;
  bid: number;
  ask: number;
  observedAt: number;
  receivedAt: number;
}
export interface PaperOrder extends PaperInput {
  original: PaperInput;
  state: "open" | "filled" | "cancelled" | "expired";
  createdAt: number;
  updatedAt: number;
  fillPaise?: number;
  feePaise?: number;
}
export interface PaperPosition {
  quantity: number;
  costPaise: number;
}
export interface PaperLedger {
  capitalPaise: number;
  cashPaise: number;
  realizedPaise: number;
  orders: PaperOrder[];
  positions: Record<string, PaperPosition>;
  marks: Record<string, PaperQuote>;
}
export const paperFeePaise = 500;
/** A broker-specific virtual wallet is created once; switching brokers never transfers money. */
export function newPaperLedger(): PaperLedger {
  return {
    capitalPaise: 10000000,
    cashPaise: 10000000,
    realizedPaise: 0,
    orders: [],
    positions: {},
    marks: {},
  };
}
export const paperTradingDay = (now: number) =>
  new Date(now + 19800000).toISOString().slice(0, 10);
/** Conservative weekday session check, not an exchange holiday calendar. Stale quotes also block fills. */
export function paperMarketOpen(now: number) {
  const date = new Date(now + 19800000),
    minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    date.getUTCDay() > 0 &&
    date.getUTCDay() < 6 &&
    minute >= 555 &&
    minute < 930
  );
}
/** HTTP arrival alone never makes old exchange data fresh. Require a positive uncrossed spread. */
export function freshPaperQuote(quote: PaperQuote, now: number) {
  return (
    [quote.bid, quote.ask, quote.observedAt, quote.receivedAt].every(
      Number.isSafeInteger,
    ) &&
    quote.bid > 0 &&
    quote.ask >= quote.bid &&
    quote.ask <= 100000000 &&
    quote.observedAt <= now + 1000 &&
    quote.observedAt >= now - 60000 &&
    quote.receivedAt <= now + 1000 &&
    quote.receivedAt >= now - 15000
  );
}
/** DAY orders cannot survive a date rollover or the session close. No synthetic end-of-day fills. */
export function expirePaperOrders(ledger: PaperLedger, now: number) {
  const minutes =
    new Date(now + 19800000).getUTCHours() * 60 +
    new Date(now + 19800000).getUTCMinutes();
  for (const order of ledger.orders)
    if (
      order.state === "open" &&
      (paperTradingDay(order.createdAt) !== paperTradingDay(now) ||
        minutes >= 930)
    ) {
      order.state = "expired";
      order.updatedAt = now;
    }
}
/** Reserve buy notional+fees and sell units across all open orders, preventing double spending. */
export function validatePaperReservations(ledger: PaperLedger) {
  let reserved = 0;
  const selling: Record<string, number> = {};
  for (const order of ledger.orders)
    if (order.state === "open") {
      if (order.side === "buy")
        reserved += order.quantity * order.limitPaise + paperFeePaise;
      else
        selling[paperInstrumentKey(order)] =
          (selling[paperInstrumentKey(order)] || 0) + order.quantity;
    }
  if (reserved > ledger.cashPaise)
    throw new Error("Insufficient unreserved virtual cash.");
  for (const [symbol, quantity] of Object.entries(selling))
    if (quantity > (ledger.positions[symbol]?.quantity || 0))
      throw new Error(
        "Insufficient unreserved units. Paper short selling is disabled.",
      );
  return reserved;
}
/** Idempotency binds a key to its original content, even after modification, fill or cancellation. */
export function placePaperOrder(
  ledger: PaperLedger,
  input: PaperInput,
  now: number,
) {
  const existing = ledger.orders.find((order) => order.key === input.key);
  if (existing) {
    if (JSON.stringify(existing.original) !== JSON.stringify(input))
      throw new Error("Order key already used with different content.");
    return existing;
  }
  if (!paperMarketOpen(now))
    throw new Error(
      "Paper DAY orders require weekday market hours, 09:15–15:30 IST.",
    );
  validatePaperContract(input, now);
  const prior = ledger.orders.find(
    (order) => paperInstrumentKey(order) === paperInstrumentKey(input),
  );
  if (prior?.option && prior.option.lotSize !== input.option?.lotSize)
    throw new Error(
      "Declared lot size cannot change for an existing paper contract.",
    );
  if (ledger.orders.length >= 1000)
    throw new Error("Paper account history limit reached (1000 orders).");
  const order: PaperOrder = {
    ...input,
    original: { ...input },
    state: "open",
    createdAt: now,
    updatedAt: now,
  };
  ledger.orders.push(order);
  try {
    validatePaperReservations(ledger);
  } catch (error) {
    ledger.orders.pop();
    throw error;
  }
  return order;
}
/** Modification keeps identity/side fixed. Recheck reservations before committing changed quantity/limit. */
export function modifyPaperOrder(
  ledger: PaperLedger,
  key: string,
  quantity: number,
  limitPaise: number,
  now: number,
) {
  const order = ledger.orders.find((item) => item.key === key);
  if (!order || order.state !== "open")
    throw new Error("Only an open paper order can be modified.");
  const before = { ...order };
  validatePaperContract({ ...order, quantity, limitPaise }, now);
  Object.assign(order, { quantity, limitPaise, updatedAt: now });
  try {
    validatePaperReservations(ledger);
  } catch (error) {
    Object.assign(order, before);
    throw error;
  }
}
/** A local cancellation needs no quote or broker connection and never contacts a real order API. */
export function cancelPaperOrder(
  ledger: PaperLedger,
  key: string,
  now: number,
) {
  const order = ledger.orders.find((item) => item.key === key);
  if (!order) throw new Error("Paper order not found.");
  if (order.state === "open") {
    order.state = "cancelled";
    order.updatedAt = now;
  }
}
/** Apply only quotes fetched by the server. Missing/stale data leaves orders open, never guesses a fill. */
export function matchPaperOrders(
  ledger: PaperLedger,
  quotes: PaperQuote[],
  now: number,
) {
  expirePaperOrders(ledger, now);
  // Retain only held/open instruments and this cycle's previews, bounding persisted quote history.
  const retained = new Set([
    ...quotes.map((q) => q.instrument),
    ...ledger.orders.filter((o) => o.state === "open").map(paperInstrumentKey),
    ...Object.keys(ledger.positions).filter(
      (k) => ledger.positions[k].quantity,
    ),
  ]);
  for (const symbol of Object.keys(ledger.marks))
    if (!retained.has(symbol)) delete ledger.marks[symbol];
  for (const quote of quotes) {
    if (!freshPaperQuote(quote, now)) {
      delete ledger.marks[quote.instrument];
      continue;
    }
    ledger.marks[quote.instrument] = quote;
    if (!paperMarketOpen(now)) continue;
    for (const order of ledger.orders) {
      if (
        order.state !== "open" ||
        paperInstrumentKey(order) !== quote.instrument ||
        (order.option && order.option.expiryDate < paperTradingDay(now)) ||
        quote.receivedAt < order.updatedAt
      )
        continue;
      if (
        (order.side === "buy" && quote.ask > order.limitPaise) ||
        (order.side === "sell" && quote.bid < order.limitPaise)
      )
        continue;
      const price =
        order.side === "buy"
          ? Math.min(order.limitPaise, Math.ceil(quote.ask * 1.0005))
          : Math.max(order.limitPaise, Math.floor(quote.bid * 0.9995));
      const position = ledger.positions[paperInstrumentKey(order)] || {
        quantity: 0,
        costPaise: 0,
      };
      if (order.side === "buy") {
        const debit = price * order.quantity + paperFeePaise;
        if (debit > ledger.cashPaise) continue;
        ledger.cashPaise -= debit;
        position.costPaise += debit;
        position.quantity += order.quantity;
      } else {
        if (position.quantity < order.quantity) continue;
        const cost =
          order.quantity === position.quantity
            ? position.costPaise
            : Math.round(
                (position.costPaise * order.quantity) / position.quantity,
              );
        const credit = price * order.quantity - paperFeePaise;
        if (ledger.cashPaise + credit < 0) continue;
        ledger.cashPaise += credit;
        ledger.realizedPaise += credit - cost;
        position.quantity -= order.quantity;
        position.costPaise -= cost;
      }
      ledger.positions[paperInstrumentKey(order)] = position;
      Object.assign(order, {
        state: "filled",
        fillPaise: price,
        feePaise: paperFeePaise,
        updatedAt: now,
      });
    }
  }
}
/** Mark P&L unavailable when any held instrument lacks a fresh bid, rather than showing stale profits. */
export function paperSummary(ledger: PaperLedger, now: number) {
  let marked = 0,
    cost = 0,
    complete = true;
  for (const [symbol, position] of Object.entries(ledger.positions))
    if (position.quantity) {
      const quote = ledger.marks[symbol];
      const expired = ledger.orders.some(
        (order) =>
          paperInstrumentKey(order) === symbol &&
          order.option &&
          order.option.expiryDate < paperTradingDay(now),
      );
      if (expired || !quote || !freshPaperQuote(quote, now)) complete = false;
      else marked += quote.bid * position.quantity;
      cost += position.costPaise;
    }
  return {
    ...ledger,
    settlementRequired: Object.keys(ledger.positions).filter(
      (key) =>
        ledger.positions[key].quantity &&
        ledger.orders.some(
          (order) =>
            paperInstrumentKey(order) === key &&
            order.option &&
            order.option.expiryDate < paperTradingDay(now),
        ),
    ),
    reservedPaise: validatePaperReservations(ledger),
    unrealizedPaise: complete ? marked - cost : null,
    equityPaise: complete ? ledger.cashPaise + marked : null,
  };
}
