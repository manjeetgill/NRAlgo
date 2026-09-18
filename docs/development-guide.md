# Reading and debugging the code

The project uses ordinary TypeScript functions and classes. Financial calculations, broker
requests and screen code have different responsibilities; keeping those boundaries is more
important than reducing the number of lines.

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
| Market-data form state and requests                               | `frontend/src/components/kotak-market-data-panel.tsx` |

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
**Run and Debug → Debug local workspace (API and worker)**, then press F5. Open
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
