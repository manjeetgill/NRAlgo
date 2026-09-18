/** Defines read-only broker operations and prevents overlapping requests for the same user. */
import { fail } from "./security.js";
import type { PaperQuote } from "./paper-trading-ledger.js";
import type { PortfolioRow } from "./broker-portfolio-normalizer.js";

/** App-level NSE segments. Each adapter translates these into its broker's wire codes. */
export type MarketSegment = "nse_cm" | "nse_fo";
export interface MarketSnapshot {
  instrument: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  volume: number | null;
  observedAt: number | null;
  stale: boolean;
}

/** Read-only extension boundary. Authentication stays broker-specific; paper and research
 * consume normalized data. Deliberately no place/modify/cancel method or live-mode flag.
 * A future adapter must preserve session ownership, timestamps and missing-data semantics.
 */
export interface BrokerMarketDataReader extends BrokerAccountReader {
  /** Check local session ownership and expiry. This does not call the broker. */
  isConnected(userId: string, sessionHash: string): boolean;
  /** Fetch a bid/ask quote for a simulated fill. Prices are integer paise, timestamps
   * are epoch milliseconds, and the paper ledger checks freshness before matching.
   */
  getPaperFillQuote(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment?: MarketSegment,
  ): Promise<PaperQuote>;
  /** Fetch display prices in rupees for cash/options tokens. Missing values stay null;
   * these display snapshots cannot replace the stricter fill quote above.
   */
  getQuoteSnapshots(
    userId: string,
    sessionHash: string,
    instruments: string[],
    segment?: MarketSegment,
  ): Promise<MarketSnapshot[]>;
  /** Fetch one trading day's candles. The simulator validates candle alignment and OHLC. */
  getHistoricalCandlesForDay(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment: MarketSegment,
    day: string,
    interval: "1minute" | "5minute",
  ): Promise<unknown[]>;
  /** Discover an approved broker CSV location, never a client-supplied download URL. */
  getInstrumentMasterUrl(
    userId: string,
    sessionHash: string,
    market: "cash" | "options",
  ): Promise<string>;
}

/** Account-only boundary; independent of the selected market-data provider. */
export interface BrokerAccountReader {
  isConnected(userId: string, sessionHash: string): boolean;
  /** Read real broker positions/holdings without changing the separate virtual wallet. */
  getPortfolioRows(
    userId: string,
    sessionHash: string,
    kind: "positions" | "holdings",
  ): Promise<PortfolioRow[]>;
}

export class BrokerRequestCoordinator {
  private usersWithActiveRequests = new Set<string>();
  private waiters = new Map<
    string,
    Array<{
      resolve: () => void;
      reject: (cause: unknown) => void;
      signal: AbortSignal;
      abort: () => void;
    }>
  >();

  /** Release one owner-scoped broker slot and wake the oldest non-cancelled queued read. */
  private release(userId: string) {
    this.usersWithActiveRequests.delete(userId);
    const queue = this.waiters.get(userId);
    while (queue?.length) {
      const waiter = queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        continue;
      }
      this.usersWithActiveRequests.add(userId);
      waiter.resolve();
      break;
    }
    if (!queue?.length) {
      this.waiters.delete(userId);
    }
  }

  /** Reject overlapping operations and release the guard even when a request fails. */
  public async runExclusiveForUser<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.usersWithActiveRequests.has(userId)) {
      fail(409, "Another broker operation is in progress.");
    }
    this.usersWithActiveRequests.add(userId);
    try {
      return await operation();
    } finally {
      // Always release after success or failure; a rejected request must not lock the user out.
      this.release(userId);
    }
  }

  /** Queue a cancellable read behind one active broker operation instead of surfacing a transient 409.
   * The bounded queue protects memory while browser disconnects remove obsolete selections immediately.
   */
  public async runQueuedForUser<T>(
    userId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (this.usersWithActiveRequests.has(userId)) {
      const queue = this.waiters.get(userId) ?? [];
      if (queue.length >= 4) {
        fail(429, "Too many broker reads are waiting.");
      }
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          signal,
          abort: () => {
            const current = this.waiters.get(userId);
            const index = current?.indexOf(waiter) ?? -1;
            if (index >= 0) {
              current!.splice(index, 1);
            }
            if (!current?.length) {
              this.waiters.delete(userId);
            }
            reject(signal.reason);
          },
        };
        queue.push(waiter);
        this.waiters.set(userId, queue);
        signal.addEventListener("abort", waiter.abort, { once: true });
      });
    } else {
      this.usersWithActiveRequests.add(userId);
    }
    try {
      if (signal.aborted) {
        throw signal.reason;
      }
      return await operation();
    } finally {
      this.release(userId);
    }
  }
}
