# NRIAlgo terminal

A single-user trading workspace with React/Next.js, an Express API, PostgreSQL and a private Python calculation service. Real execution is disabled by default. A successful build is not certification for live trading.

## How to use this guide

This is the app's combined user guide and operator runbook, reviewed against the working-tree implementation on 20 September 2026. It describes implemented workflows, not a promise that every broker, dataset or deployment is currently available. Screen labels and capabilities can differ from older screenshots. The documentation review itself does not place orders, change security settings or certify production readiness.

- [First-time setup and sign-in](#first-time-setup-and-sign-in)
- [Screen directory](#screen-directory)
- [Daily workflow](#daily-workflow)
- [Screen-by-screen user guide](#screen-by-screen-user-guide)
- [Data labels and calculation terms](#data-labels-and-calculation-terms)
- [Troubleshooting](#troubleshooting)
- [Operator data refresh](#operator-data-refresh)
- [Architecture responsibilities](#responsibilities), [local setup](#local-setup) and [code map](#code-map)
- [Deployment](#single-host-deployment), [backups and recovery](#backups-alerts-and-recovery) and [security maintenance](#sensitive-data)

### Important boundaries

- Research, broker connection and live execution are separate. A payoff or backtest never places an order.
- In **Spread builder**, B/S adds a research leg. In **Option chain**, available live B/S controls open an order review; final submission is a separate, explicit action.
- Stored closing prices and snapshots are not executable quotes. Read the source, date and warning before using a value.
- A blank, unavailable or stale balance does not mean zero. An order acknowledgement does not mean a fill.
- The standalone options Simulator is not an available screen. Algo lab's stored daily cash-basket replay is a different feature, not an options tick-replay engine.
- No broker connection, strategy save, backtest or app restart automatically authorizes live trading.

## First-time setup and sign-in

For installation commands, see [Local setup](#local-setup). For an already running local app:

1. Open `http://localhost:3000/`. Wait for the authentication check to finish.
2. On the first installation, use **Create account**. Supply the deployment's bootstrap token if the form requests it. Obtain this privately from the operator; do not put it in Git or screenshots.
3. Otherwise enter your username and password and select **Sign in**. Complete the authenticator/recovery-code prompt when required.
4. Registration is available only when the operator has enabled it; an invitation token may also be required. A hidden registration form is not a login error.
5. Open **Settings → Account & security** and set up MFA before changing the active live broker or enabling live trading.
6. For stored-data research, go directly to Watchlists or Backtest studio. A broker is not required for their imported daily history.
7. For broker account information or broker market data, authorize a supported connection under **Settings → Broker connections**.

Signing out ends the app session; do not assume the app can continue managing live execution afterward. Use the broker's own account interface to verify any unresolved orders or exposure.

## Screen directory

Routes below are appended to the app origin, for example `http://localhost:3000/#/spread-builder`.

| Menu | Screen | Route | Main purpose |
| --- | --- | --- | --- |
| Overview | Overview | `/#/overview` | Account summary, disclosures and readiness |
| Strategies | Strategies | `/#/strategies` | Find and reopen saved research definitions |
| Strategies | Strategy library | `/#/strategy-library` | Review signal rules and configure a backtest |
| Strategies | Algo lab | `/#/algo-lab` | Save and test daily cash-basket research |
| Strategies | Spread builder | `/#/spread-builder` | Build option legs and calculate payoff scenarios |
| Backtesting | Backtest studio | `/#/backtest-studio` | Run daily EMA, RSI or breakout backtests |
| Markets | Watchlists | `/#/watchlists` | Organize stored instruments and inspect charts |
| Markets | Portfolio | `/#/portfolio` | Read one or consolidated broker portfolios |
| Markets | Option chain | `/#/option-chain` | Inspect contracts, Greeks and research/order handoff |
| Trading | Orders & trades | `/#/orders` | Inspect app-managed orders and acknowledged fills |
| Trading | Live positions | `/#/live-positions` | Monitor tracked exposure and execution controls |
| Settings | Broker connections | `/#/brokers` | Authorize, verify, disconnect and select brokers |
| Settings | Account & security | `/#/security` | MFA, password and app sessions |
| Settings | Audit log | `/#/audit` | Filter, inspect and export recorded events |

Expand a grouped sidebar menu to choose a screen. The header also offers theme selection, full screen, account access, help and the product tour. Browser Back/Forward and fragment bookmarks identify screens, not saved form state. Read unsaved-change warnings before leaving an editor.

## Daily workflow

### Research-only session

1. Sign in; leave live trading disabled.
2. Check the dataset dates in Watchlists or Backtest studio.
3. For options, open Spread builder, choose a scrip and expiry, and check the snapshot date.
4. Add research legs, review assumptions and inspect the payoff/scenario table.
5. For indicator rules, choose a library template and run Backtest studio on loaded history.
6. For a scheduled daily basket, use Algo lab and explicitly save the definition before running it.
7. Preserve results or definitions using the controls that the particular screen actually provides. The manual Spread builder draft is not an automatically saved strategy.

### Before considering live execution

1. Check broker connection health and the selected active broker.
2. Confirm app MFA is enabled and the broker supports execution in this app.
3. Check account data freshness, current broker orders and positions.
4. Review the server's execution status, configured risk limits and reconciliation outcome.
5. Resolve every unknown order, unexplained position or halted state before proceeding.
6. Only then follow the explicit live-order workflow below. These steps are operational instructions, not a recommendation to trade.

## Screen-by-screen user guide

### 1. Overview

1. Open **Overview** and wait for account sections to load.
2. Check the displayed account/provider and observation time before interpreting funds, holdings or positions.
3. Expand holdings/position disclosures to understand which values are available and how they are presented.
4. Read **Before you go live** and follow the relevant security or execution-requirements link. **Authenticator MFA Required** means the app's second factor must be enrolled; it is not a broker OTP request.
5. Review public market-reference sections separately from broker account values. A failed reference-data panel does not prove the account balance is unavailable, and vice versa.
6. Use the relevant navigation link to continue into option research, broker setup or position monitoring.

Expected result: an account summary with explicit unavailable/partial states. Do not treat public NSE reference data, historical closing prices and broker live marks as interchangeable.

### 2. Spread builder

**Purpose:** editable option-payoff research for one underlying and a common expiry, not automatic strategy execution.

1. Open **Strategies → Spread builder**.
2. Choose a quick index such as NIFTY, or type at least two characters in **Search scrip** and select an actual result, such as RELIANCE. Merely typing does not select the instrument.
3. Wait for expiry choices and premiums. The builder targets current and next available unexpired expiries; available contracts depend on the provider or imported snapshot.
4. Read the source badge, observation date, spot and warning. If broker quotes are denied/unavailable, an eligible saved broker snapshot or NSE closing snapshot may be shown explicitly as research-only.
5. Select the expiry. Check that it is the intended contract date, not just the nearest date.
6. Use **B** or **S** beside a contract to add a buy or sell research leg. Strike, option type, expiry, premium and verified lot size are copied into the editor.
7. Check **Strategy legs**. Edit side, CE/PE, strike, lots, lot size, premium and IV as needed. Units equal lots multiplied by lot size. A manual edit is an assumption, not a newly verified broker quote.
8. Use the leg checkbox to exclude/include it in the calculation; use its remove control to delete it from this draft. **Add leg** creates a manual research input.
9. Check spot, valuation date and common expiry. A closing snapshot uses its observation date so it is not silently valued as a fresh live quote.
10. Wait for **Payoff analysis**. Review expiry max profit/loss, net debit/credit, breakevens and the graph. Change **Payoff view** to **Scenario table** for sampled numerical outcomes.
11. Expand **Payoff settings and Greeks**. Change target price, **Days passed** or **IV change**; inspect estimated target-date P&L and aggregate Greeks. Target price must lie within the supported scenario range.
12. Expand **Model assumptions** to inspect/change the risk-free rate and dividend yield when appropriate.
13. **Refresh quotes** reloads chain observations; do not assume it rewrites premiums already entered in your draft. **New spread** clears the current editor after confirmation when needed. **Change scrip** starts a different selection and may discard the draft.

Constraints and interpretation:

- At most 12 legs. Chain additions reject duplicate contracts and mixing a different underlying/expiry into an existing spread.
- A contract without a verified lot size cannot be treated as a ready-to-use listed lot. Check the message rather than guessing units.
- IV defaults to 20% unless edited; it is not automatically fitted to each entered premium in this editor. Target-date model P&L can therefore differ from zero even at unchanged spot with zero days passed.
- Expiry payoff uses entered premiums; target-date P&L is a model estimate. Neither is broker-reported P&L, guaranteed return or required margin.
- Results shown before costs are not net realized returns. Research selling does not imply that the live execution adapter supports opening short options.
- Manual drafts last only while this builder is open. Do not rely on refresh, navigation, sign-out or browser restart to preserve them. Saved Algo lab research and manual payoff drafts have different lifecycles.

### 3. Option chain

1. Open **Markets → Option chain**.
2. Choose an index from **Index / Stock**, or choose **Search stock…** and select a search result.
3. Choose the available expiry and wait for the chain. Read source, timestamp, stale/missing-value notices and any provider warning.
4. Start with **Premiums & strike**. Select **All columns & Greeks** to inspect the additional available analytics. Missing values remain unavailable; they are not zero.
5. Select a premium to inspect the contract or add a research payoff leg using the offered controls.
6. Select **Build payoff** once the chain has a valid reference. Verify the underlying, expiry, valuation date, premium and lot size after the handoff.
7. Expand **Historical price chart** to use the independent stored-data chart. It is not proof that option premiums are streaming live.
8. With an eligible live data mode and connected active broker, B/S can open **Review option order**. Review and submission remain separate. A historical snapshot cannot authorize a live order.

The standalone chain and the builder have different controls and data requirements. An underlying's daily cash candles alone do not provide its option premiums. IV/Greeks are calculated estimates and may be unavailable for unsuitable or incomplete prices.

### 4. Watchlists and charts

1. Open **Markets → Watchlists**.
2. Select an existing list, or use the list-creation control and enter a name.
3. Search the stored catalog and add the exact instrument. Similar symbols on different exchanges are not necessarily the same instrument.
4. Click a scrip row to load its stored daily chart.
5. Change the available chart range and add/remove supported indicators, such as RSI, through the chart controls.
6. Remove unwanted scrips using their row controls; choose another list to continue.

Lists are saved to PostgreSQL, with limits of 10 lists and 100 scrips per list. New accounts start with NIFTY and BANKNIFTY. These charts use stored daily data and do not require broker authorization. Check coverage and volume messages; absent data is not generated. The embedded chart is the app's KLine-based chart, not an authenticated TradingView Advanced Charts integration.

### 5. Strategies and Strategy library

**Strategies** lists saved research definitions:

1. Open **Strategies → Strategies**.
2. Search by the provided search field; narrow the market filter if required.
3. Open a matching saved definition to continue its supported research workflow.
4. If no result appears, clear the search/filter before assuming a strategy was deleted.
5. Saving a definition does not deploy, start or schedule real trading.

**Strategy library** describes the rules used by Backtest studio:

1. Read a template's entry, exit and assumptions.
2. Configure **EMA crossover**, **RSI recovery** or **Channel breakout** to open the corresponding backtest.
3. Treat any reference-only item as descriptive, not a runnable implementation.

EMA enters on the fast EMA crossing above the slow EMA; RSI recovery enters on an upward crossing of 30; channel breakout enters when the close exceeds the preceding entry window's highest high. Read the actual exit rules and parameter labels before running.

### 6. Backtest studio

1. Open **Backtesting**, or configure a supported template in Strategy library.
2. Select an exact instrument from the stored catalog. Check its available first/last dates.
3. Choose **From (IST)** and **To (IST)** inside the available range.
4. Select **Load stored history**. Check candle count, data source and adjustment policy.
5. Set the rule periods/thresholds, capital, allocation, stop, target, fee and slippage fields. The defaults are examples, not suitable-risk recommendations.
6. Read the readiness explanation. At least 60 valid candles and sufficient indicator warm-up are required; some settings require substantially more than 60.
7. Select **Run backtest**. The app queues a Python calculation and displays progress. Use **Cancel calculation** if needed; cancellation is a calculation action, not a broker cancellation.
8. Review net return, drawdown, the calculated equity curve and trade ledger. Recheck assumptions before comparing two runs.
9. Changing history or parameters invalidates the previous report; load/run again rather than interpreting stale results.

Model scope: daily long-only cash-equity-style simulation, integer units, no leverage, one position. Completed-bar signals fill at the next open. Stops/targets use the entry fill; a gap can exit at the open; when both are touched within a bar, stop is assumed first. Adverse slippage and a flat fee apply per fill. Remaining positions close at the final bar close. Drawdown uses closing equity. Taxes, corporate actions, liquidity constraints and exact intrabar sequencing are not fully modeled. An index series used for research is not an executable index-cash order.

Heavy backtests are paused when server live-trading capability is enabled, even if the account is not currently armed. Do not disable production safeguards just to make a research job run.

### 7. Algo lab: saved daily basket research

1. Open **Strategies → Algo lab** or reopen an appropriate saved research definition.
2. Create/edit the definition name and cash legs using exact stored instruments and quantities.
3. Enter simulated capital, assumed margin reserve, basket stop/target, slippage and fee assumptions.
4. Read the daily fill model: entry at open, exit at stop, target or close. Stored daily OHLC cannot establish the order of intraday events.
5. Select **Save research strategy**. An unsaved definition cannot run the stored daily simulation.
6. Choose a covered session and select **Run stored daily simulation**.
7. Inspect the backtest results, saved replay and available playback/trade-log controls. Playback walks through available observations; it does not create missing intraday ticks.
8. For multiple independent sessions, add dates to the batch (maximum 20), then select **Run batch backtest**. Review both completed and skipped dates.
9. Each batch day starts with the same capital; results do not compound across days and do not model overnight exposure.
10. Explicitly save edits you want to keep. On an unsaved-change prompt, **Keep editing** preserves the edit session; discarding abandons unsaved changes.

Deleting saved research also removes its replay history and requires deliberate confirmation; it does not cancel live orders. Historical option replay is not made available merely by importing a closing option chain. Use Spread builder for current/next-expiry option payoff research and Backtest studio for indicator-signal strategies.

### 8. Portfolio

1. Open **Markets → Portfolio** after authorizing the accounts you want to inspect.
2. Select a specific account or **All portfolios**.
3. Use the refresh control when needed and check snapshot time and account coverage. A partial refresh is not a complete consolidation.
4. Review account equity, holdings value, open-position P&L, cash, available/used margin, pledged holdings and collateral as separate measures.
5. Expand consolidated rows to inspect their per-account breakdowns.
6. Read portfolio performance only for the captured history. Current holdings do not reconstruct five years of prior portfolio composition or cash flows.

This is read-only portfolio reporting. It does not rebalance or transfer positions. Pledged value and available margin must not be added again to holdings as if they were extra assets. Unknown broker sections remain unavailable. Daily snapshot capture is attempted for authenticated sessions; disconnected sessions can leave history gaps.

### 9. Broker connections

**Kotak Neo**

1. Open **Settings → Broker connections** and select the Kotak connection action.
2. Enter API access token, mobile number, client code (UCC), broker authenticator TOTP and MPIN in the app form yourself. This broker TOTP is distinct from NRIAlgo's app MFA. Never paste credentials or OTPs into chat, issue reports or documentation.
3. Submit once and wait for the verified connection state or actionable error.
4. Check connection expiry and account information. Verify account reads before attempting execution.
5. Use disconnect deliberately. Disconnect does not mean outstanding broker exposure has been closed.

**Zerodha Kite**

1. Open **Set up Zerodha** and read the exact callback URL generated for this installation.
2. Configure that callback on your Kite app and enter its API key/secret in the protected setup form.
3. Saving changed app credentials invalidates the previous connection; authorize again afterward.
4. Select **Authorize with Zerodha**, authenticate on Zerodha's own page, then complete authorization when returned to NRIAlgo.
5. Use **Verify Zerodha session** and confirm the account/expiry shown.
6. Account reports are read-only. The builder also has a bounded instrument-master/quote-snapshot adapter; quote access depends on the Kite app's permission. This is not a Zerodha streaming or order-execution adapter.

Some broker-card text still says Zerodha market-data screens are not integrated. That wording predates the builder snapshot adapter; it must not be interpreted as live-stream or order-execution support. A successful login/profile read does not establish that quote access is allowed.

**Changing the active live broker**

1. First connect the intended account and enroll app MFA.
2. Choose it in **Active live broker**.
3. Read the confirmation and supply a fresh app authenticator or unused recovery code.
4. Confirm the selection; verify the selected provider afterward.
5. Existing orders and positions stay with their original broker. Switching clears live permission; it does not move or close exposure or automatically route an unsupported order elsewhere.

### 10. Live positions and real-order workflow

This section describes consequential real-money controls. Use only after the operator has validated deployment and recovery, and only for an order you independently intend to submit. The implemented execution adapter is Kotak; unsupported providers fail closed. Current scope is LIMIT/DAY, NSE cash CNC and long options NRML. Selling reduces an app-tracked long position; opening a short option position is not supported by this workflow.

TradingView alerts are a separate draft-only input. Generate the owner-specific HTTPS webhook URL in **TradingView order drafts**, copy the displayed JSON template into TradingView and keep the URL private. A valid alert creates a durable draft; duplicate alert IDs are ignored. **Accept draft** acknowledges the alert and prefills the guarded live-order ticket, but it never previews, reserves or submits a broker order. The user must still select the exact active-broker contract, review the terms, create a preview and explicitly submit; an alert symbol never bypasses those controls.

1. Open **Trading → Live positions** and use **Check live status**.
2. Distinguish **Server capability** from temporary **Live trading** permission. If the server is locked, broker login cannot unlock it. The operator must satisfy configuration/static-IP requirements first.
3. When offered, configure maximum reserved capital, gross exposure, position units, daily loss and orders per minute, then save the risk limits. Choose your own reviewed limits, not arbitrary values to bypass validation.
4. Select **Reconcile broker books**. Investigate discrepancies, unknown submissions or unexplained carry. Do not edit database state to force a clean result.
5. To authorize a five-minute window, provide a fresh app authenticator/unused recovery code, type `ENABLE REAL MONEY`, and explicitly select **Enable live trading**. A code consumed during broker selection cannot be reused.
6. In order review, choose market and search the active broker's exact contract. Verify symbol, expiry, strike, option type, lot size and product.
7. Enter side, quantity in exchange units and limit price. Option quantities must respect the verified lot size; lots and units are not interchangeable.
8. Select **Preview real order**. Review contract, quantity, side, price, notional and preview expiry. This is not the final submission.
9. Only if those terms are intended, type `PLACE LIVE ORDER` and select **Place live order**. That final action can transmit a real order to the broker.
10. Read the returned state, reconcile, and inspect Orders & trades. A pending/unknown result is not permission to resubmit: check the broker book first to prevent duplicates.
11. Use **Disable live trading + cancel pending orders** when stopping execution. This blocks new submissions and requests cancellation of app-managed pending orders; it does not close filled positions and cancellation must still be verified.

Position details are not an automatic exit. Review tracked exposure and use the supported explicit order flow for an intended reduction. External/untracked broker positions, expiry settlement and corporate actions may require operator review. An API restart does not preserve the armed window. If the app cannot confirm broker state, use the broker interface to inspect the account; do not assume a disconnected screen means flat exposure.

### 11. Orders & trades

1. Open **Trading → Orders & trades** and select **Refresh orders**.
2. Inspect contract, side, requested quantity, limit price, acknowledged filled units and state.
3. Read errors and stale-record notices before relying on previously loaded rows.
4. If history is unavailable, use **Open Live positions** to check execution readiness and broker status.
5. Cross-check uncertain outcomes with the broker and reconciliation instead of placing the same order again.

This screen contains app-managed orders, not every trade placed in the broker's own app and not a complete exchange trade book. A limit price is not necessarily the actual average fill price. A broker acknowledgement and final execution are different events.

### 12. Account & security

**Enroll an authenticator**

1. Open **Settings → Account & security**.
2. Expand **Set up two-factor authentication**, enter your current password and select **Set up authenticator**.
3. Scan the private QR with your authenticator app, or manually enter the setup key. The QR is generated locally, not by a public QR service.
4. Enter the displayed six-digit code and select **Verify & enable MFA** within the ten-minute enrollment window.
5. Store the one-time recovery codes privately, preferably in a password manager, then acknowledge that you saved them.
6. Confirm the screen now says MFA is enabled.

Enrollment is normally a one-time action. The ten-minute timeout applies to unfinished enrollment, not to the lifetime of enabled MFA. The phone and server share a secret and independently calculate time-based codes; the phone does not send its key on every login. Keep device time automatic. Used codes cannot be replayed for another protected action; wait for the next code when required. Repeated invalid/reused proofs can temporarily lock protected actions.

**Change password / manage sessions**

1. Select **Change password**, enter the current and new password, and supply MFA/recovery proof when requested. New passwords must meet the form's length requirements (12–128 characters).
2. Submit only when the replacement password is safely recorded. Follow any reauthentication requirement.
3. Review **Active sessions** and use its explicit revocation controls for sessions you no longer recognize or need.
4. Treat **Disable MFA** as removing protection, not routine troubleshooting. It requires password/proof and can block protected broker actions.

Never share QR images, setup keys, recovery codes, cookies or broker tokens. Session revocation is not a guarantee that a broker position is closed.

### 13. Audit log

1. Open **Settings → Audit log**.
2. Select a category, enter search text and set available date filters.
3. Open an event for its details; close the dialog or press Escape to return.
4. Clear filters to restore the unfiltered loaded view.
5. Use **Export filtered events** to download the displayed filtered records. Treat exports as private account/operational information.

The UI is a view of recorded events, not proof that every external broker action is captured. An export reflects the loaded/filterable records, not necessarily an unlimited full-account archive.

### 14. Help, tour and development database view

- Use **Workspace help** for guidance, **Product tour** for forward/back screen guidance, and close the tour to resume work. A tour is not a completed setup or trading-readiness check.
- The development launcher also exposes an authenticated, allowlisted, read-only database inspection surface on `http://localhost:3002/`. It helps diagnose stored records; it is not another trading engine or required public service.
- Do not expose the inspector, PostgreSQL, API internals or calculator directly to the Internet. Do not use database edits to bypass execution safeguards.

## Data labels and calculation terms

| Term | Meaning in this app |
| --- | --- |
| Live | Provider-supported current data; still inspect timestamps and connection health |
| Snapshot | An observation captured at a stated time, not a continuously updating stream |
| NSE closing data | Stored exchange end-of-day values for the displayed session; not intraday executable prices |
| Spot | Underlying reference price, not the option premium |
| Premium | Entered/observed price per option unit; total premium depends on units |
| Lot size / lots / units | Exchange units per lot / chosen lot count / their product |
| IV | Volatility input or estimate, depending on screen; not guaranteed future volatility |
| Expiry payoff | Outcome at expiration calculated from strikes, sides, units and entered premiums |
| Target-date P&L | Model estimate before expiry using time, volatility and other assumptions |
| Delta / gamma / theta / vega | Model sensitivities, not account limits or guaranteed moves |
| Net debit / credit | Premium paid / received for the research basket, not broker margin |
| Reconciliation | Comparing tracked execution with broker books; discrepancies can block trading |
| Armed / enabled | Temporary explicit execution permission, separate from broker connection |
| Halted / unknown | A state requiring investigation, not an invitation to retry submissions |

Dates tied to exchange sessions use IST. Daily candles, option closing observations, broker portfolio snapshots and manually entered premiums are separate datasets. Importing one does not automatically populate the others.

## Troubleshooting

| Symptom | Safe checks and next step |
| --- | --- |
| App will not open | Confirm the local launcher is running and port 3000 is ready. Check terminal errors. Do not launch duplicate stacks or terminate unrelated processes blindly. |
| Stuck on Loading screen after a restart | Wait for frontend readiness, then reload once. A stale client chunk can need a reload; persistent failure needs browser/server error inspection. Unsaved drafts may be lost. |
| Search shows no scrips | Type at least two characters, select the right catalog and check provider/import availability. Cash history is not an option master. |
| Builder has contracts but no premiums | Check source/warning and broker quote permissions. A working account login does not guarantee market-data access. Use an explicitly labelled valid closing snapshot for research, never a guessed live price. |
| Zerodha quote-access warning | Check the configured Kite app's market-data entitlement and account authorization. The app cannot grant provider permissions. Repeated refreshes will not fix a permission denial. |
| Only old closing data appears | Inspect its date. The app does not automatically fetch a new closing archive through Refresh quotes; the operator must update stored data. |
| Expiry or stock absent | Only listed/imported contracts are available. Check exact symbol and nearest unexpired dates; do not invent a contract or use another broker's token. |
| Add leg rejected | Check duplicate contract, maximum 12 legs, verified lot size and common underlying/expiry. Start a new spread only if discarding the current one is intended. |
| Payoff absent | Add/enable a valid leg; check positive spot/strike, premium, units, dates and target range. Read the calculation error. Then check private calculator readiness. |
| Payoff is nonzero at unchanged spot | Default/editor IV is not fitted to the premium. Compare expiry payoff separately from target-date model value. |
| Backtest Run disabled | Load history, fix parameter validation, provide enough warm-up candles and read the readiness explanation. Server live mode can pause heavy research. |
| Calculation service unavailable/busy | Check port 8010 locally and `/api/ready`; inspect bounded worker errors. Do not add unlimited workers or retry large jobs repeatedly. |
| Portfolio missing/partial | Verify each broker session and the section-specific refresh status. Missing funds/holdings do not equal zero. |
| MFA code rejected | Check automatic phone time, correct NRIAlgo account and whether that code was already consumed. Wait for a fresh code or use an unused recovery code; respect lockout. |
| Broker connected but order controls unavailable | Verify execution support, active selection, server flags, MFA, risk limits, reconciliation and temporary authorization. Connection alone is insufficient. |
| Order unknown or reconcile halted | Stop new submissions. Inspect broker books and server diagnostics; resolve uncertainty without deleting audit rows or resetting state blindly. |
| Cancel/disable clicked but position remains | Cancellation concerns pending orders, not filled exposure. Check broker confirmation and manage any intended exit explicitly. |

When reporting a bug, include screen/route, exact steps, expected versus actual behavior, source/date labels, sanitized error/request ID and whether the data was live or a snapshot. Remove passwords, account identifiers, setup keys, OTPs, tokens and private portfolio details from screenshots/logs. Never attach `.env` or a database dump to a public issue.

## Operator data refresh

The app does not magically receive all instruments/history when installed. Import only data you are entitled to use. Stored daily candles serve charts/backtests; F&O closing archives serve option snapshots. Keep original archives and provenance outside Git.

To refresh **current/next-expiry option research only**, use the existing downloader with one exchange session, not a five-year range. The following is a reproducible example for the already reviewed 18 September 2026 archive; replace both dates and the archive path together for a later genuine session:

```sh
.runtime/python-venv/bin/python scripts/download_fno_historical.py \
  --from 2026-09-18 --to 2026-09-18 --symbols ALL --current-next \
  --archive .runtime/nse-fno/raw/2026-09-18.zip \
  --output .runtime/nse-current-options
node --import tsx scripts/import-fno-eod.mjs .runtime/nse-current-options/normalized
# Only after reviewing successful validation; this next command writes the database:
node --import tsx scripts/import-fno-eod.mjs .runtime/nse-current-options/normalized --commit
```

1. Ensure the archive is the official report for the requested session. Without `--archive`, the downloader attempts the official source instead of that local file.
2. `ALL` includes supported index and stock option rows. `--current-next` retains the two nearest nonexpired expiries per underlying relative to the report date; the builder separately excludes dates already expired today.
3. Let normalization finish before running the importer. Inspect rejected rows, report dates and manifest. Do not force malformed data through validation.
4. Run validation without `--commit`, review the summary, then explicitly import if correct.
5. Open the builder and refresh quotes. Check source, snapshot date and both an index and a stock. A fresh import remains closing data, not live quotes.
6. This command is an operator-run refresh, not an installed daily scheduler. Keep data current through an explicitly managed operational process.

For cash/index history, inspect `scripts/import-local-eod.mjs` usage and its expected layout before importing your dataset; option files are not interchangeable with cash candles. See [Compact historical-candle storage](#compact-historical-candle-storage) for verified Parquet export and retention. Never run destructive retirement commands as a routine data-refresh step.

### Non-trading smoke check after an update

Run this with live execution disabled. Use disposable research drafts; do not change the active broker, revoke sessions or submit orders merely to test navigation.

| Check | Expected result |
| --- | --- |
| Sign in and open each sidebar section | Correct breadcrumb/screen, no blank page or endless loading |
| Overview with an unavailable account section | Explicit unavailable/partial message, not a fabricated zero |
| Builder → NIFTY → current expiry → add one leg | Premium, lot size, spot/date and payoff present |
| Builder → clear test draft → RELIANCE → next expiry | Stock contracts load if covered; expiry and premiums update |
| Change lots, disable/re-enable a test leg, choose scenario table | Quantity/results respond; no broker order is created |
| Invalid target price or insufficient backtest warm-up | Actionable validation rather than a generic success |
| Library template → Backtest studio → load stored history | Exact instrument, dates, candle count and assumptions shown |
| Algo lab save/reopen a disposable definition | Saved inputs preserved; unsaved-change choice respected |
| Watchlist row → chart | Correct stored instrument and coverage; missing volume/history disclosed |
| Portfolio/Orders with unsupported or disconnected provider | Honest unavailable/stale status and useful navigation |
| Audit filters and event dialog | Matching visible events; clear/close/Escape work |
| Open and close security/broker forms without submission | No unintended connection, credential or permission changes |

Separately, an operator must perform the deployment/recovery checks below. A UI smoke pass cannot establish broker fill behavior, numerical correctness for every strategy, backup recoverability or production security.

## Responsibilities

| Layer             | Owns                                                                                                   | Must not do                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| React / Next.js   | Screens, forms, charts, selection and rendering validated results                                      | Authoritative strategy pricing or direct broker execution  |
| Node.js / Express | Authentication, brokers, live data, order execution, execution risk, persistence and job orchestration | Maintain a second backtest/payoff engine                   |
| Python / FastAPI  | Historical processing, indicators, strategy simulation, payoff, Greeks and analytical risk             | Receive broker credentials or place orders                 |
| PostgreSQL        | Account isolation, durable jobs, historical candles, orders and audit records                          | Grant the runtime account schema-administration privileges |

Express runs inside Node.js; it is not an additional server. Chart geometry, display-only overlays and input validation remain in React. Analytical risk belongs in Python; fresh quotes, arming, quantity/notional limits, idempotency and reconciliation are independently enforced by Node before execution.

Historical CSV import scripts still normalize some rows in Node. They are operator-only, not a second strategy engine. Moving that preprocessing to Python remains work to do.

The NSE F&O downloader probes every calendar date, including special weekend sessions. Its checkpoints include the requested symbols and file hashes; changing symbols re-normalizes retained raw archives. Unavailable archives are gaps pending calendar review, not certified holidays. Retain the raw files and manifest, validate normalized files with `scripts/import-fno-eod.mjs`, then explicitly import with `--commit`. Never run an import against the same directory while its downloader is writing the manifest.

## Local setup

Use Node.js 22.13+, Python 3.13+ and PostgreSQL 17. On macOS:

```sh
brew install postgresql@17
make install
npm run hooks:install
make run
```

`make run` migrates the local database, then launches the API, Python calculator, web UI and optional development database-inspector surface. The current launcher starts the inspector on port 3002. The workspace is on port 3000, API on 8000 and private calculator on 8010. Never use the development launcher on the production host.

Local PostgreSQL configuration/data and the Python environment live in ignored `.runtime/`. Do not commit that directory, `.env`, imported datasets or credentials. Use `.env.example` for documented configuration names; use distinct random production secrets and private file permissions.

## Commit preflight

```sh
npm run hooks:install       # Run once after cloning; enables .githooks/pre-commit.
npm run check               # Lint, both TypeScript checks and offline safety tests.
npm run preflight:commit    # Build only the staged snapshot, not unstaged changes.
node scripts/preflight-commit.mjs HEAD  # Recheck a particular committed revision.
```

The hook checks out the Git index into a disposable temporary directory. It installs dependencies from that snapshot's exact manifests/lockfiles, runs lint, compiles the backend, produces a Next.js production build and parses Python modules for syntax errors. Lockfile-keyed dependency caches live outside this repository. It never launches the trading app, migrates a database or contacts a broker. Build errors reject the commit. Staging fixes and retrying is required; do not bypass the hook with `--no-verify`.

GitHub Actions runs this preflight separately for each incoming commit in a push or pull request, with the failing revision in the job name. A new branch with no previous SHA checks its tip; pull requests check the full base-to-head range. Large pushes above the matrix limit must be split. Existing historical commits can be checked explicitly with the command above. Configure required CI checks/branch protection in GitHub to prevent bypass; local hooks are not distributed Git policy.

Run `npm test` for the offline safety regression suite, or `npm run test:coverage` for Node's coverage report. Tests use synthetic fixtures and injected broker clients; they require no credentials, app server or database and place no live orders. They cover pre-trade risk boundaries, the complete broker-order transition matrix, submission ownership/authorization gates, Kotak execution validation and Zerodha SDK account isolation/error redaction. CI runs the suite on pushes and pull requests and gates release publishing on success.

These unit tests do not certify live trading: database concurrency, crash recovery, reconciliation under real broker failures, browser flows and Python calculations still need integration coverage. Coverage output includes imported modules and is diagnostic, not a claim of full application coverage. Existing isolated PostgreSQL checks in `scripts/verify-broker-sessions.mjs` are separate from the default suite. Build validation and Python syntax checks alone do not prove behavior or calculation correctness.

## Code map

Modules document their responsibility at the relevant component, class or function. Related private helpers live with their owning screen. Framework entrypoints and security boundaries remain separate intentionally.

Consolidated frontend modules have explicit owners: `features/overview/account-model.ts` holds shared account contracts and display valuation; `lib/stored-market-data.ts` validates stored instruments and daily reads; `features/workspace/workspace-views.tsx` groups reusable page commands, error containment and help. Snapshot validation stays private to `use-workspace-session.ts`. Broker views share `broker-hooks.ts`; presentation never owns live-order authorization.

| Location                                                                 | Responsibility                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/main.ts`                                                        | Express composition, session/authentication and protected route registration                                                                                            |
| `backend/database.ts`, `types.ts`, `local-database.ts`                   | Schema migrations, database contracts and development PostgreSQL lifecycle                                                                                              |
| `backend/backup.ts`, `import-legacy-sqlite.ts`                           | Encrypted backup/restore and explicit legacy migration; not request handlers                                                                                            |
| `backend/security.ts`, `mfa.ts`                                          | Password/session protections, second factor and credential encryption                                                                                                   |
| `backend/broker-registry.ts`, `broker-app-credential-store.ts`, `zerodha-connection.ts` | Owner-scoped active selection, encrypted broker-app credentials and one-use Zerodha authorization with a private SDK adapter                                            |
| `backend/portfolio-service.ts`, `broker-portfolio-normalizer.ts`                       | Durable broker-neutral portfolio accounts, synchronized snapshots, canonical instrument identity and server-side consolidation                                      |
| `backend/kotak-*`, `market-data-provider.ts`, `instrument-master.ts`     | Kotak adapter, bounded provider contracts, streaming and exact instrument identity                                                                                      |
| `backend/live/`                                                          | Order intent binding, preview/confirmation, risk reservations, adapter dispatch, reconciliation and halt controls                                                       |
| `backend/stored-market-data.ts`, `historical-candle-store.ts`            | Stored instrument/candle validation plus bounded PostgreSQL/verified-Parquet reads                                                                                      |
| `backend/option-chain-history.ts`                                        | Exchange-session display selection and captured-chain fallback                                                                                                          |
| `backend/historical-market-data*`                                        | Broker historical-data transport validation; not backtest calculations                                                                                                  |
| `backend/research-contracts.ts`, `strategy-research-routes.ts`           | Saved strategy validation and delegation of research calculations                                                                                                       |
| `backend/calculation-client.ts`, `calculation-jobs.ts`                   | Validated private Python calls and durable owner-scoped job lifecycle                                                                                                   |
| `backend/database-browser-routes.ts`                                     | Authenticated, read-only, owner-filtered inspection of allowlisted records                                                                                              |
| `calculation_engine/app.py`, `contracts.py`                              | Private authenticated calculation API and strict numerical inputs                                                                                                       |
| `calculation_engine/backtest.py`, `payoff.py`                            | Canonical backtests, stored-session simulation, option payoff and portfolio Greeks                                                                                      |
| `calculation_engine/market_insights.py`                                  | Bounded read-only public NSE reference datasets                                                                                                                         |
| `frontend/src/app/`, `proxy.ts`                                          | Next.js entrypoints, broker callback, attribution and request boundary                                                                                                  |
| `frontend/src/features/workspace/`                                       | Navigation, session lifecycle, shared layout, dialogs and ordered workspace styles                                                                                      |
| `frontend/src/features/brokers/broker-hooks.ts`, `brokers-screen.tsx`    | Shared connection/selection hooks and grouped broker views; authentication never arms execution                                                                         |
| `frontend/src/features/live-trading/`, `orders/`                         | Explicit execution controls and read-only order records                                                                                                                 |
| `frontend/src/features/overview/`                                        | Mode-isolated account snapshots, streamed display marks and automatic read-only NSE intelligence                                                                        |
| `frontend/src/features/portfolio/`                                       | Read-only account/consolidated portfolio selection, coverage status, valuation summaries and expandable broker breakdowns                                              |
| `frontend/src/features/option-chain/`                                    | Live/stored chain selection, exact stored chart reads, chart rendering and standalone-chain Python-derived IV/Greeks; the builder does not request chain Greeks |
| `frontend/src/features/backtest-studio/`, `spread-builder/`, `research/` | Form inputs and presentation of Python calculation results                                                                                                              |
| Other `frontend/src/features/` folders                                   | Account, audit, database, learning and saved-strategy screens, each with its own screen entrypoint                                                                      |
| `frontend/src/components/`, `lib/`                                       | Shared controls, instrument pickers, request validation and presentation utilities                                                                                      |
| `scripts/download*`, `audit-nse*`, `import-*`                            | Explicit historical-data download, quality audit and additive import commands                                                                                           |
| `scripts/check-production-environment.mjs`                               | Fail-closed deployment settings validation; never prints secrets                                                                                                        |
| `scripts/preflight-commit.mjs`, `.githooks/`, `.github/workflows/`       | Staged/revision build gates and commit-by-commit CI                                                                                                                     |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `Makefile`              | Runtime images, single-host service wiring, HTTPS and operator commands                                                                                                 |

## Data and calculations

- Backtest studio reads stored daily cash/index candles and queues a Python job. It does not fabricate missing prices or silently use a broker-history fallback.
- Options builder sends premiums, strikes, quantities, dates and volatility assumptions to Python. Returned results include payoff curves, signed net debit/credit, breakevens, extrema and Greeks. Model output is not a broker margin quote or an execution guarantee.
- The current-expiry builder uses a normalized option-chain boundary. Kotak prefers its native active-chain/expiry endpoints and falls back to exact master contracts plus bounded quotes; Zerodha constructs its chain from the daily NFO master and one bounded quote snapshot. Missing depth, timestamps or premiums remain null/stale. When broker quotes are unavailable, eligible cached observations or imported NSE closing data are explicitly labelled as research snapshots, never executable quotes.
- Historical charts identify underlying candles separately from option premiums. KLineChart handles drawing/indicator presentation; attribution is available at `/legal/charting`.
- Importers validate by default where their CLI offers `--commit`. Review their usage before running; never point an unreviewed import at production. Preserve source/provenance and adjustment status. Missing candles are not invented.
- `scripts/requirements-bhavcopy.lock` contains optional historical-download dependencies; install separately when using those scripts. Runtime Python dependencies are in `calculation_engine/requirements.lock`.

### Compact historical-candle storage

Daily cash/index candles may be published as immutable ZSTD Parquet while PostgreSQL continues to own users, orders, broker state, strategies and instrument metadata. A valid `.runtime/historical-parquet/manifest.json` makes the API use Parquet automatically; if no manifest exists, it falls back to PostgreSQL. The option-history tables are separate and are not migrated.

```sh
npm run historical:archive  # read-only PostgreSQL export, verification, atomic publish
npm run historical:verify   # SHA-256 files plus aggregate/per-instrument comparison
npm run historical:verify-archive # verify Parquet after PostgreSQL retirement or transfer
```

The archive command never updates or deletes PostgreSQL. It writes to a private staging directory, compares all persisted candle fields, writes the manifest last and then renames the verified result atomically. It refuses to overwrite an existing archive. Run verification after every transfer and before deployment. Production Compose mounts `HISTORICAL_ARCHIVE_DIRECTORY` read-only into the API; that host path must contain the verified archive.

After copying the archive to separate storage and verifying that copy with `HISTORICAL_ARCHIVE_DIRECTORY=/absolute/backup/path npm run historical:verify-archive`, `npm run historical:retire-postgres` performs the explicit final cutover. It locks and truncates only `public.eod_candles` after comparing its row count, instrument count and date boundaries with the manifest. The table schema, instrument catalog, option history and transactional data remain in PostgreSQL. Once retired, use `historical:verify-archive`; the source-comparison command intentionally fails because the PostgreSQL candle table is empty.

The regular PostgreSQL backup no longer contains daily cash/index candle values after retirement. Preserve at least one independently verified copy of the complete Parquet directory, including `manifest.json`, outside the repository and PostgreSQL volume. Restore service by copying that complete directory back to `HISTORICAL_ARCHIVE_DIRECTORY` and passing archive-only verification before starting the API.

## Broker and order safety

### Broker-neutral portfolios

A successful broker authorization registers a durable portfolio account and immediately attempts an independent funds, holdings and positions synchronization. Connecting a broker never enables live trading. The server stores normalized daily snapshots and their individual items, then consolidates accounts; React only validates and presents that result. Existing authenticated sessions are bootstrapped on the first Portfolio request so accounts connected before this schema was introduced also appear.

Holdings are matched by ISIN first, then by exchange/instrument identity, with normalized symbols used only as a guarded fallback. Derivatives use exchange, underlying, expiry, strike, option type, product and side. Consolidated rows retain per-account breakdowns. Partial refreshes are explicit: the response reports how many accounts updated and never silently treats a failed broker section as an empty balance.

Portfolio value does not add pledged value or available margin to holdings. Pledged quantities classify holdings; collateral, cash, available margin and used margin remain separate. Broker adapters must return a stable account binding plus normalized funds, holdings and positions. Kotak and Zerodha implement this read-only boundary; new providers should implement the same reader without changing persistence, consolidation or the screen.

Daily end-of-day capture is attempted after 15:35 Asia/Kolkata on exchange weekdays for currently authenticated broker sessions. Performance history begins when an account is connected; the system cannot infer earlier cash flows or portfolio composition from current holdings. Statement import/backfill remains future work.

Kotak live execution is implemented behind explicit enablement. Zerodha authorization/connection is separate from execution capability; selecting an unsupported execution adapter fails closed.

The server resolves the active broker when an intent is bound. Changing the selection must not move existing orders or positions to another broker. Broker switches require enabled app MFA and a fresh authenticator or unused recovery code, and clear existing live permissions. Live execution requires configured server flags, app MFA, an authenticated broker session, registered static-IP prerequisites, risk limits, fresh reconciliation and explicit time-limited arming. Each arming requires a new code; a code consumed during broker selection cannot be reused. Initial broker registration can select the first broker but does not authorize trading.

Account & security renders the MFA setup QR locally in the browser, with manual setup-key entry as a fallback. No external QR service receives the secret. Enrollment material stays only in component memory and is cleared after confirmation, navigation away, or the ten-minute setup window. Scan the QR in an authenticator app and enter its six-digit code to enable MFA; save the one-use recovery codes privately.

Live permissions end at most five minutes after arming and at least 30 seconds before either the app or broker session expires. Dispatch rechecks this buffer and the durable app session. Cancellation and reconciliation remain available while the broker session is valid; the buffer does not guarantee exchange cancellation before expiry.

Preview is not submission. Unknown submission outcomes must be reconciled, never automatically resent. Halt latches permission off; cancellation acknowledgements do not prove exchange cancellation, and halt does not automatically flatten positions. Keep `LIVE_TRADING_ENABLED=false` until these paths have been manually verified with the broker.

Reconciliation advances positions and cash from the last clean snapshot using incremental fills, including overnight carry. Older terminal DAY orders need not remain in today's order book; older unresolved orders still block trading. Untracked carry, expiry settlement, corporate actions and external broker activity are not silently adopted. A disconnected kill revokes stored permissions and latches all of the owner's live accounts; unavailable cancellation remains explicitly unresolved. An individual order's business-limit rejection blocks that order, while stale state, loss limits and uncertain dispatch still halt the account. The runtime role can only read/append `live_events`; apply migrations using the deployment migration identity to revoke older grants.

## Single-host deployment

The supported topology is one Linux host, one API and **one calculator container**. A 4 GiB host is a starting configuration, not a live-trading performance guarantee. Steady-state container memory caps total 2,816 MiB; migrations add at most 384 MiB temporarily. Leave the remaining memory for Linux and Docker. Builds and recovery drills belong on development/CI machines, never on the trading host.

### Worker safety and resource limits

- PostgreSQL serializes job claims globally. Each claim has a unique token, a renewable 150-second lease and at most three recovery attempts. Starting an API never resets another worker's unexpired claim. Every completion is fenced by its token; cancellation is persisted and checked on the five-second heartbeat.
- Stored candles are read in 500-row pages from a consistent snapshot, with a hard 10,000-row final payload limit. This is bounded batching, not an unlimited streaming backtest engine.
- `calculation_engine/worker.py` is the only supported HTTP entrypoint. It admits one request at a time and runs numerical routes in a disposable process. Disconnect, crash, timeout and shutdown release that process; Linux parent-death protection prevents orphan computation. An eight-MiB measured request limit also covers chunked bodies. Child limits are 60 CPU seconds, 640 MiB address space and 90 seconds wall time. The container has 768 MiB, 0.75 CPU and 64 PIDs; numerical libraries use one thread.
- Heavy backtests and stored-session research are paused whenever `LIVE_TRADING_ENABLED=true`, even before an account is armed. Payoff/Greeks remain available, but compete for the same bounded calculator. Research never bypasses Node's live execution checks.
- `/api/health` checks database liveness; `/api/ready` additionally checks calculator health and worker progress. Calculator health remains responsive while busy. Do not scale the calculator or enable several live API instances without a separate capacity/execution review.

### CI release and first deployment

The concise operator runbook and copy-safe configuration templates are in
[`deployment/README.md`](deployment/README.md),
[`deployment/digitalocean.env.example`](deployment/digitalocean.env.example)
and [`deployment/secrets.example.json`](deployment/secrets.example.json).

Every incoming commit runs the isolated build preflight. Successful pushes to `main` additionally build four Linux-amd64 runtime images, run the disposable recovery drill, and only then publish images to GHCR. The `release-<commit>` artifact contains `release.env`, including digests for app, PostgreSQL and Caddy images. Images are not automatically deployed.

Provision one amd64 Ubuntu Droplet in DigitalOcean Bangalore (`blr1`) with at least 4 vCPU and 8 GiB RAM, Docker Compose, Node 22+, iptables, a Reserved IPv4, a real domain and a private DigitalOcean Space. The Cloud Firewall should expose only 80/443 publicly and restrict SSH to operator addresses. Configure the Reserved IPv4 as the outbound source before registering it with a broker, and verify that routing after every network change.

Keep `.env` nonsecret and mode 0600. Put the verified CI release artifact at `.env.release`. Prepare one private JSON secrets document offline, then export it into a **new** versioned owner-only directory. Files are explicitly readable by their mounted container UID while the enclosing directory remains owner-only. No secrets are copied into images or published in Docker environment metadata. Optional registration/Zerodha fields may be empty, but their files must exist. The Spaces key must be restricted to the private backup Space. A workspace owner can alternatively save Zerodha app credentials from Broker connections; these are AES-GCM encrypted in `broker_app_credentials` and never returned to the browser.

```sh
# Copy an offline-prepared document to a temporary protected path, export it once,
# then securely remove or archive the source outside the Droplet.
SECRETS_DIR=/etc/nraialgo/secrets-v1 \
  node scripts/host-operations.mjs export-secrets --from-file /root/nraialgo-secrets.json
# Set SECRETS_DIR, APP_DOMAIN, Spaces settings, alert webhook and flags in .env.
# Copy release.env from the verified CI artifact to .env.release.
chmod 600 .env
make preflight
make deploy
make status
```

`make deploy` pulls immutable images, creates service networks, blocks all containers from DigitalOcean metadata, then starts the stack without building. Run from a stable Linux path such as `/opt/nraialgo`; `/usr/bin/node` and sudo are required for the firewall command. Never skip this step to work around a host configuration failure. Only Caddy publishes ports. Frontend, gateway, database and analytics use separate internal networks; only the API, public-reference calculator and backup have scoped egress networks. Migrations alone receive database-admin credentials. The installed host unit reapplies metadata protection on boot.

### Backups, alerts and recovery

Backups run daily under a read-only database role, retain at most 14 local encrypted archives, upload application-encrypted data to a private DigitalOcean Space and verify remote object length before updating the success marker. Failures retry after 15 minutes; a marker older than 26 hours is unhealthy. Space versioning/lifecycle policy and encryption-key custody are operator responsibilities. Local retention is recoverable only from a retained off-host copy after local archives are pruned.

Use a dedicated Spaces key with access only to the backup Space. It must not administer Droplets, networking, accounts or broker operations. Configure one private HTTPS alert receiver and verify delivery before relying on it.

```sh
# .env includes ALERT_WEBHOOK_URL and optional DEPLOYMENT_NAME.
node --env-file=.env scripts/host-operations.mjs configure-alerts
# Run once as root after Docker networks exist; installs a one-minute systemd timer.
sudo /usr/bin/node --env-file=.env scripts/host-operations.mjs install-monitor
```

The monitor checks public HTTPS readiness, service health, backup age and host memory/disk usage, and posts only threshold breaches to the configured HTTPS webhook. Alerts never restart services or trade automatically. Verify notification delivery with a staging outage; configuration alone is not evidence of delivery. Docker logs are size/rotation bounded locally; off-host application log shipping and broker-feed-specific alerts still need deployment-specific setup.

Run `make recovery-images` then `make recovery-check` on a development/CI machine. The drill derives an isolated configuration from production Compose, uses fresh secrets and synthetic rows, disables live trading and public ports, and checks process cancellation/crash/timeouts, resource caps, concurrent claims, stale-result fencing, lease recovery, cross-worker cancellation, encrypted backup restoration, tamper rejection and database/service restart. It deletes only its randomly named disposable containers/volumes and writes `.runtime/staging-recovery.json`. It does **not** prove a Spaces download recovery, alert delivery, DigitalOcean firewall policy, live broker reconciliation or real-world trading latency.

Before live deployment, restore an actual Spaces object into a separate staging database, verify the retained key decrypts it, and test alert delivery, Droplet reboot/firewall persistence, Reserved-IP egress, image vulnerability scans and broker reconnect/reconciliation. Keep live execution disabled through those drills. An API restart never preserves an armed trading session. Roll back by selecting a prior digest manifest only when its code is compatible with the forward-only schema; never roll a production database backward automatically. Preserve broker/backup encryption keys separately and rotate them only with a migration/recovery plan.

Implementation references: [Compose secret mounts](https://docs.docker.com/compose/how-tos/use-secrets/), [container resource settings](https://docs.docker.com/reference/compose-file/services/), [GitHub image publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [DigitalOcean Reserved IP outbound routing](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/outbound-traffic/).

## Maintenance

### Watchlists

Open **Markets → Watchlists** (`/#/watchlists`). Each account starts with NIFTY and BANKNIFTY, can keep up to 10 lists with 100 scrips each, and can search the imported catalog to add exact instruments. Clicking a row opens that instrument's existing KLine daily chart alongside the list. Lists are stored in PostgreSQL; chart data uses the historical repository without a broker. These are historical charts, not live watchlist quotes. Missing history is not synthesized. `node --import tsx scripts/verify-watchlists.mjs` exercises CRUD, defaults, isolation, duplicate prevention and limits in a disposable local database.

### Sensitive data

New passwords use versioned scrypt (N=131072, r=8, p=1). Legacy hashes remain readable and upgrade after successful password/MFA login. One concurrent hash and a bounded queue cap native memory; the API heap is limited to 256 MiB to leave room for scrypt inside its 512-MiB container. Per-source and global admission limits remain necessary against overload. Five invalid/reused MFA proofs lock protected actions for 15 minutes; counters are persisted under the account lock even when an action rolls back. Migration 20 adds these counters and must run before starting this version. API 5xx logs include a request ID and stack locations, not request bodies, credentials or provider exception messages.

`BACKUP_DATABASE_TIMEOUT_SECONDS` bounds database dump/restore commands (default 1800 seconds, allowed 60–21600). Increase it explicitly for larger databases and test restore duration; no backup command runs indefinitely.

Never commit credentials, private keys, database exports or logs. The commit preflight scans the exact candidate snapshot before running builds; `node scripts/check-secrets.mjs` checks tracked/unignored working files and `node scripts/check-secrets.mjs --history` audits reachable history. Findings show identifiers/categories only. This heuristic is not proof that arbitrary secrets or personal data are absent; review findings and use GitHub secret scanning where available. Removing a leaked secret from HEAD does not revoke it or erase history: rotate/revoke it first, then coordinate any history rewrite with collaborators.

Passwords use salted scrypt, session/recovery tokens use one-way hashes, and broker sessions/MFA secrets use account-bound AES-256-GCM encryption. Broker MPIN, password and TOTP inputs are not persisted. Do not add browser localStorage or logging for credentials. Local PostgreSQL bootstrap credentials are now AES-256-GCM encrypted in `.runtime/postgres-access.json`; reading a legacy plaintext file migrates it atomically without changing database passwords. Its separate `.runtime/postgres.key` is mode 0600 inside a mode-0700 directory. Keep that key out of exports; losing it loses access to the encrypted configuration. Replacing a plaintext file does not securely erase old filesystem snapshots or backups.

Encryption needs a protected bootstrap key: encrypting that key beside another key is not extra protection. Local key files and mounted production secrets remain readable to the owning process/OS administrator. Enable FileVault locally; keep production credentials in owner-only mounted files and never in `.env`. Trade records, account usernames and operational metadata remain database records rather than individually encrypted fields; protect their disks, access and encrypted backups. Do not describe the complete database or a compromised host as protected by field encryption alone.

### Broker session recovery

Broker authorization tokens are encrypted in PostgreSQL with `BROKER_ENCRYPTION_KEY`, bound to the user, provider and original app login. Keep this key stable across restarts and outside the database; changing it requires fresh broker authorization. Passwords, MPIN and TOTP codes are never persisted. Existing memory-only connections require one fresh authorization after this upgrade.

After an API restart, broker/data reads attempt bounded, read-only verification before publishing a restored connection. Expiry is never extended (Kotak retains the app's eight-hour cap; Kite retains the next-06:00-IST cap). Logout/session deletion cascades to saved tokens; disconnect and security changes remove them explicitly. Live trading permission is not restored. Kite disconnect attempts remote API-token revocation; if that cannot be confirmed, the UI reports it. Kotak disconnect removes local access only.

Kotak feed interruptions retry at most five times with backoff while the original login remains valid and the viewer polls. Authentication rejection, explicit stop and session expiry are not retried. No order or login submission is automatically retried. Local storage assumes the existing single-API-process deployment; horizontal replicas require distributed connection/revocation coordination.

Run `node --import tsx scripts/verify-broker-sessions.mjs` against local PostgreSQL to check migration replay, encrypted restart recovery, isolation, logout cleanup, verification races and bounded fake-socket retries. It creates and removes only a disposable verification database and never contacts a real broker.

Keep this as the only project Markdown file. Next.js agent-file generation is disabled in `frontend/next.config.ts`. Read the installed framework's relevant documentation under `frontend/node_modules/next/dist/docs/` before changing Next behavior.

Do not remove validation, ownership checks, explicit confirmation or execution-risk code to reduce line count. Shared utilities and broker/analytics boundaries are intentionally separate. Prefer meaningful commits such as “Add stored option history” or “Simplify live order screen”, without mandatory type prefixes. Never include secrets, databases, generated build output or imported price files in a commit.
