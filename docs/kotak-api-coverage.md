# Kotak market data and paper trading

Implemented against the [official market-data API directory](https://github.com/Kotak-Neo/Kotak-Neo/tree/main/docs/market-data-apis), reviewed 18 September 2026. No new paid service, SDK or runtime dependency was added. The application uses TypeScript and Node's built-in WebSocket.

## Using the app

Start with `make run`, create an app account and connect Kotak under **Broker connections**. Option chain, broker-backed history, paper pricing and live-position marks then use the configured provider automatically. Credentials stay on the server and must be entered again after logout/restart. Do not paste them in chat or commit them.

| Documented family                                                                                              | Provider implementation                                                                                                   | Boundaries                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Instruments](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/instruments.md)           | Official dated master links for NSE/BSE cash, NSE/BSE F&O, currency, MCX and NSE commodities                              | Only exact approved Kotak CSV paths. Searchable paper dropdowns remain NSE cash/options                                                                                |
| [Quotes](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/quotes.md)                     | All eight filters; up to 50 unique instruments; case-sensitive index names                                                | NSE/BSE cash/F&O and cde_fo. Unknown response fields removed, missing fields null, timestamp-based stale flag                                                          |
| [Expiries](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/expiries.md)                 | Native expiry lookup by underlying and option/fut type                                                                    | nse_fo, bse_fo, mcx_fo                                                                                                                                                 |
| [Option/futures chain](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/option-chain.md) | Native call/put/futures, OI changes and prices; optional expiry                                                           | Same three derivative segments; app caps strike count at 100 in increments of 10. No quote timestamp/bid-ask; indicative only                                          |
| [History](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/historical-data.md)           | 1/3/5/10/15/30/60min, D and W; preserves volume and nullable OI                                                           | Active contracts; NSE/BSE cash/F&O. Ordered inclusive ranges capped at 30/60/90/180 days by interval. 4 MiB/20,000 candles maximum; shorten rejected oversized queries |
| [WebSocket](https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/websocket.md)               | Server-side native_batch auth, all four detail modes, subscribe/unsubscribe/snapshot, index/full/mini/status/CAS decoding | All documented feed exchanges, one feed per owner, 50 instruments. Explicit reconnect; browser cache polling every 2 seconds consumes no broker REST calls             |

The app API is deliberately not a general URL proxy. PDF-defined screens use bounded provider-neutral routes for instrument discovery, option chains, history and the shared feed. Provider-specific request shapes stay behind `MarketDataProvider` and the Kotak adapter. Protected routes require an app session and CSRF for POST/DELETE. Broker requests share the 60/minute, 4,000/day research budget and production MFA gate. These are application limits, not a claim about Kotak entitlements.

## Streaming correctness and limitations

The server uses the login-returned `feedUrl`, converted from HTTPS to WSS. Only `/apifeed` on an already approved Kotak data center is accepted. An unfamiliar/missing feed host is rejected with a specific message; REST remains usable. Verify a new host against official documentation before expanding the allowlist.

The SID/UCC auth frame never reaches the browser. Native fallback is rejected, auth has a 10-second deadline, and all subscriptions/dividers are rebuilt on explicit reconnect. Logout, MFA changes, session expiry, replacement and shutdown close the socket and clear cached prices. Unattended feeds close after a 45-second viewer lease (checked every five seconds).

Binary decoding validates packet lengths and bitmasks, handles concatenated packets, reports truncated tails, uses exchange dividers and preserves int64 quantities/timestamps as strings. Published timestamp epoch/units are opaque, so stream records explicitly have `freshnessVerified: false`. Mini close and CAS reference prices are labelled raw because their scaling is not verified. No stream record is used for a paper fill. The 1 MiB frame limit is checked on receipt; Node assembles frames before the application sees them, so this is not a pre-allocation memory limit.

## Paper, research and real portfolio remain separate

- **Broker paper:** existing current-master NSE cash/options selection, validated bid/ask freshness, virtual ledger and P&L. Native chains/streams cannot bypass those checks.
- **Strategy lab:** 1/5-minute single-session and batch replays. No fabricated missing history or replacement tokens for expired contracts.
- **Broker portfolio/account reports:** read-only positions, holdings, funds, orders and trades; never credited into virtual funds.
- **Educational worker:** synthetic EMA demonstration, not unattended broker-connected execution.
- Real order APIs remain in the separately guarded live-execution boundary; market-data code cannot submit orders.

## Verification, not certification

Offline tests cover request filters/ranges, response identity, timestamp/price validation, secret stripping, binary protocol fixtures, session revocation, shared-route ownership/CSRF and budgets. Browser checks exercise Option chain, charts and paper/research flows with fake data. They do **not** prove real broker authentication, returned feed hosts, exchange entitlements, live binary compatibility or historical availability. The next acceptance test is a read-only real-account session during market hours; never use a real order to test this implementation.
