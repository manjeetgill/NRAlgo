# Broker history and option charts

The 18 September 2026 request supersedes the PDF's CSV-upload workflow. Backtest Studio now loads completed daily candles from the selected market-data provider. The existing cash/options strategy builder and historical simulator already use server-fetched broker history through `MarketDataProvider.getHistoricalCandlesForDay`; they do not accept CSV or client candles. Research never imports an execution adapter or places orders.

## Data path

`Backtest Studio / option chart → POST /api/market/history → MarketDataProvider → Kotak adapter → authenticated Kotak history API`.

The provider boundary owns canonical intervals (`day`, `1minute`, `5minute`). Kotak maps these to `D`, `1min`, `5min`, with session fencing, bounded response size and validation. Another provider implements the same interface and maps the existing instrument namespace explicitly; UI and calculation engines do not need its API syntax.

- App session, CSRF, per-user request coordination, rate limit, shared request budget and production MFA apply. Broker credentials never enter the browser.
- Exact symbol/expiry/right/strike resolves against the current master, then the requested token must match. Expired options are not silently mapped to a new expiry.
- Daily reads end before today (IST), at most 180 calendar days. Intraday reads allow today and span at most 30 days. Daily calculations require at least 60 valid candles and enough rule warmup; some parameter/range combinations therefore cannot run.
- Reject invalid, duplicate, unordered, future or out-of-range OHLC. No CSV fallback, synthetic candles, gap filling or assumed zero prices. Missing sessions remain missing; a complete trading-calendar audit is not implemented.
- New instrument/date selections abort obsolete reads and clear prior datasets/reports. Parameter edits invalidate results. Immutable report manifests include provider, exact history query, fetch time, adjustment caveat and SHA-256 data/configuration fingerprints. Results remain browser-local, not durable server jobs.
- An active Kotak data connection is currently required. No broker connection means no new historical fetch. Corporate-action adjustment and expired/delisted coverage are not independently guaranteed.

## Option chart

Select a call/put price, then **Open price chart**. The lazily loaded TradingView Lightweight Charts library renders broker OHLC with zoom/pan and IST labels. The contract drawer expands on desktop. Changing interval/date loads new history; **Reload broker candles** is explicit, not a timer.

The blue `Feed LTP` line uses the same option-chain tick, with contract/freshness checks. It does not reinterpret locally received timestamps as exchange candles, invent OHLC/volume, or refetch history on every tick. Historical candles and the streamed price line are intentionally distinct. Chart unmount removes observers/canvas and aborts pending history.

Lightweight Charts is only the renderer; it supplies no market-data service. Attribution is visible on the chart and publicly at `/legal/charting`.

Primary references: [Kotak historical API](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/historical-data.md), [Lightweight Charts API](https://tradingview.github.io/lightweight-charts/docs), [license/NOTICE](https://github.com/tradingview/lightweight-charts/blob/master/NOTICE).

Verification: `tests/backend/historical-market-data.test.mjs` covers request/candle boundaries, interval mapping, owner/auth/CSRF checks, exact token match and provider isolation; frontend regressions cover daily-data validation, calculation and provenance. Real Kotak response/entitlement verification requires a connected user session and is not implied by fixture tests.

Browser verification used a disposable database and isolated provider fixture (no real account or orders): instrument selection, historical load, calculated result/provenance, native date-change invalidation, insufficient-history error, chart open/close, candlestick rendering and interval changes. The final build also showed the blue feed LTP line matching the changing contract price, with only one history request while ticks continued; no browser console errors were reported. The fixture server, temporary schema and script were removed after verification. Fixture observations are not acceptance of real broker entitlements or completeness of historical coverage.
