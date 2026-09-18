# Reading and debugging the code

The project uses ordinary TypeScript functions and classes. Financial calculations, broker
requests and screen code have different responsibilities; keeping those boundaries is more
important than reducing the number of lines.

The [repository map](repository-map.md) documents every owned source file and the
purpose of configuration, tests and tools. The [dated review](code-review-2026-09-18.md)
records fixed findings, known limitations and evidence. Update those documents when
moving a responsibility; comments are contracts that must stay true.

## Screen and hook structure

- `app/page.tsx` is only the Next route. `workspace-app.tsx` composes authentication
  and the signed-in shell. `workspace-shell.tsx` owns layout/navigation; it must not
  acquire broker credentials, calculate fills or hold another screen's form state.
- Each destination has `features/<screen>/<screen>-screen.tsx`. `workspace-content.tsx`
  lazily loads non-overview destinations with literal Next dynamic-import options.
  A keyed error boundary contains render failures without automatically repeating
  any mutation. Keep shared components only when more than one feature uses them.
- Name request lifecycles `use-<responsibility>.ts`, pure calculations `*-model.ts`,
  contracts `*-types.ts`, and network adaptation `*-api.ts`/`*-adapter.ts`. Component
  and hook names are broker-neutral. Keep Kotak in protocol adapters/diagnostics.
- Use `useState` for displayed state and `useRef` for request generations, in-flight
  locks and DOM handles. A ref lock prevents duplicate submissions before a busy
  state re-render; it is not a replacement for durable server idempotency.
- Use `useCallback` when identity is a hook dependency or part of a stable component
  contract. Use `useMemo` for material derived work (payoff curves, flattened fills),
  not every string or arithmetic operation. Neither hook is a security mechanism.
- Use `useEffect` only to synchronise external lifecycles: reads, subscriptions,
  clocks or native dialogs. Document its trigger, ownership and cleanup. Do not put
  a trade submission in an effect or invoke another setter inside a state updater.
- Reads must ignore/abort obsolete responses on navigation, account change and
  Strict Mode remount. `lib/latest-request.ts` provides that generation/abort gate.
  `use-workspace-session.ts` owns auth/workspace lifecycle, validates JSON, and polls
  sequentially only while paper jobs run. Do not restore unconditional root polling.
- API callbacks document the endpoint's purpose, units, authorization, errors and
  retry policy. Handle every promise rejection. Aborting a client request does not
  undo a broker mutation; reconcile uncertain submissions instead of retrying.
- Document named functions, exported contracts, effects and non-obvious callback
  blocks with intent and invariants. Explain why a dependency or guard exists, not
  every JSX field. Keep monetary display in rupees and execution/ledger values in
  integer paise; keep quantity units explicit.

Screens are separated now, but the existing research and paper screens still
contain substantial form code. Extract their own hooks/model/components when
changing those workflows; do not introduce a generic controller framework merely
to move lines. Existing wire names and database columns are compatibility contracts.

## Before adding the next screen

1. Add the screen under its feature, document its data/permission boundary, and
   register it in workspace navigation/content. Keep paper/live guards explicit.
2. Keep calculations pure and validate data at the API boundary. Never turn a
   missing broker value into a plausible zero or silently use a paper fallback.
3. Cover loading, empty, unavailable, denied, stale and superseded-read states.
   Mutation tests use fake brokers and verify idempotency/ownership.
4. Run `npm run check` and `npm run build`; inspect the actual screen in a browser.
   Run the isolated browser/container gates in CI before merging. Update the file
   map and release notes in the same commit. Do not enable real execution to test UI.

## Where to start

| What you are investigating                                        | Start here                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| How the local app starts                                          | `run.ts`                                              |
| Login, CSRF and API registration                                  | `backend/main.ts`                                     |
| Kotak login, HTTP headers or rejected requests                    | `backend/kotak-market-data-client.ts`                 |
| Market-data input validation and response parsing                 | `backend/kotak-market-data-contracts.ts`              |
| Market-data HTTP endpoints and request limits                     | `backend/kotak-market-data-routes.ts`                 |
| WebSocket authentication, message decoding and cleanup            | `backend/kotak-market-data-stream.ts`                 |
| Broker-independent read methods and per-user request coordination | `backend/broker-data-access.ts`                       |
| Simulated orders, balances and fill calculations                  | `backend/paper-trading-ledger.ts`                     |
| Paper trading HTTP endpoints and database writes                  | `backend/paper-trading-routes.ts`                     |
| Historical strategy calculations                                  | `backend/historical-strategy-simulator.ts`            |
| Saved research strategies and historical replay requests          | `backend/strategy-research-routes.ts`                 |
| Real positions/holdings response fields                           | `backend/broker-portfolio-normalizer.ts`              |
| Market-data form state and requests                               | `frontend/src/features/market-data/market-data-screen.tsx` |

Framework entry files such as `page.tsx` and `layout.tsx` keep their required Next.js names.
Broker field names such as `pSymbol`, `sid`, `ltp` and `neoSymbol` stay unchanged at the API
boundary so you can compare requests directly with Kotak's documentation.

## Follow a market-data request

1. `fetchSelectedMarketData()` reads the form. `buildMarketDataRequest()` creates the request body.
2. `registerKotakMarketDataRoutes()` validates that body and reserves the user's request budget.
3. `KotakMarketDataClient.fetchMarketData()` selects the signed-in user's broker connection.
4. `buildKotakMarketDataPath()` builds an approved endpoint path. The HTTP transport calls Kotak.
5. `parseKotakMarketDataResponse()` selects a small parser such as `parseHistoricalCandles()`.
6. The screen displays the result. None of these functions can place an order.

For streaming, start with `handleIncomingMessage()`. JSON messages go to
`handleBrokerControlMessage()`; binary prices go to `updateQuotesFromBinaryFrame()`.
`sendSubscriptionCommand()` changes the selected subscription, and `closeConnection()`
clears cached prices and closes the socket. The decoder retains broker-defined byte offsets;
those numbers are part of the protocol and must not be changed for stylistic reasons.

## Debug in VS Code

Stop an existing `make run` first so ports 3000 and 8000 are available. Select
**Run and Debug → Debug local workspace (API and web)**, then press F5. Open
`http://localhost:3000` manually. The configuration launches the existing TypeScript launcher
and enables child-process attachment; see [VS Code's Node debugging guide](https://code.visualstudio.com/docs/nodejs/nodejs-debugging).

Useful breakpoint locations:

- Before `fetchMarketData()` sends its HTTP request: inspect the operation and generated path.
- In the relevant response parser: inspect the sanitized fields and expected instrument identity.
- In `getPaperFillQuote()` and `matchPaperOrders()`: compare paise values and quote timestamps.
- In `handleBrokerControlMessage()`: distinguish initial feed values from successful authentication.

Broker tokens, MPIN, TOTP and session IDs can appear in debugger memory. Do not log them, share
screenshots containing them, or expose a debugging port on a public interface. Long pauses can
expire broker sessions and quotes; reconnect rather than bypassing freshness checks.

## Style for future changes

- Name functions for their action and result: `getPaperFillQuote`, not `quote`; `fetchSelectedMarketData`, not `run`.
- Use one declaration per statement. Prefer normal loops and `if`/`switch` when a chained expression is harder to step through.
- Use early returns for invalid input. Keep authentication, ownership, bounds and freshness checks visible.
- Use simple explicit field schemas. Do not add generic schema builders to save a few repeated fields.
- Comments explain purpose, units, failure behavior and non-obvious broker rules. Avoid repeating every assignment in English.
- Keep wire payload names unchanged when renaming local variables. Names in database columns and HTTP bodies are contracts.
- Prefer descriptive local names. Standard short names such as Express `req`/`res` are fine where their meaning is obvious.
- Do not add abstractions, folders or dependencies unless they make a concrete responsibility easier to understand.

After a refactor, run `make check`, `make build`, and `npm run test:browser`. Tests use fake brokers
and isolated PostgreSQL schemas; they must never place a real order. A readability refactor must
not change order matching, database data, public API payloads or broker authentication behavior.
## Market-data adapters

`backend/market-data-provider.ts` is the shared data boundary for instrument discovery,
display quotes, simulated-fill quotes, history and the dashboard price feed.
`backend/kotak-market-data-provider.ts` implements it using the existing Kotak client.
`MARKET_DATA_PROVIDER=kotak` is the default; unknown providers fail startup.

To add a source, implement `MarketDataProvider`, register it in the application
composition root, then change configuration. Account login, positions and limits
remain on the separate broker account dependency. No execution methods belong in
the market-data interface. The Kotak-specific Market data explorer remains a
broker diagnostic screen, not the shared application data API.

Compatibility: saved strategies, paper wallets and account tokens retain their
existing `kotak` instrument namespace. A replacement provider must explicitly
resolve those exact contracts to its own tokens (and map responses back); it must
not assume token numbers match. Providers with an unconverted namespace are
rejected. Do not silently migrate stored positions or substitute expired contracts.

Quotes use rupees for display and integer paise for simulated fills. History uses
OHLC with an explicit timestamp/IST datetime accepted by the replay validator.
Streaming records must preserve exchange + instrument identity, numeric `ltp`,
arrival `receivedAt`, and `receivedRecently`; arrival freshness alone does not
prove an executable quote. Use the stricter fill quote method for paper matching.
All operations must enforce user/session ownership, and logout/MFA changes must
release subscriptions. Missing/stale prices remain unavailable, not zero.

Shared routes: `/api/market/provider`, `/api/market/instruments`,
`/api/market/option-chain`, `/api/market/live-feed`, and `/api/market/feed`.
Legacy paper URLs remain compatibility aliases. Feed reads use the adapter's
memory cache, not repeated broker REST requests. A chain-only subscription does
not need a position snapshot. Historical results record the selected data source.
Capability checks reject unsupported live/history requests before fetching.

This does not add historical storage, an independent paid feed, or offline Kotak
history: Kotak still requires its authenticated session. Adapter replacement and
account separation are covered by `tests/backend/market-data-provider.test.mjs`.

## Kotak live execution (disabled by default)

`main.ts` now mounts `live/kotak-live-routes.ts` after authentication and CSRF.
`KotakLiveManager` binds the signed-in user's Kotak session and durable account
to `KotakLiveAdapter` and the existing `LiveExecutionService`/risk engine.
Paper/research do not import this execution path. Market-data selection does not
change the execution broker.

The **Live trading** page contains the real-money controls. Server activation
requires `LIVE_TRADING_ENABLED=true` and `KOTAK_STATIC_IP_CONFIRMED=true`.
Leave both false until the operator has registered the server's fixed outbound IP
with Kotak and completed deployment validation. Kotak's current requirement is
that authentication and order requests originate from the registered IP:
https://www.kotakneo.com/platform/kotak-neo-trade-api/static-ip-details/
Never enable these flags as part of tests. Run one API process (no replicas).

Supported: manual NSE EQ CNC and long NSE option NRML LIMIT/DAY orders with
current-master token, trading symbol, lot and tick validation. Prices/limits in
the API are integer paise; quantities are exchange units, not lots. Sells must
reduce a tracked long position. This is an app-side check, not a broker-native
reduce-only flag: use a dedicated account and do not trade it concurrently from
other clients. Futures, naked shorts, MTF/MIS, market/stop/AMO orders, modification,
automatic strategy execution and multi-leg live submission are not exposed.
The existing spread orchestrator is still offline-only pending segment margin
and execution-policy validation.

Flow (all mutations require the session CSRF header):

1. Connect Kotak under Brokers and enable app authenticator MFA.
2. `POST /api/live/configure` with `riskLimitsSchema` fields. Existing account
   limits are retained, not silently overwritten. The broker account must be
   initially flat with an empty day order book; existing positions are not adopted.
3. `POST /api/live/arm` with a fresh MFA `token` and confirmation
   `ENABLE REAL MONEY`. Reconciliation must succeed. Permission lasts five minutes
   and is bound to the app session, broker connection and this server instance.
4. `POST /api/live/instruments` searches the Kotak execution master, independently
   of the configured market-data provider. `POST /api/live/preview` accepts
   `{instrument: masterToken, side, quantity, limitPaise, reduceOnly}`. It returns
   a 30-second preview; price must be within 5% of a fresh broker quote.
5. `POST /api/live/orders` accepts only `{previewId, confirmation:"PLACE LIVE ORDER"}`.
   Repeating a valid confirmation references the same durable intent, never a
   new broker placement. An expired preview is rejected, not regenerated.
6. `GET /api/live/status`, `POST /api/live/reconcile`, and `POST /api/live/halt`
   expose state, reconciliation and cancellation requests. Halt never flattens
   positions or claims cancellation is confirmed. Check broker terminal state.

The manager reconciles books every two seconds while armed or orders remain
unresolved. This is an execution safety check, separate from the tick-driven
dashboard (not a replacement for streaming prices). The OMS commits SUBMITTING
before network I/O. Timeout, malformed acknowledgement or missing correlation
halts with an unknown outcome; there is no automatic placement retry. Only
orders whose tags and identities match persisted app intents can be cancelled.
Manual/untracked orders halt the account but are not cancelled.

Kotak RMS `Net` is available buying power, not settled cash. Snapshots explicitly
use `fundsBasis: "broker-rms"` with null cash-ledger values. Fresh buying power,
gross exposure, daily P&L/loss and position limits are checked; **cash-ledger funds
drift detection is unavailable** for this adapter. Do not advertise RMS figures as
reconciled settled cash or the generic notional guard as a SPAN margin engine.

Restarts, reconnects and permission expiry require explicit re-arming. Lost broker
access prevents guaranteed cancellation; inspect orders and exposure in Kotak.
Day-book rollover/carry-forward adoption and reconciliation drift require operator
review; this version does not automatically rebaseline or delete durable orders.
This is a bounded live-execution implementation, not a claim of production or
regulatory certification. Exchange approval, static IP, broker-specific live
acceptance testing and operational supervision remain deployment requirements.

`tests/backend/kotak-live.test.mjs` uses only offline broker responses and isolated
PostgreSQL schemas, testing payloads, correlation, auth/CSRF/MFA, idempotency,
unknown outcomes, expiry and cancellation ownership. Existing OMS tests cover
timeouts, restart recovery, drift and multi-leg safety independently.

### Workspace presentation mode

Set `PAPER_TRADING_ENABLED` in the root `.env` (or the API container environment),
then restart the API. This is a runtime setting returned by `/api/workspace`;
no frontend rebuild is needed.

- `false` (default): hide only paper-trading features. Strategies, Strategy Lab,
  Orders & Trades, market data and the learning guide remain available. Overview
  reads only real account funds/positions and never loads a virtual wallet.
  Strategies uses the research editor; backtests remain explicitly research and
  never become live orders automatically. Orders & Trades reads `/api/live/status`
  on entry or explicit refresh and shows only app-managed live OMS records, not
  replay fills or the broker's complete trade book. Missing history is unavailable,
  not an empty account. Explicitly paper/simulated audit messages are hidden;
  research/backtest and security events remain visible.
- `true`: the paper workspace, virtual balance and research tools are shown instead.

This setting only chooses the workspace UI. It does **not** enable real-money execution,
arm an account, disable existing API permissions, delete ledgers, or stop queued jobs.
`LIVE_TRADING_ENABLED`, broker/static-IP requirements, MFA and explicit arming remain
independent execution safeguards. Stored audit history is retained; filtering is only
for the displayed mode. Legacy events are identified by their explicit simulator labels.

Broker authentication uses the wallet-independent `/api/brokers/kotak/status` and
`/api/brokers/kotak/connect` endpoints. `/api/brokers/kotak/overview` loads real funds and
positions. Existing API aliases remain compatible with older clients.
