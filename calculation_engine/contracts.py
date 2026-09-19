"""Strict bounded wire contracts accepted by the private calculation service."""

from __future__ import annotations

from datetime import date as CalendarDate
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    """Reject unknown fields so Node and Python cannot silently drift."""

    model_config = ConfigDict(extra="forbid", strict=True)


class DailyBar(StrictModel):
    """One validated daily OHLC observation."""

    # ISO dates necessarily cross the JSON boundary as strings. Keep the model
    # strict for numerical fields while allowing Pydantic's ISO-date decoder.
    date: CalendarDate = Field(strict=False)
    open: float = Field(gt=0, le=100_000_000)
    high: float = Field(gt=0, le=100_000_000)
    low: float = Field(gt=0, le=100_000_000)
    close: float = Field(gt=0, le=100_000_000)

    @model_validator(mode="after")
    def validate_range(self) -> "DailyBar":
        """Require high/low containment before numerical work starts."""
        if self.high < max(self.open, self.low, self.close):
            raise ValueError("High does not contain the daily prices")
        if self.low > min(self.open, self.close):
            raise ValueError("Low does not contain the daily prices")
        return self


class BacktestSettings(StrictModel):
    """Bound one supported strategy template and its capital assumptions."""

    template: Literal["ema", "rsi", "breakout"]
    first: int = Field(ge=2, le=500)
    second: int = Field(ge=2, le=500)
    capital: float = Field(ge=100, le=10_000_000)
    allocation: float = Field(gt=0, le=100)
    stop: float = Field(gt=0, lt=100)
    target: float = Field(gt=0, le=1_000)
    fee: float = Field(ge=0, le=10_000)
    slippage: float = Field(ge=0, le=500)

    @model_validator(mode="after")
    def validate_template(self) -> "BacktestSettings":
        """Apply template-specific parameter relationships."""
        if self.template == "ema" and self.first >= self.second:
            raise ValueError("Fast EMA must be shorter than slow EMA")
        if self.template == "rsi" and not 30 < self.second < 100:
            raise ValueError("Exit RSI must be above 30 and below 100")
        return self


class DailyBacktestRequest(StrictModel):
    """A complete immutable backtest calculation payload."""

    bars: list[DailyBar] = Field(min_length=60, max_length=10_000)
    settings: BacktestSettings

    @model_validator(mode="after")
    def validate_order(self) -> "DailyBacktestRequest":
        """Reject duplicate or unordered sessions instead of sorting silently."""
        days = [bar.date for bar in self.bars]
        if any(current <= previous for previous, current in zip(days, days[1:])):
            raise ValueError("Daily bars must be strictly ordered and unique")
        return self


class OptionLeg(StrictModel):
    """One signed vanilla-option position with premium and IV assumptions."""

    right: Literal["call", "put"]
    side: Literal["buy", "sell"]
    strike: float = Field(gt=0, le=10_000_000)
    quantity: int = Field(gt=0, le=10_000_000)
    premium: float = Field(ge=0, le=10_000_000)
    iv: float = Field(ge=0, le=5)


class PayoffRequest(StrictModel):
    """Bound one same-expiry scenario grid request."""

    legs: list[OptionLeg] = Field(min_length=1, max_length=12)
    spot: float = Field(gt=0, le=10_000_000)
    days: float = Field(ge=0, le=3_650)
    rate: float = Field(ge=-1, le=1)
    dividend: float = Field(ge=0, le=1)
    ivShift: float = Field(ge=-5, le=5)
    targetSpot: float = Field(gt=0, le=10_000_000)
    totalFees: float = Field(ge=0, le=1_000_000)


class StoredDailyStrategy(StrictModel):
    """Subset of saved research settings used by the stored-daily model."""

    schemaVersion: Literal[1] = 1
    name: str = Field(min_length=3, max_length=80)
    quantity: int = Field(gt=0, le=10_000)
    capital: float = Field(ge=100, le=10_000_000)
    marginReserve: float = Field(ge=0, le=10_000_000)
    stopLoss: float = Field(gt=0, le=10_000_000)
    targetProfit: float = Field(gt=0, le=10_000_000)
    slippageBps: float = Field(ge=0, le=500)
    feePerOrder: float = Field(ge=0, le=10_000)


class StoredDailyRequest(StrictModel):
    """One or more independent stored-daily research sessions."""

    strategy: StoredDailyStrategy
    candles: list[DailyBar] = Field(min_length=1, max_length=20)


class MarketInsightRequest(StrictModel):
    """One allowlisted public NSE reference dataset; never an execution input."""

    dataset: Literal[
        "fii-dii",
        "corporate-actions",
        "corporate-announcements",
        "upcoming-results",
        "active-equities-value",
        "active-index-calls",
        "active-index-puts",
        "active-stock-calls",
        "active-stock-puts",
        "active-derivatives-oi",
        "active-derivatives-volume",
    ]
