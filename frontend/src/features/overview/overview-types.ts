/** Screen-facing contracts use INR, exchange units and epoch milliseconds.
 * Broker wire fields and token formats are confined to provider adapters. */
export type AccountMode = "paper" | "live";
/** Navigation targets understood by the workspace shell; no execution commands are exposed. */
export type OverviewDestination =
  | "Strategies"
  | "Strategy lab"
  | "Broker paper"
  | "Market data"
  | "Brokers"
  | "Live trading"
  | "Account & security"
  | "Activity log";
/** One open position, with signed units and optional broker-supplied INR valuation coefficients. */
export interface AccountPosition {
  id: string;
  instrument: string;
  exchange: string;
  symbol: string;
  quantity: number;
  averagePrice: number | null;
  markPrice: number | null;
  pnl: number | null;
  pnlBase: number | null;
  pnlPerMark: number | null;
  markedAt: number | null;
}
/** A point-in-time account read. Null means unavailable; an empty position list means verified flat. */
export interface AccountSnapshot {
  mode: AccountMode;
  availableFunds: number | null;
  pnl: number | null;
  positions: AccountPosition[] | null;
  capturedAt: number;
  warnings: string[];
}
/** Normalized cache quote, matched by exchange/token rather than display symbol. */
export interface PriceTick {
  instrument: string;
  exchange: string;
  price: number;
  receivedAt: number;
  fresh: boolean;
}
/** Read-only adapter boundary. Only provider implementations know broker API paths and payloads. */
export interface BrokerAccountAdapter {
  id: string;
  name: string;
  /** A read-only account adapter: screen navigation must never submit or arm orders. */
  loadPaperAccount(): Promise<{
    connected: boolean;
    snapshot: AccountSnapshot;
  }>;
  /** Load funds/open positions once; reject transport failures and preserve partial-report unknowns. */
  loadLiveAccount(csrf: string): Promise<AccountSnapshot>;
  /** Subscribe cached live positions with CSRF protection; never arm, submit or modify orders. */
  startPositionFeed(csrf: string): Promise<void>;
  /** Read normalized streamed quotes from the server cache, not recurring account reports. */
  readPriceTicks(): Promise<PriceTick[]>;
}
/** Minimal authenticated workspace data required by this screen; no broker credentials. */
export interface OverviewWorkspace {
  csrf: string;
  halted: boolean;
  live_configured?: boolean;
  strategies: { id: string; name: string; status: string }[];
  jobs: { id: string; status: string }[];
  events: { id: number; message: string; created_at: string }[];
}
