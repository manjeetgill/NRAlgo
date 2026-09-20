"""Regression tests for state that must survive disposable calculation children."""

from __future__ import annotations

import os
import unittest

os.environ.setdefault("CALCULATION_SERVICE_TOKEN", "test-worker-token-that-is-not-a-secret")

from .worker import (  # noqa: E402
    MARKET_INSIGHT_CACHE_SECONDS,
    CalculationSupervisor,
)


class MarketInsightCacheTests(unittest.TestCase):
    def test_successful_market_insight_is_reused_until_expiry(self) -> None:
        supervisor = CalculationSupervisor()
        scope = {"method": "POST", "path": "/v1/market/insights"}
        key = supervisor.market_cache_key(scope, b'{"dataset":"fii-dii"}')
        self.assertIsNotNone(key)

        supervisor.remember_market_insight(key, 200, b'{"result":"fixture"}', now=10.0)
        self.assertEqual(
            supervisor.cached_market_insight(key, now=10.0 + MARKET_INSIGHT_CACHE_SECONDS - 1),
            b'{"result":"fixture"}',
        )
        self.assertIsNone(
            supervisor.cached_market_insight(key, now=10.0 + MARKET_INSIGHT_CACHE_SECONDS)
        )

    def test_errors_and_non_market_requests_are_not_cached(self) -> None:
        supervisor = CalculationSupervisor()
        self.assertIsNone(
            supervisor.market_cache_key(
                {"method": "POST", "path": "/v1/options/payoff"}, b"{}"
            )
        )
        key = supervisor.market_cache_key(
            {"method": "POST", "path": "/v1/market/insights"}, b"{}"
        )
        supervisor.remember_market_insight(key, 503, b'{"detail":"unavailable"}', now=1.0)
        self.assertIsNone(supervisor.cached_market_insight(key, now=1.0))


if __name__ == "__main__":
    unittest.main()
