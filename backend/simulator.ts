// Educational synthetic index units, not exchange contracts. No broker orders.
import type { SymbolCode, Trade, ReplayResult } from './types.js';
export function replay(symbol: SymbolCode, capital: number, fast: number, slow: number): ReplayResult {
  let seed = 42;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const round = (n: number) => Math.round(n * 100) / 100;
  const base = { NIFTY: 24000, BANKNIFTY: 51000, SENSEX: 79000 }[symbol];
  const prices = Array.from({ length: 240 }, (_, i) => round(base * (1 + .006 * Math.sin(i / 12) + .000025 * i) + random() * 20 - 10));
  let fastEma = prices[0], slowEma = prices[0], qty = 0, entry = 0, cash = capital, peak = capital, drawdown = 0, stopped = false;
  const trades: Trade[] = [], equity: number[] = [];
  prices.forEach((price, i) => {
    fastEma += (price - fastEma) * 2 / (fast + 1);
    slowEma += (price - slowEma) * 2 / (slow + 1);
    if (cash + qty * price <= capital * .98) stopped = true;
    if (qty && (fastEma < slowEma || stopped || i === prices.length - 1)) {
      const fill = round(price * .9995), proceeds = qty * fill - 5;
      trades.push({ bar: i, side: 'SELL', price: fill, quantity: qty, pnl: round(proceeds - qty * entry - 5) });
      cash += proceeds; qty = 0;
    } else if (!qty && i >= slow && i < prices.length - 1 && fastEma > slowEma && !stopped) {
      entry = round(price * 1.0005); qty = Math.max(0, Math.floor((cash - 5) / entry));
      if (qty) { cash -= qty * entry + 5; trades.push({ bar: i, side: 'BUY', price: entry, quantity: qty, pnl: null }); }
    }
    const value = cash + qty * price;
    peak = Math.max(peak, value); drawdown = Math.max(drawdown, peak - value);
    equity.push(round(value - capital));
  });
  return { pnl: round(cash - capital), drawdown: round(drawdown), equity, trades, bars: prices.length,
    source: 'synthetic', risk_stopped: stopped, cost_model: '0.05% slippage per fill + ₹5 per order; taxes excluded' };
}
