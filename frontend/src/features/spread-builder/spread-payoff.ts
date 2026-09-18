/** Exact piecewise-linear expiry payoff for same-underlying, same-expiry vanilla options.
 * Excludes fees, slippage and execution risk. Infinity explicitly represents unbounded tails.
 */
export interface PayoffLeg {
  right: "call" | "put";
  side: "buy" | "sell";
  strike: number;
  quantity: number;
  premium: number;
}
/** Evaluate marked premiums against intrinsic settlement, never treating missing prices as zero. */
export function optionPayoff(legs: PayoffLeg[], spot: number): number {
  return legs.reduce(
    (total, leg) =>
      total +
      (leg.side === "buy" ? 1 : -1) *
        leg.quantity *
        (Math.max(
          0,
          leg.right === "call" ? spot - leg.strike : leg.strike - spot,
        ) -
          leg.premium),
    0,
  );
}
/** Extrema occur at zero, strike breakpoints or the infinite call tail; interpolate finite roots. */
export function summarizePayoff(legs: PayoffLeg[]) {
  if (
    !legs.length ||
    legs.some(
      (leg) =>
        !Number.isFinite(leg.strike) ||
        leg.strike <= 0 ||
        !Number.isFinite(leg.premium) ||
        leg.premium <= 0 ||
        !Number.isSafeInteger(leg.quantity) ||
        leg.quantity <= 0,
    )
  ) {
    return null;
  }
  const spots = [...new Set([0, ...legs.map((leg) => leg.strike)])].sort(
    (a, b) => a - b,
  );
  const values = spots.map((spot) => optionPayoff(legs, spot));
  const tail = legs.reduce(
    (slope, leg) =>
      slope +
      (leg.right === "call" ? (leg.side === "buy" ? 1 : -1) * leg.quantity : 0),
    0,
  );
  const roots = new Set<number>();
  for (let index = 0; index < spots.length; index++) {
    if (values[index] === 0) {
      roots.add(spots[index]);
    }
    if (index && values[index - 1] * values[index] < 0) {
      roots.add(
        spots[index - 1] -
          (values[index - 1] * (spots[index] - spots[index - 1])) /
            (values[index] - values[index - 1]),
      );
    }
  }
  const last = spots.length - 1;
  if (tail && -values[last] / tail > 0) {
    roots.add(spots[last] - values[last] / tail);
  }
  return {
    maxProfit: tail > 0 ? Infinity : Math.max(...values),
    maxLoss: tail < 0 ? Infinity : Math.max(0, -Math.min(...values)),
    breakevens: [...roots].sort((a, b) => a - b),
  };
}
