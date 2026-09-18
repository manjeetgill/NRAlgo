/** Pure Overview presentation and valuation functions; no network calls or account mutations. */
import type {
  AccountSnapshot,
  PriceTick,
} from "@/features/overview/overview-types";

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
