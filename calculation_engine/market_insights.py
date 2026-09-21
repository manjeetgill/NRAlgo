"""Bounded read-only NSE reference data supplied by the optional nsefin package."""

from __future__ import annotations

import importlib
import math
import re
import threading
import time
from dataclasses import replace
from datetime import date, datetime, timezone
from numbers import Real
from typing import Any, Literal

MarketInsightDataset = Literal[
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

DATASETS: dict[str, dict[str, Any]] = {
    "fii-dii": {
        "label": "FII / DII activity",
        "method": "get_fii_dii_activity",
        "title": ("category", "type", "name"),
        "subtitle": ("date",),
        "metrics": {
            "Buy": ("buyValue", "buy_value", "buy"),
            "Sell": ("sellValue", "sell_value", "sell"),
            "Net": ("netValue", "net_value", "net"),
        },
    },
    "corporate-actions": {
        "label": "Corporate actions",
        "method": "get_corporate_actions",
        "title": ("symbol", "sm_name", "company"),
        "subtitle": ("subject", "purpose"),
        "metrics": {
            "Ex date": ("exDate", "ex_date"),
            "Record date": ("recordDate", "record_date", "recDate"),
            "Series": ("series",),
        },
    },
    "corporate-announcements": {
        "label": "Corporate announcements",
        "method": "get_corporate_announcements",
        "title": ("symbol", "sm_name", "company"),
        "subtitle": ("subject", "desc", "purpose"),
        "metrics": {
            "Published": ("an_dt", "date", "sort_date"),
            "Category": ("attchmntText", "category"),
        },
    },
    "upcoming-results": {
        "label": "Upcoming results",
        "method": "get_upcoming_results",
        "title": ("symbol", "company", "sm_name"),
        "subtitle": ("purpose", "subject"),
        "metrics": {"Date": ("date", "eventDate", "bm_date")},
    },
    "active-equities-value": {
        "label": "Most active equities by value",
        "method": "get_most_active_by_value",
        "title": ("symbol", "identifier", "underlying"),
        "subtitle": ("companyName", "meta.companyName", "series"),
        "metrics": {
            "Last": ("lastPrice", "ltp", "last"),
            "Change %": ("pChange", "percentChange"),
            "Volume": ("totalTradedVolume", "volume"),
            "Value": ("totalTradedValue", "value"),
        },
    },
    "active-index-calls": {
        "label": "Most active index calls",
        "method": "get_most_active_index_calls",
        "title": ("underlying", "symbol", "identifier"),
    },
    "active-index-puts": {
        "label": "Most active index puts",
        "method": "get_most_active_index_puts",
        "title": ("underlying", "symbol", "identifier"),
    },
    "active-stock-calls": {
        "label": "Most active stock calls",
        "method": "get_most_active_stock_calls",
        "title": ("underlying", "symbol", "identifier"),
    },
    "active-stock-puts": {
        "label": "Most active stock puts",
        "method": "get_most_active_stock_puts",
        "title": ("underlying", "symbol", "identifier"),
    },
    # Unlike the calls/puts datasets above (one type per table), this table mixes both,
    # so Type must be an explicit metric or same-underlying/strike rows are indistinguishable.
    "active-derivatives-oi": {
        "label": "Most active derivatives by OI",
        "method": "get_most_active_contracts_by_oi",
        "title": ("underlying", "symbol", "identifier"),
        "metrics": {
            "Type": ("optionType", "option_type"),
            "Strike": ("strikePrice", "strike"),
            "Expiry": ("expiryDate", "expiry"),
            "OI": ("openInterest", "oi"),
            "Volume": (
                "totalTradedVolume",
                "numberOfContractsTraded",
                "volume",
                "contracts",
            ),
        },
    },
    "active-derivatives-volume": {
        "label": "Most active derivatives by volume",
        "method": "get_most_active_contracts_by_volume",
        "title": ("underlying", "symbol", "identifier"),
        "metrics": {
            "Type": ("optionType", "option_type"),
            "Strike": ("strikePrice", "strike"),
            "Expiry": ("expiryDate", "expiry"),
            "Volume": (
                "totalTradedVolume",
                "numberOfContractsTraded",
                "volume",
                "contracts",
            ),
            "OI": ("openInterest", "oi"),
        },
    },
}

DERIVATIVE_METRICS = {
    "Last": ("lastPrice", "ltp", "last"),
    "Strike": ("strikePrice", "strike"),
    "Expiry": ("expiryDate", "expiry"),
    "Volume": (
        "totalTradedVolume",
        "numberOfContractsTraded",
        "volume",
        "contracts",
    ),
    "OI": ("openInterest", "oi"),
}

_cache: dict[str, tuple[float, dict[str, object]]] = {}
_provider_lock = threading.Lock()
CACHE_SECONDS = 120


def _key(value: object) -> str:
    """Normalize provider column names without trusting their punctuation/case."""

    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def _value(value: object) -> str | None:
    """Convert one scalar to bounded display text; reject missing/non-finite values."""

    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        text = value.isoformat()
    elif isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, Real):
        if not math.isfinite(float(value)):
            return None
        text = f"{value:g}"
    else:
        text = str(value).strip()
    return text[:160] if text else None


def _pick(row: dict[str, object], candidates: tuple[str, ...]) -> str | None:
    normalized = {_key(name): value for name, value in row.items()}
    for candidate in candidates:
        value = _value(normalized.get(_key(candidate)))
        if value is not None:
            return value
    return None


def _item(row: dict[str, object], config: dict[str, Any]) -> dict[str, object] | None:
    title = _pick(row, config["title"])
    if not title:
        return None
    subtitle = _pick(row, config.get("subtitle", ()))
    metrics = config.get("metrics", DERIVATIVE_METRICS)
    values = [
        {"label": label, "value": value}
        for label, candidates in metrics.items()
        if (value := _pick(row, candidates)) is not None
    ][:5]
    return {"title": title, "subtitle": subtitle, "values": values}


def load_market_insight(
    dataset: MarketInsightDataset,
    client: object | None = None,
) -> dict[str, object]:
    """Fetch one allowlisted nsefin dataset and normalize at most twelve rows."""

    config = DATASETS[dataset]
    using_default_client = client is None
    now = time.monotonic()
    if using_default_client:
        cached = _cache.get(dataset)
        if cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]
        # nsefin creates its NSE session during import, so import only after an
        # authenticated application request reaches this private service.
        client = importlib.import_module("nsefin").nse
        # nsefin 0.1.5 omitted the leading slash from this one endpoint. Keep
        # the pinned library's public method while correcting its immutable URL table.
        if dataset == "fii-dii" and client.endpoints.FII_DII == "api/fiidiiTradeReact":
            client.endpoints = replace(client.endpoints, FII_DII="/api/fiidiiTradeReact")
    if using_default_client:
        with _provider_lock:
            frame = getattr(client, config["method"])()
    else:
        frame = getattr(client, config["method"])()
    if frame is None or not hasattr(frame, "head") or not hasattr(frame, "to_dict"):
        raise RuntimeError("nsefin returned an unsupported result")
    records = frame.head(12).to_dict(orient="records")
    items = [item for row in records if (item := _item(row, config)) is not None]
    result: dict[str, object] = {
        "dataset": dataset,
        "label": config["label"],
        "provider": "nsefin",
        "observedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "items": items,
        "warning": "Public NSE reference data; not an executable quote or trading signal.",
    }
    if using_default_client:
        _cache[dataset] = (now, result)
    return result
