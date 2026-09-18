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
      this.usersWithActiveRequests.delete(userId);
    }
  }
}
