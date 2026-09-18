# Screen implementation — 18 September 2026

Historical screen-build reference: **NRIAlgo_Latest_App_Screens.pdf**, 93 pages. The newer **NRIAlgo_Complete_Screen_Specifications.pdf** is now the acceptance source of truth; see [the complete specification audit](specification-audit.md) and [requirement register](specification-acceptance.json). The earlier implementation below is not evidence of compliance with the newer production contracts. Fictional reference prices, balances, reports, connection states and sample text are not application data.

## Screen commits

| PDF page | Screen | Separate implementation commit | Actual data/workflow |
| --- | --- | --- | --- |
| 1 | Overview | `778be3a` | Selected-domain account snapshot, shared cached marks, positions and audit shortcuts |
| 2 | Strategies | `a2c661b` | Owner-saved research definitions, search, market filters and editor navigation |
| 3 | Strategy library | `1f630ea` | Versioned EMA, RSI and channel rule definitions; configuration navigation |
| 4 | Backtest studio | `777b97a` (initial; broker-history update follows) | Broker daily OHLC selection, calculated signals, costs, equity, trade results and provenance export |
| 5 | Algo lab | `6f530ca` | Saved scheduled cash research, actual broker candles and saved reports |
| 6 | Spread builder | `311bb30` | Exact listed contracts, editable basket, historical research and analytic expiry risk |
| 7 | Paper trading | `518686f` | Separate virtual ledger with actual broker quotes; reviewed LIMIT orders when enabled |
| 8 | Option chain | `b2d55ad` | Shared feed, contract detail drawer, depth where available and research-leg selection |
| 9 | Orders & trades | `8c86569` | Selected-domain records, filters, details, safe CSV export and confirmed paper cancellation |
| 10 | Broker connections | `94cbc1d` | Kotak session status, connection/disconnection dialogs and explicit read-only reports |
| 11 | Live positions | `7417607` | Same account valuation model as Overview; position-exit review and guarded OMS controls |
| 12 | Account & security | `6611f21` | Actual profile, password dialog, MFA and owner-scoped session listing/revocation |
| 13 | Audit log | `3f5fb89` | Actual stored events, bounded search, derived categories, details and filtered export |

Follow-up integration fixes preserve complete spread drafts across navigation, prevent late library reads from overwriting edits, isolate screen markets, defer hidden-tab initialization and back off unavailable feeds. The shell supports fragment navigation, browser history and a mobile navigation drawer. Screen files remain separate and are loaded lazily.

## Real-data boundaries

- Kotak is the only implemented broker. Data-provider, account and execution contracts remain separate. Another provider needs an adapter, instrument mapping and contract tests, not just a URL change.
- No generated prices or invented account values appear as a fallback. Unknown values remain unavailable. Real-time acceptance still requires a connected account.
- `PAPER_TRADING_ENABLED=false` removes paper UI only; research, account tools and live views remain. Research capital is explicitly an assumption, not broker margin.
- Overview and Live positions use an initial/explicit account snapshot and cached stream marks. Cache reads do not repeatedly fetch broker reports.
- Complete spread definitions persist in account-scoped memory while navigating. They are not stored in localStorage. Sign-out/session replacement clears them.
- The old generated-price run API returns **410 Gone**. Local and Compose startup no longer launch its worker; standalone legacy worker startup is disabled. Existing database rows and regression helpers are retained without feeding dashboard metrics.
- Backtests load broker historical candles; provider/query provenance is recorded, while corporate-action adjustments are not independently verified. Signals use completed bars and next-open fills; stops/targets use documented ambiguity assumptions. See [broker history and charts](broker-history-and-charts.md).
- Audit categories are derived from stored messages, not authoritative server event types. Export covers only the loaded, filtered snapshot (latest 50 records), not the entire durable audit.
- Session device identity and last-active time are not collected, so neither is invented. Revocation does not close exchange positions.

## Reference features deliberately not represented as working

The document includes illustrative capabilities beyond the implemented backend. These are omitted or clearly unavailable rather than reporting success:

- ICICI and other unimplemented brokers.
- Automatic strategy deployment/start/pause scheduling and AI rule extraction.
- Hilega Milega execution without an agreed complete rule specification.
- Unrestricted short selling, multi-leg live execution and flatten-all.
- An exit review for an external broker position is not an executable preview. It routes to the existing server-validated OMS flow; exposure not owned/reconciled by that flow cannot be silently adopted.
- Market-order paper execution: the existing virtual ledger supports LIMIT/DAY only.
- Invented Greeks/IV/depth, generated backtests, sample fills and reset-to-fictional-account actions.
- The reference's presentation-only tour/reset controls are not trading capabilities.

## Verification and remaining release gates

- `npm run check`: passed, covering lint, compiled backend tests, frontend type checking, frontend tests and architecture checks. Test broker traffic is mocked and PostgreSQL schemas are disposable.
- `npm run build`: passed for the API and optimized Next application.
- Browser inspection: navigation, empty/disconnected states, real saved audit details, password-dialog open/close, spread draft persistence and actual MFA/session reads.
- Responsive checks at 390 × 844: Strategy library and Account & security had no page-width overflow; navigation opened, selected a destination and closed.
- The browser smoke script passed end-to-end against an isolated PostgreSQL schema and mocked Kotak transport. It covered cash/options paper fills, research, chart lifecycle, cached live marks and MFA; it did not call the real broker.
- The browser's installed writing extension modifies document attributes and causes a development hydration warning. Do not suppress application-wide hydration errors to hide this; verify in a clean browser profile in CI.
- Kotak was disconnected during final browser checks. Streamed-price changes, live fills, real margin reconciliation and broker reconnect acceptance remain unverified here.
- **No real orders, live arming, password changes, MFA changes or session revocations were performed against the user's account.** Live submission remains disabled in the local verification server.

This is an implemented real-data-oriented screen foundation, not a certification for unattended trading or a public production launch. Before enabling real submission, complete connected-broker acceptance, reconciliation/restart tests, deployment security checks and operational monitoring.
