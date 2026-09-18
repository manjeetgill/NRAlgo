/** Educational replay engine using deterministic synthetic prices and fictitious index units.
 * It never imports a broker or places orders. Illustrative costs omit exchange taxes and real
 * contract rules, so results must not be interpreted as an exchange backtest or expected profit.
 */
import type { SymbolCode, Trade, ReplayResult } from "./types.js";

/** Generate sample prices, apply an EMA crossover, and return fills/equity after a final close.
 * A fixed random seed makes tests reproducible. Positions cannot spend more than available cash.
 * A 2% sample-equity loss stops new entries; it is not a live-market risk-control implementation.
 */
export function simulateSyntheticStrategy(
  symbol: SymbolCode,
  capital: number,
  fast: number,
  slow: number,
): ReplayResult {
  let randomSeed = 42;
  /** Produce a deterministic pseudo-random value for sample-price noise, never for security. */
  const nextRandomValue = () => {
    randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
    return randomSeed / 4294967296;
  };
  /** Round display/fill amounts to two decimal places for this educational model. */
  const roundCurrency = (amount: number) => Math.round(amount * 100) / 100;
  const basePrice = { NIFTY: 24000, BANKNIFTY: 51000, SENSEX: 79000 }[symbol];
  const prices = Array.from({ length: 240 }, (_, bar) =>
    roundCurrency(
      basePrice * (1 + 0.006 * Math.sin(bar / 12) + 0.000025 * bar) +
        nextRandomValue() * 20 -
        10,
    ),
  );
  let fastEma = prices[0],
    slowEma = prices[0],
    positionQuantity = 0,
    entryPrice = 0;
  let availableCash = capital,
    equityPeak = capital,
    maximumDrawdown = 0,
    riskStopped = false;
  const trades: Trade[] = [],
    equity: number[] = [];
  prices.forEach((price, bar) => {
    fastEma += ((price - fastEma) * 2) / (fast + 1);
    slowEma += ((price - slowEma) * 2) / (slow + 1);
    if (availableCash + positionQuantity * price <= capital * 0.98) {
      riskStopped = true;
    }
    if (
      positionQuantity &&
      (fastEma < slowEma || riskStopped || bar === prices.length - 1)
    ) {
      const exitPrice = roundCurrency(price * 0.9995),
        proceeds = positionQuantity * exitPrice - 5;
      trades.push({
        bar,
        side: "SELL",
        price: exitPrice,
        quantity: positionQuantity,
        pnl: roundCurrency(proceeds - positionQuantity * entryPrice - 5),
      });
      availableCash += proceeds;
      positionQuantity = 0;
    } else if (
      !positionQuantity &&
      bar >= slow &&
      bar < prices.length - 1 &&
      fastEma > slowEma &&
      !riskStopped
    ) {
      entryPrice = roundCurrency(price * 1.0005);
      positionQuantity = Math.max(
        0,
        Math.floor((availableCash - 5) / entryPrice),
      );
      if (positionQuantity) {
        availableCash -= positionQuantity * entryPrice + 5;
        trades.push({
          bar,
          side: "BUY",
          price: entryPrice,
          quantity: positionQuantity,
          pnl: null,
        });
      }
    }
    const portfolioValue = availableCash + positionQuantity * price;
    equityPeak = Math.max(equityPeak, portfolioValue);
    maximumDrawdown = Math.max(maximumDrawdown, equityPeak - portfolioValue);
    equity.push(roundCurrency(portfolioValue - capital));
  });
  return {
    pnl: roundCurrency(availableCash - capital),
    drawdown: roundCurrency(maximumDrawdown),
    equity,
    trades,
    bars: prices.length,
    source: "synthetic",
    risk_stopped: riskStopped,
    cost_model: "0.05% slippage per fill + ₹5 per order; taxes excluded",
  };
}
