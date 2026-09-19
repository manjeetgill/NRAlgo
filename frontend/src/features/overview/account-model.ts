/**
 * Shared account-display contracts and pure valuation helpers for overview and live positions.
 * Values use INR, exchange units and epoch milliseconds. Unknown marks remain unknown;
 * these presentation calculations never authorize execution or replace server risk checks.
 */
export type { TradingMode as AccountMode } from "@/lib/trading-mode";
import type { TradingMode as AccountMode } from "@/lib/trading-mode";
/** Navigation targets understood by the workspace shell; no execution commands are exposed. */
export type OverviewDestination =
  | "Portfolio"
  | "Strategies"
  | "Strategy lab"
  | "Broker paper"
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
  /** Read broker authentication without loading or creating a virtual ledger. */
  loadConnectionStatus(): Promise<boolean>;
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
  paper_trading_enabled?: boolean;
  strategies: { id: string; name: string; status: string }[];
  jobs: { id: string; status: string }[];
  events: { id: number; message: string; created_at: string }[];
}

/** Preserve known exposure during an outage, never interpret a failed read as a confirmed flat book.
 * Call only within the same authenticated account; the hook clears all state on account/mode changes.
 * A complete successful snapshot (including an empty book) replaces the old one normally. */
export function retainKnownExposure(
  previous: AccountSnapshot | null,
  incoming: AccountSnapshot | null,
  reason = "Broker disconnected. Last known exposure is retained; reconnect and refresh to reconcile.",
): AccountSnapshot | null {
  if (!previous || previous.mode !== "live") {
    return incoming;
  }
  if (!incoming) {
    return {
      ...previous,
      warnings: [...new Set([...previous.warnings, reason])],
    };
  }
  if (
    incoming.mode !== "live" ||
    incoming.positions !== null ||
    previous.positions === null
  ) {
    return incoming;
  }
  return {
    ...incoming,
    positions: previous.positions,
    pnl: previous.pnl,
    capturedAt: previous.capturedAt,
    warnings: [
      ...new Set([
        ...incoming.warnings,
        "Position reconciliation unavailable. Showing last known exposure and marks, not a confirmed current position book.",
      ]),
    ],
  };
}

/** Format INR without displaying missing or non-finite balances as zero. */
export function formatAccountMoney(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 2,
      }).format(value)
    : "—";
}

/** Never sum a partially known book into a misleading complete P&L figure. */
export function calculatePositionPnl(snapshot: AccountSnapshot) {
  if (
    !snapshot.positions ||
    snapshot.positions.some(
      /** Reject any unknown mark before aggregating the book. */ (position) =>
        position.pnl === null || !Number.isFinite(position.pnl),
    )
  ) {
    return null;
  }
  const total = snapshot.positions.reduce(
    /** Sum known per-position values, including a genuine zero for an empty book. */
    (total, position) => total + position.pnl!,
    0,
  );
  return Number.isFinite(total) ? total : null;
}

/** Apply one tick batch immutably so the headline and position table share a single state.
 * Exchange + token identifies a contract; symbols alone can collide across segments. */
export function applyPriceTicks(
  snapshot: AccountSnapshot,
  ticks: PriceTick[],
  now = Date.now(),
): AccountSnapshot {
  if (snapshot.mode !== "live" || !snapshot.positions) {
    return snapshot;
  }
  const freshTicks = new Map<string, PriceTick>();
  // Reject stale/future/invalid ticks, then keep the newest quote per exchange and token.
  for (const tick of ticks) {
    if (
      !tick.fresh ||
      !Number.isFinite(tick.price) ||
      tick.price < 0 ||
      !Number.isFinite(tick.receivedAt) ||
      tick.receivedAt > now ||
      now - tick.receivedAt > 15000
    ) {
      continue;
    }
    const key = `${tick.exchange}|${tick.instrument}`;
    if ((freshTicks.get(key)?.receivedAt ?? 0) <= tick.receivedAt) {
      freshTicks.set(key, tick);
    }
  }
  const positions = snapshot.positions.map(
    /** Mark each contract from its own tick without changing units or basis. */ (
      position,
    ) => {
      const tick = freshTicks.get(
        `${position.exchange}|${position.instrument}`,
      );
      if (
        !tick ||
        tick.receivedAt < (position.markedAt ?? 0) ||
        position.pnlPerMark === null ||
        !Number.isFinite(position.pnlPerMark)
      ) {
        return position;
      }
      // Prefer the broker's absolute coefficients; the delta fallback avoids compounding ticks.
      const pnl =
        position.pnlBase !== null
          ? position.pnlBase + tick.price * position.pnlPerMark
          : position.pnl !== null && position.markPrice !== null
            ? position.pnl +
              (tick.price - position.markPrice) * position.pnlPerMark
            : null;
      return {
        ...position,
        markPrice: tick.price,
        pnl: pnl !== null && Number.isFinite(pnl) ? pnl : null,
        markedAt: tick.receivedAt,
      };
    },
  );
  const next = { ...snapshot, positions };
  return { ...next, pnl: calculatePositionPnl(next) };
}

/** Display the audit date and time in IST rather than assuming the browser's time zone. */
export function formatActivityTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}
