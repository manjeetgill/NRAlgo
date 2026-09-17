"""Deterministic educational replay. Synthetic index units, not exchange contracts."""
import math
import random


def replay(symbol, capital, fast, slow):
    rng = random.Random(42)
    base = {'NIFTY': 24000, 'BANKNIFTY': 51000, 'SENSEX': 79000}[symbol]
    prices = [round(base * (1 + .006 * math.sin(i / 12) + .000025 * i) + rng.uniform(-10, 10), 2) for i in range(240)]
    fast_ema = slow_ema = prices[0]
    qty = 0
    entry = 0
    cash = float(capital)
    trades, equity = [], []
    peak = capital
    drawdown = 0
    stopped = False
    for i, price in enumerate(prices):
        fast_ema += (price - fast_ema) * 2 / (fast + 1)
        slow_ema += (price - slow_ema) * 2 / (slow + 1)
        value = cash + qty * price
        if value <= capital * .98:
            stopped = True
        if qty and (fast_ema < slow_ema or stopped or i == len(prices) - 1):
            fill = round(price * .9995, 2)
            proceeds = qty * fill - 5
            pnl = round(proceeds - qty * entry - 5, 2)
            trades.append({'bar': i, 'side': 'SELL', 'price': fill, 'quantity': qty, 'pnl': pnl})
            cash += proceeds
            qty = 0
        elif not qty and i >= slow and i < len(prices) - 1 and fast_ema > slow_ema and not stopped:
            entry = round(price * 1.0005, 2)
            qty = max(0, int((cash - 5) // entry))
            if qty:
                cash -= qty * entry + 5
                trades.append({'bar': i, 'side': 'BUY', 'price': entry, 'quantity': qty, 'pnl': None})
        value = cash + qty * price
        peak = max(peak, value)
        drawdown = max(drawdown, peak - value)
        equity.append(round(value - capital, 2))
    return {'pnl': round(cash - capital, 2), 'drawdown': round(drawdown, 2), 'equity': equity,
            'trades': trades, 'bars': len(prices), 'source': 'synthetic', 'risk_stopped': stopped,
            'cost_model': '0.05% slippage per fill + ₹5 per order; taxes excluded'}
