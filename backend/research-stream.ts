/** Read-only research quote decoding/cache. No execution imports or account information.
 * Packet layouts follow the pinned Breeze SDK's NSE cash (21) and NFO quote (23) fields.
 * Exchange epoch timestamps avoid the SDK's machine-timezone-dependent ltt string conversion.
 */
export interface ResearchQuote {
  stockCode: string;
  price: number;
  bid: number;
  ask: number;
  observedAt: number | null;
  receivedAt: number;
  stale: boolean;
}
export interface ResearchStreamSnapshot {
  streamId: string;
  strategyId: string;
  state: string;
  quotes: ResearchQuote[];
}
/** Accept only the exact server-resolved quote token and expected product packet shape.
 * Unknown/order/depth packets, malformed prices and future timestamps never update the cache.
 */
export function decodeResearchTick(
  raw: unknown,
  token: string,
  product: string,
  stockCode: string,
  now = Date.now(),
): ResearchQuote | null {
  const length = product === "cash" ? 21 : 23;
  if (
    !Array.isArray(raw) ||
    raw.length !== length ||
    raw[0] !== token ||
    !/^4\.1!\d+$/.test(token)
  )
    return null;
  const price = Number(raw[2]),
    bid = Number(raw[6]),
    ask = Number(raw[8]);
  const observedAt = Number(raw[length === 21 ? 19 : 21]) * 1000;
  if (
    ![price, bid, ask].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 10000000,
    ) ||
    bid > ask ||
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0 ||
    observedAt > now + 1000
  )
    return null;
  return {
    stockCode,
    price,
    bid,
    ask,
    observedAt,
    receivedAt: now,
    stale: price <= 0 || bid <= 0 || ask <= 0 || now - observedAt > 60000,
  };
}
/** Bounded cache keeps at most four marks, rejects out-of-order packets and clears on reconnect.
 * A healthy socket is not a fresh basket: every leg independently expires on trade and receipt age.
 */
export class ResearchStreamCache {
  private lastHeartbeatAt = Date.now();
  private quotes: ResearchQuote[];
  private state = "waiting";
  /** Only an authenticated owner/browser read refreshes the lease; incoming ticks do not. */
  heartbeat(now = Date.now()) {
    this.lastHeartbeatAt = now;
  }
  /** Expiry is independent of trading volume so an abandoned liquid basket still stops. */
  leaseExpired(now = Date.now()) {
    return now - this.lastHeartbeatAt > 45000;
  }
  constructor(
    readonly streamId: string,
    readonly strategyId: string,
    private readonly stockCodes: string[],
  ) {
    if (stockCodes.length < 1 || stockCodes.length > 4)
      throw new Error("Invalid stream basket size");
    this.quotes = this.emptyQuotes();
  }
  /** Missing legs are explicit stale placeholders, never another leg's last price. */
  private emptyQuotes(): ResearchQuote[] {
    return this.stockCodes.map((stockCode) => ({
      stockCode,
      price: 0,
      bid: 0,
      ask: 0,
      observedAt: null,
      receivedAt: 0,
      stale: true,
    }));
  }
  /** Index comes only from the worker's resolved token map, not from a browser payload. */
  accept(index: number, quote: ResearchQuote) {
    const previous = this.quotes[index];
    if (
      !previous ||
      quote.stockCode !== previous.stockCode ||
      !quote.observedAt ||
      quote.observedAt < (previous.observedAt || 0)
    )
      return;
    this.quotes[index] = quote;
    this.state = "streaming";
  }
  /** Clear every old mark immediately on socket loss/rejoin or explicit stop. */
  invalidate(state: string) {
    this.state = state;
    this.quotes = this.emptyQuotes();
  }
  /** Calculate freshness at read time, including when an otherwise-open socket stops ticking. */
  snapshot(now = Date.now()): ResearchStreamSnapshot {
    const quotes = this.quotes.map((quote) => ({
      ...quote,
      stale:
        quote.stale ||
        !quote.observedAt ||
        now - quote.observedAt > 60000 ||
        now - quote.receivedAt > 30000,
    }));
    return {
      streamId: this.streamId,
      strategyId: this.strategyId,
      state:
        this.state === "streaming" && quotes.some((quote) => quote.stale)
          ? "stale"
          : this.state,
      quotes,
    };
  }
}
