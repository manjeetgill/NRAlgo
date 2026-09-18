# Trading workspace prototype parity review

Update: a subsequent browser comparison is documented in [UI-only parity review](ui-only-parity-review-2026-09-18.md). It supersedes this report's browser-access limitations, clarifies that the app does have a differently targeted Workspace guide button, and records that the earlier Orders chunk-loading error did not recur.

Date: 2026-09-18. Reference: `/Users/manjeet/Downloads/NRIAlgo_Trading_Workspace.html` (97,375 bytes). Compared against the current working tree, including existing uncommitted changes.

## Verdict and verification limits

The implementation is **not an exact match**. The 13 reference destinations have corresponding screen components, but several central journeys, controls, and data semantics differ.

This is a source-based screen/action comparison, **not a completed every-control browser acceptance test**. The browser tool rejected the reference `file://` URL under its URL policy. The running implementation at `http://localhost:3000/` displayed an expired-session sign-in screen. No authenticated screens or transactions were exercised. Layout, responsive fidelity, focus behavior, timing, downloads, and end-to-end success remain unverified. No app code or account state was changed for this review.

The reference explicitly identifies itself as an offline presentation prototype with no broker APIs or real execution. A simulated action in that file is evidence of a desired interaction, not evidence that its production equivalent already works or should copy fictional values.

## Screen-by-screen comparison

| Screen | Reference controls and flow | Current implementation | Assessment |
| --- | --- | --- | --- |
| Overview | Paper/live P&L today; running-strategy count; two-broker connection count; recent-event details; security link; three quick actions | Same general activity/quick-action structure, but mode-dependent account metrics, funds/margin, position controls, one selected broker. Paper P&L is explicitly all-time, not today. No equivalent running-strategy count | Partial; metric meanings and composition differ |
| Strategies | Search; All/Running/Stopped/Draft/Saved filters; versions; per-strategy P&L; Pause/Start paper confirmation; open saved spread or lab; New strategy | Search, All/Cash/Spreads filters, persisted saved definitions, Open and New strategy. Every row is Saved; no strategy Start/Pause controls, running lifecycle, displayed version or row P&L | Major lifecycle gap |
| Strategy library | Three versioned executable templates; Configure & backtest; unavailable Hilega Milega reference; explanatory agent handoff | Same three-template concept, configure routing and unresolved Hilega reference. AI extraction/automatic deployment explicitly absent | Close in purpose; runtime unverified. AI automation is absent in both |
| Backtest studio | Eight parameters; run calculation on synthetic fixture or uploaded daily CSV; expandable assumptions; metrics, equity, trade ledger, JSON export; Browse templates | Parameters, calculated report and JSON export present. Current screen instead requires broker cash instrument, dates and loaded daily candles. No CSV upload or synthetic-fixture button. Assumptions are a static article | Material input/workflow change, not exact parity |
| Algo lab | Name, underlying, fast/slow MA, initial capital, from/to dates; Save draft; sample backtest; trade-log dialog | Shared ResearchWorkbench: cash basket, explicit legs, entry/exit times, capital, margin, basket stop/target, costs; save, historical replay and live quote tabs. EMA-style rules live in Backtest studio instead | Different editor and conceptual flow |
| Spread builder | Inline editable lots and delete per selected leg; immediate fixture payoff; risk metrics; Save strategy; chain navigation; sample entry/exit selectors; sticky debit/credit and Review paper order | Selected-leg summary uses units, with editing/removal in definition form. Payoff/risk requires saved contracts and fresh quotes. Real historical research replaces sample backtest. No basket-to-paper review/confirmation handoff | Major journey gap; layout/control placement also differs |
| Paper trading | Kotak/ICICI account tabs; virtual cash/P&L/open orders; New order dialog; Buy/Sell, Market/Limit, lots; 60-second preview, estimated fees, acknowledgement, confirmation; details and cancel | Kotak only; real-contract lookup; unit-based limit orders; sell held units; 30-second acknowledged review. Confirmation accepts order locally; quote refresh/matching determines fills. Modification and positions added | Partial; broker, order-type and review semantics differ |
| Option chain | Underlying/expiry selectors (one fixture option each); call/put detail drawer; five-level fixture depth, Delta/Theta/IV; Buy/Sell draft legs; Open builder | Real chain and contract detail, broker depth, Buy/Sell handoff to preserved draft. Greeks/IV explicitly unavailable. Contract history/chart capability added | Core handoff represented; Greeks missing relative to presentation |
| Orders & trades | All/Paper/Live examples tabs; search; CSV; time/mode/broker; details/history; open or partial remainder cancellation; direct new-order dialog | Domain chosen by server paper flag, no combined mode tabs. Search, status filter, CSV, details and paper cancellation exist. New order navigates to Paper trading. Details explicitly do not provide a complete exchange event timeline | Partial; domain switching, history and entry flow differ |
| Broker connections | Kotak and ICICI cards; connect simulation; verify; confirmed disconnect | Kotak adapter only, actual credentials, status refresh, connect/disconnect dialogs, portfolio toggle | ICICI missing; authentication intentionally real |
| Live positions | Arm checkbox flow; Halt; row Review exit; Review flatten all; confirm simulated exit creates order/audit record | Broker exposure and guarded execution controls. Row exit is read-only review, followed by manual guarded ticket selection. Flatten all explicitly disabled. Risk configuration, reconciliation and MFA-backed arming replace sample checkbox | Major exit/flatten workflow gap; execution safeguards are intentional |
| Account & security | Read-only username; password informational dialog; MFA enable/disable sample confirmation; Recovery codes dialog; revoke sample device | Actual password form, MFA enrollment/removal, enrollment recovery-code display/hide, active-session revocation and refresh | Same areas, substantially different real authentication workflow; no equivalent always-available sample-code dialog |
| Audit log | Category tabs; search; event details; export all matching session events | Categories/search/details/export present, but limited to latest 50 loaded server events, categories derived from message text, mode visibility filter and explicit refresh | Closest functional mapping; history scope differs |

## Highest-priority gaps

### 1. The central chain → spread → paper → order/audit journey stops at research

The reference's `reviewSpread()` builds a multi-leg preview and `confirmOrder()` records simulated orders. In the repo, `SpreadBuilderScreen` only renders ResearchWorkbench. Its selected-leg/payoff area has quote/research controls but no paper basket submission callback. The PaperTradingScreen review contains a single instrument intent.

Evidence: `frontend/src/features/spread-builder/spread-builder-screen.tsx:6`, `frontend/src/features/research/research-workbench.tsx:468`, `frontend/src/features/paper-trading/paper-trading-screen.tsx:219`, and `frontend/src/features/workspace/workspace-content.tsx:199`.

### 2. Strategy management is saved research, not start/pause/versioned operation

The reference can toggle running/stopped paper strategies and displays version/P&L. The repo deliberately labels definitions Saved and states “Saved, not deployed.” Opening an editor is supported; an automatic strategy execution lifecycle is not.

Evidence: `frontend/src/features/strategies/strategies-screen.tsx:54`, `:119`, `:182`.

### 3. Multi-broker reference flows collapse to Kotak

ICICI connection, paper-account switching and ICICI example positions/orders have no matching implementation. Only Kotak is registered.

Evidence: `frontend/src/features/brokers/broker-connection-adapter.ts:15`, `frontend/src/features/paper-trading/paper-trading-screen.tsx:281`.

### 4. Exit review does not complete the reference's position-exit flow

Flatten all is explicitly unavailable. A position row opens a read-only review and then exposes the guarded ticket; it does not automatically construct and confirm that row's exit. This should be described as an unfinished product journey, not hidden behind the presence of an exit button.

Evidence: `frontend/src/features/live-trading/live-trading-screen.tsx:129` and `:161`.

### 5. Backtest input controls have changed in the current working tree

The reference accepts a CSV or uses 400 synthetic candles. The current UI requires broker historical data, at least 60 valid candles and up to 180 calendar days per request. Neither reference input button is present. This may be intentional, but it prevents identical offline use. README still describes user-provided daily CSV, so that documentation is stale relative to this screen.

Evidence: `frontend/src/features/backtest-studio/backtest-studio-screen.tsx:97`, `:154`, `:185`; `README.md` “What works.”

## Other control-level differences

- The header's Product tour, Back/Next/Finish tour, workspace guide dialog, fullscreen toggle and sample reset are absent from the current shell. Resetting production data is not a suitable substitute for an offline demo reset.
- The reference displays all 13 menu destinations together. The repo's mode policy hides Live positions in paper mode and Paper trading in live mode. Market data is an extra repo destination.
- Five reference fragment routes do not match generated repo routes: `#/paper` → `#/paper-trading`, `#/orders` → `#/orders-trades`, `#/brokers` → `#/broker-connections`, `#/security` → `#/account-security`, `#/audit` → `#/audit-log`. The current route resolver matches generated hashes and falls back to Overview; these reference aliases are not implemented.
- The reference spread selector uses lots with a fixed fictional 50-unit lot size. The implementation uses exchange units and actual contract lot metadata. Retaining actual metadata is appropriate, but the user interaction differs.
- The reference duplicate-leg check includes side; the implementation rejects a duplicate contract regardless of side. Both cap the chain-to-draft path at four legs.
- “Add from option chain” in ResearchWorkbench changes its local tab to the builder rather than navigating to the dedicated Option chain screen.
- Paper preview duration differs (60 seconds versus 30), and the repo review does not reproduce the reference's per-leg fees/net debit-credit summary and ticking expiry display.
- The reference confirms immediate fixture fills, including sells; the repo uses quote-driven limit matching and held-unit sale restrictions. These are meaningful execution differences, not merely copy changes.
- Order list columns differ: the shared repo table lacks the reference's time column and its details do not show the reference's event history.
- The reference's spread sample entry/exit selectors do not drive its sample report. Recreating those selectors alone would not implement actual days-to-expiry research.
- Greeks shown in the reference are invented fixture values. Missing real Greeks is a data/analytics gap; copying those numbers would not close it.

Evidence for shell/routing: `frontend/src/features/workspace/workspace-navigation.ts`, `frontend/src/features/workspace/workspace-shell.tsx:66`, `frontend/src/lib/trading-mode.ts:10`. Evidence for remaining controls: the corresponding screen files listed above, `frontend/src/components/live-option-chain.tsx:545`, `frontend/src/features/orders/order-records-table.tsx`, and `frontend/src/features/activity/activity-screen.tsx:78`.

## What should remain different from a demo

Real authentication, durable owner-scoped records, actual contract metadata, freshness checks, broker-backed history, explicit live risk/arming and unknown values displayed as unavailable are implementation capabilities that the offline reference does not provide. They should be retained when bringing the UI closer to the reference. Likewise, sample Reset, simulated MFA and fictional fill success must not become real destructive/security/trading operations just to achieve visual parity.

## Remaining acceptance work

1. Obtain browser access to a permitted HTTP(S) rendering of the prototype; current file URL is blocked by the browser tool's URL policy.
2. Sign in to the running implementation through its UI. No credentials should be put in the report or chat.
3. Exercise all navigation, filters, selectors, dialogs, validation failures, dismiss/back paths and exports on both renderings, recording observed outcomes.
4. Use a disposable paper/test account for state-changing acceptance. Real order submission, arming, credential changes and security weakening are not ordinary parity-test clicks.
5. Check desktop/mobile screenshots, scrolling, keyboard focus, Escape, browser Back/Forward, preview expiry and asynchronous loading/error behavior.

Until those steps are done, there is no basis to claim pixel parity, successful authenticated end-to-end behavior, or that every control was clicked. The source evidence is already sufficient to reject an “exact implementation” claim.
