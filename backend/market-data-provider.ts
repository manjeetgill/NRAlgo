/** Application data boundary. No account reports, credentials or order execution. */
import type { MarketSnapshot, MarketSegment } from "./broker-data-access.js";
import type {
  CatalogInstrument,
  InstrumentSearch,
} from "./instrument-master.js";
import type { PaperInput, PaperQuote } from "./paper-trading-ledger.js";
import type {
  HistoricalRequest,
  HistoryInterval,
} from "./historical-market-data.js";

export type MarketDataSession = { userId: string; sessionHash: string };
/** Provider-owned contract directory. Callers never pass a broker name or assume token semantics. */
export interface InstrumentDirectory {
  isFresh(market: "cash" | "options"): boolean;
  search(
    input: InstrumentSearch,
  ): ReturnType<import("./instrument-master.js").InstrumentCatalog["search"]>;
  resolve(
    market: "cash" | "options",
    identity: {
      stockCode: string;
      expiryDate?: string;
      right?: string;
      strikePrice?: number;
    },
  ): CatalogInstrument;
  validate(
    input: Pick<PaperInput, "instrument" | "option" | "masterToken">,
    quantity?: number,
  ): void;
}
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
    historyIntervals: readonly HistoryInterval[];
    requiresBrokerConnection: boolean;
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
  /** Return canonical OHLCV for a bounded range; adapters own protocol/auth and session fencing. */
  getHistoricalCandles(
    userId: string,
    sessionHash: string,
    request: HistoricalRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
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
  if (!provider) {
    throw new Error(`Unsupported market-data provider: ${id}`);
  }
  return provider;
}
