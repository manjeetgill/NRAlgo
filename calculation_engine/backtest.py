"""Vectorized indicators plus deterministic event-driven historical simulation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, time, timezone, timedelta

import numpy as np

from .contracts import BacktestSettings, DailyBar, StoredDailyStrategy


@dataclass
class Position:
    """Open long position created only at the next daily open."""

    signalDate: str
    entryDate: str
    entry: float
    quantity: int


def _ema(values: np.ndarray, period: int) -> np.ndarray:
    """Match the prior SMA-seeded EMA without using future values."""
    result = np.full(values.shape, np.nan, dtype=np.float64)
    if values.size < period:
        return result
    result[period - 1] = float(np.mean(values[:period]))
    alpha = 2.0 / (period + 1)
    for index in range(period, values.size):
        result[index] = result[index - 1] + alpha * (
            values[index] - result[index - 1]
        )
    return result


def _rsi(values: np.ndarray, period: int) -> np.ndarray:
    """Calculate Wilder RSI with the same flat-series convention as the old engine."""
    result = np.full(values.shape, np.nan, dtype=np.float64)
    gain = 0.0
    loss = 0.0
    for index in range(1, values.size):
        change = values[index] - values[index - 1]
        if index <= period:
            gain += max(change, 0.0) / period
            loss += max(-change, 0.0) / period
        else:
            gain = (gain * (period - 1) + max(change, 0.0)) / period
            loss = (loss * (period - 1) + max(-change, 0.0)) / period
        if index >= period:
            result[index] = (
                50.0
                if loss == 0 and gain == 0
                else 100.0
                if loss == 0
                else 100.0 - 100.0 / (1.0 + gain / loss)
            )
    return result


def run_daily_backtest(
    bars: list[DailyBar], settings: BacktestSettings
) -> dict[str, object]:
    """Run bounded next-open rules with deterministic gap and stop-first handling."""
    closes = np.array([bar.close for bar in bars], dtype=np.float64)
    highs = np.array([bar.high for bar in bars], dtype=np.float64)
    lows = np.array([bar.low for bar in bars], dtype=np.float64)
    fast = _ema(closes, settings.first)
    slow = _ema(closes, settings.second)
    strength = _rsi(closes, settings.first)
    prior_high = np.full(closes.shape, np.nan, dtype=np.float64)
    prior_low = np.full(closes.shape, np.nan, dtype=np.float64)
    for index in range(settings.first, closes.size):
        prior_high[index] = float(np.max(highs[index - settings.first : index]))
    for index in range(settings.second, closes.size):
        prior_low[index] = float(np.min(lows[index - settings.second : index]))
    warmup = (
        settings.first + 1
        if settings.template == "rsi"
        else max(settings.first, settings.second)
    )
    if len(bars) <= warmup + 1:
        raise ValueError("Not enough candles after indicator warm-up.")

    cash = settings.capital
    peak = cash
    drawdown = 0.0
    total_fees = 0.0
    skipped_entries = 0
    position: Position | None = None
    enter_next = False
    exit_next = False
    trades: list[dict[str, object]] = []
    equity: list[dict[str, object]] = []
    slip = settings.slippage / 10_000

    def close_position(price: float, day: str, reason: str) -> None:
        """Close current exposure once with adverse slippage and two fill fees."""
        nonlocal cash, position, total_fees
        if position is None:
            return
        exit_price = price * (1 - slip)
        pnl = (
            (exit_price - position.entry) * position.quantity - settings.fee * 2
        )
        cash += exit_price * position.quantity - settings.fee
        total_fees += settings.fee
        trades.append(
            {
                **asdict(position),
                "exitDate": day,
                "exit": exit_price,
                "pnl": pnl,
                "entryFee": settings.fee,
                "exitFee": settings.fee,
                "reason": reason,
            }
        )
        position = None

    for index, bar in enumerate(bars):
        day = bar.date.isoformat()
        if position is not None:
            stop = position.entry * (1 - settings.stop / 100)
            target = position.entry * (1 + settings.target / 100)
            if bar.open <= stop:
                close_position(bar.open, day, "Gap below stop")
            elif bar.open >= target:
                close_position(bar.open, day, "Gap above target")
        if position is not None and exit_next:
            close_position(bar.open, day, "Signal exit at next open")
        if position is None and enter_next:
            entry = bar.open * (1 + slip)
            budget = max(0.0, cash * settings.allocation / 100 - settings.fee)
            quantity = int(np.floor(budget / entry))
            if quantity > 0:
                position = Position(
                    signalDate=bars[index - 1].date.isoformat(),
                    entryDate=day,
                    entry=entry,
                    quantity=quantity,
                )
                cash -= entry * quantity + settings.fee
                total_fees += settings.fee
            else:
                skipped_entries += 1
        enter_next = False
        exit_next = False
        if position is not None:
            stop = position.entry * (1 - settings.stop / 100)
            target = position.entry * (1 + settings.target / 100)
            if bar.low <= stop:
                close_position(
                    min(bar.open, stop),
                    day,
                    "Stop (both stop and target touched; stop first)"
                    if bar.high >= target
                    else "Stop",
                )
            elif bar.high >= target:
                close_position(target, day, "Target")
        if index == len(bars) - 1 and position is not None:
            close_position(bar.close, day, "Final bar close")
        value = cash + (position.quantity * bar.close if position else 0)
        peak = max(peak, value)
        drawdown = max(drawdown, 100 * (peak - value) / peak)
        equity.append({"date": day, "value": value})
        if index < warmup:
            continue
        if settings.template == "ema":
            entry_signal = fast[index - 1] <= slow[index - 1] and fast[index] > slow[index]
            exit_signal = fast[index - 1] >= slow[index - 1] and fast[index] < slow[index]
        elif settings.template == "rsi":
            entry_signal = strength[index - 1] <= 30 and strength[index] > 30
            exit_signal = strength[index] >= settings.second
        else:
            entry_signal = bar.close > prior_high[index]
            exit_signal = bar.close < prior_low[index]
        enter_next = position is None and bool(entry_signal)
        exit_next = position is not None and bool(exit_signal)

    wins = [trade for trade in trades if float(trade["pnl"]) > 0]
    losses = [trade for trade in trades if float(trade["pnl"]) < 0]
    gross_loss = -sum(float(trade["pnl"]) for trade in losses)
    return {
        "settings": settings.model_dump(),
        "source": "historical daily OHLC",
        "from": bars[0].date.isoformat(),
        "to": bars[-1].date.isoformat(),
        "endingEquity": cash,
        "returnPercent": 100 * (cash - settings.capital) / settings.capital,
        "drawdownPercent": drawdown,
        "winRate": 100 * len(wins) / len(trades) if trades else None,
        "profitFactor": (
            sum(float(trade["pnl"]) for trade in wins) / gross_loss
            if gross_loss
            else None
        ),
        "totalFees": total_fees,
        "skippedEntries": skipped_entries,
        "equity": equity,
        "trades": trades,
    }


def run_stored_daily_session(
    candle: DailyBar, strategy: StoredDailyStrategy
) -> dict[str, object]:
    """Replay one isolated stored daily bar using the documented stop-first model."""
    quantity = strategy.quantity
    entry_price = round(candle.open * (1 + strategy.slippageBps / 10_000), 2)
    if (
        entry_price * quantity + strategy.feePerOrder + strategy.marginReserve
        > strategy.capital
    ):
        raise ValueError("Insufficient simulated capital for the stored daily entry.")
    stop_price = entry_price - strategy.stopLoss / quantity
    target_price = entry_price + strategy.targetProfit / quantity
    stop_touched = stop_price > 0 and candle.low <= stop_price
    target_touched = candle.high >= target_price
    exit_base = stop_price if stop_touched else target_price if target_touched else candle.close
    reason = (
        "daily stop touched (stop first when ordering is unknown)"
        if stop_touched
        else "daily target touched"
        if target_touched
        else "daily close"
    )
    exit_price = round(exit_base * (1 - strategy.slippageBps / 10_000), 2)
    pnl = round(
        (exit_price - entry_price) * quantity - strategy.feePerOrder * 2, 2
    )
    adverse = round(
        (candle.low - entry_price) * quantity - strategy.feePerOrder, 2
    )
    day = candle.date.isoformat()
    india_timezone = timezone(timedelta(hours=5, minutes=30))
    entry_time = int(
        datetime.combine(candle.date, time(9, 15), india_timezone).timestamp()
        * 1_000
    )
    exit_time = int(
        datetime.combine(candle.date, time(15, 30), india_timezone).timestamp()
        * 1_000
    )
    return {
        "source": "stored-eod",
        "model": "python-stored-daily-open-close-v1",
        "day": day,
        "points": [
            {
                "time": entry_time,
                "pnl": round((candle.open - entry_price) * quantity - strategy.feePerOrder, 2),
                "prices": [candle.open],
                "open": True,
            },
            {
                "time": exit_time,
                "pnl": pnl,
                "prices": [exit_base],
                "open": False,
            },
        ],
        "fills": [
            {
                "time": entry_time,
                "leg": 0,
                "action": "buy",
                "quantity": quantity,
                "price": entry_price,
                "fee": strategy.feePerOrder,
                "reason": "daily open",
            },
            {
                "time": exit_time,
                "leg": 0,
                "action": "sell",
                "quantity": quantity,
                "price": exit_price,
                "fee": strategy.feePerOrder,
                "reason": reason,
            },
        ],
        "pnl": pnl,
        "drawdown": round(max(0, -adverse), 2),
        "totalFees": round(strategy.feePerOrder * 2, 2),
        "warnings": [
            "Stored daily OHLC only; entry is modeled at the open and remaining "
            "exposure exits at the close.",
            "Intraday price ordering is unknown. If stop and target are both "
            "touched, the stop is applied first.",
            "Slippage and flat fees are assumptions; taxes, liquidity and "
            "corporate-action quality are not modeled.",
        ],
    }
