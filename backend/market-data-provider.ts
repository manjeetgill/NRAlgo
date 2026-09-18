/** Application data boundary. No account reports, credentials or order execution. */
import type { MarketSnapshot, MarketSegment } from "./broker-data-access.js";
import type { InstrumentCatalog } from "./instrument-master.js";
import type { PaperQuote } from "./paper-trading-ledger.js";

export type MarketDataSession = { userId: string; sessionHash: string };
export type InstrumentDirectory = Pick<
  InstrumentCatalog,
  "isFresh" | "search" | "resolveResearch" | "validate"
>;
export type PriceSubscription = {
  kind: "touchline";
  mode: "subscribe";
  instruments: { exchange: MarketSegment; instrument: string }[];
};
export type PriceFeedSnapshot = {
  state: string;
  detail?: string;
  records: {
    type: string;
    exchange: string;
    instrument?: string;
    [key: string]: unknown;
  }[];
  notifications: unknown[];
};

export interface MarketDataProvider {
  readonly id: string;
  readonly capabilities: {
    live: boolean;
    historyIntervals: readonly ("1minute" | "5minute")[];
    requiresBrokerConnection: boolean;
    /** Existing saved tokens belong to this namespace, not to the selected source. */
    instrumentNamespace: string;
  };
  readonly instruments: InstrumentDirectory;
  isConnected(userId: string, sessionHash: string): boolean;
  prepareInstruments(
    session: MarketDataSession,
    market: "cash" | "options",
    reserveRequest: () => Promise<void>,
  ): Promise<void>;
  getPaperFillQuote(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment?: MarketSegment,
  ): Promise<PaperQuote>;
  getQuoteSnapshots(
    userId: string,
    sessionHash: string,
    instruments: string[],
    segment?: MarketSegment,
  ): Promise<MarketSnapshot[]>;
  getHistoricalCandlesForDay(
    userId: string,
    sessionHash: string,
    instrument: string,
    segment: MarketSegment,
    day: string,
    interval: "1minute" | "5minute",
  ): Promise<unknown[]>;
  startPriceFeed(
    userId: string,
    sessionHash: string,
    input: PriceSubscription,
  ): PriceFeedSnapshot;
  readPriceFeed(userId: string, sessionHash: string): PriceFeedSnapshot;
  stopPriceFeed(userId: string, sessionHash: string): void;
  disconnect(userId: string): void;
  close(): void;
}

/** Fail closed on misconfiguration; never silently substitute a different feed. */
export function selectMarketDataProvider(
  id: string,
  providers: readonly MarketDataProvider[],
) {
  const provider = providers.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unsupported market-data provider: ${id}`);
  // Existing database records and account positions use Kotak contract identities.
  // A new adapter must explicitly map these to its own tokens, not reuse token numbers.
  if (provider.capabilities.instrumentNamespace !== "kotak")
    throw new Error(
      "Market-data adapter must map the existing kotak instrument namespace.",
    );
  return provider;
}
