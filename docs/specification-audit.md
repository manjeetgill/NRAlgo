# Complete screen specification audit — 18 September 2026

## Verdict

**Not accepted for production against the complete specification.** The previous 13-screen implementation is a real-data-oriented foundation, not completion of the contracts in this new document. A passing repository test suite is not a claim that all PDF cases pass.

Reviewed source: `NRIAlgo_Complete_Screen_Specifications.pdf`, 215 pages, SHA-256 `7f4c317fdc4c7445afc2a2d4fec86c78c5337c9d5d7ce9ed687c8c6ead7dc91c`. All shared and screen requirement sections were read; the page-4 shared contract was rendered to verify text extraction. The 93 reference captures have **not** all received visual regression sign-off.

The [machine-readable register](specification-acceptance.json) preserves all **262 numbered requirements: 65 data contracts, 93 interaction flows and 104 named tests**. Each flow additionally has separate success and failure evidence slots (186 branches). Unverified does not mean a test was executed and failed; it means acceptance evidence is missing or implementation is incomplete.

## Scope decisions retained from the user

- Kotak only for now, behind separate market-data/account/execution boundaries. Do not invent ICICI support from reference fixtures.
- Paper is a server-controlled setting and is hidden in live mode; none of these changes enables it.
- No generated market-data fallback, fabricated P&L/margin, canned report, sample recovery codes or fictional fills.
- Initial/explicit account snapshot plus shared quote-cache updates; no repeated order/trade/position-report polling added.
- No actual trades, live arming, account password/MFA changes or session revocation against the user's account during this audit.

The synthetic input flow (04-F03), destructive/global reset reference (SH-F07) and ICICI paper-account fixture (07-T07) are recorded as explicit user-scope overrides, **not passing implementations**. Hidden paper capabilities still require their own acceptance if enabled later.

## Screen-by-screen implementation assessment

| Screen | PDF requirement pages | Primary code inspected | Gap preventing full acceptance |
| --- | --- | --- | --- |
| 00 / shared | 1–12 | backend/main.ts; backend/security.ts; workspace-shell.tsx; lib/api.ts | Missing roles/memberships, shared transactional outbox, revision/idempotency on every command, full route/filter history, observability and load/recovery evidence. |
| 01 Overview | 13–19 | use-overview-account.ts; overview-model.ts; kotak-account-adapter.ts | Open-position P&L only, not daily realized-net + MTM with an agreed overnight baseline. No active-worker count or complete risk-readiness projection. |
| 02 Strategies | 24–31 | strategies-screen.tsx; strategy-research-routes.ts | No immutable StrategyVersion IDs/config hashes or version-pinned deployments. Missing running/paused/draft states, start/pause workers and optimistic-edit conflicts. |
| 03 Strategy library | 43–50 | strategy-templates.ts; daily-backtest.ts | Rules run, but there is no canonical shared rule AST/version promotion path. Hilega and AI clarification flows are absent, explicitly blocked. |
| 04 Backtest studio | 52–61 | daily-backtest.ts; backtest-report.ts; use-daily-backtest.ts | Daily CSV engine is local and synchronous; hashes are not a durable dataset/job registry. Missing server jobs, cancellation, intraday session controls, verified provenance/adjustments. |
| 05 Algo lab | 70–77 | research-workbench.tsx; research-draft.ts | Scheduled cash-basket editor does not match full MA/source/direction rule editor. Save creates a new row; no revision conflict/immutable version, full unsaved-navigation guard or AI proposal schema. |
| 06 Spread builder | 82–90 | spread-payoff.ts; research-workbench.tsx; backend/live/ | Expiry payoff is analytic, not broker margin. Master identity/lot/tick revision is not durably preserved in the draft. No frozen executable basket preview through this screen; repair policy must be agreed. |
| 07 Paper trading | 98–106 | paper-trading-screen.tsx; paper-trading-ledger.ts | LIMIT/DAY only; no partial/liquidity model or server-frozen preview. Client review expiry alone is insufficient. Paper remains disabled/hidden in live configuration. |
| 08 Option chain | 118–125 | live-option-chain.tsx; use-market-feed.ts; kotak-market-data-client.ts | No complete sequence-gap resnapshot contract or durable revisioned draft. Current duplicate rule rejects both sides of a contract; PDF rejects same-side duplicates. Lot-master revisions need revalidation. |
| 09 Orders & trades | 130–138 | live-orders-api.ts; order-records-table.ts; backend/live/execution.ts | App-managed aggregate order observations, not complete broker tradebook/fill ledger. Missing fills tab, account/date filters, complete cursor exports, UI order timeline and cancellation command revision. |
| 10 Broker connections | 153–160 | broker-connection-adapter.ts; use-broker-connection.ts; kotak-live-adapter.ts | Kotak-specific supported login is real; generic OAuth callback tests need provider-specific equivalents. Capability check is not a full provider verification. Persistent account identity/reconnect mismatch and exposure-aware disconnect remain open. |
| 11 Live positions | 166–174 | live-trading-screen.tsx; use-overview-account.ts; backend/live/ | Mounted exposure retention fixed, but no durable all-account position cache. External broker positions cannot enter frozen exit plans. Flatten-all remains disabled; user-approved exit/repair policy and account-level coordination required. |
| 12 Account & security | 181–189 | account-screen.tsx; account-sessions.tsx; backend/mfa.ts | Real owner auth/TOTP/session controls exist. Missing pending-enrollment cancellation, recovery-code regeneration, general recent-auth proofs, device activity and complete armed-account recovery acceptance. |
| 13 Audit log | 198–205 | audit-model.ts; activity-screen.tsx; backend/database.ts | Text-only rows, derived categories, latest50 loaded export. No structured actor/account/mode/entity/correlation envelope, complete indexed filters, outbox, append-only DB policy or full export. Current retention deletes beyond2000 rows. |

Paths without a prefix in this table refer to their feature directory under `frontend/src/features/` or the named backend module; exact owned-file links are in [repository-map.md](repository-map.md).

## Defects corrected in this audit

1. **Known exposure disappeared after disconnect/partial refresh.** A same-account failed position read now retains the prior positions, valuation and original snapshot timestamp with explicit warnings. A successful empty snapshot can clear them. Account/mode/session changes still clear private state. This is mounted-screen retention, not a durable broker snapshot service.
2. **An unavailable mark could retain broker P&L as though current.** Normalization now keeps P&L unavailable until a valid mark is present; the PDF's10 × (2940−2910) =300 oracle is covered.
3. **Backtest fill priority disagreed with the spec.** Existing-position opening gap checks now precede a pending rule exit. Intrabar stop-first ambiguity is explicit in the trade reason. Per-fill fees and signal dates are retained.
4. **Invalid upload removed valid data.** CSV replacement validates completely before committing. Cancellation/error leaves the previous valid filename/candles intact. Duplicate headers and UTF-8 size limits are checked.
5. **Reports lacked reproducibility fingerprints.** Export now binds copied settings, canonical dataset/configuration SHA-256, engine/template versions, row count, timestamp and provenance limitations. Async file/hash generations cannot resurrect a superseded report. These are local manifests, not server run IDs.
6. **Recent events relied on ID/arrival ordering and allowed duplicate rows.** Overview and Audit now use one immutable-ID deduplication/server-timestamp ordering model with stable ID tie-break. Invalid timestamps remain unknown.
7. **Expired sessions on child screens left private UI mounted.** Explicit server `SESSION_EXPIRED` notifications clear the private shell and read public sign-in policy. An invalid MFA proof using401 does not trigger sign-out.
8. **Errors had no correlation contract.** All API JSON failures now carry public code, message, retry classification and a server-generated correlation ID, retaining legacy `detail`. Submitted IDs/raw validation values are not echoed. Retry classification never automatically resends a mutation.
9. **Mobile menu lacked focus containment.** At the mobile breakpoint the background is inert, Tab wraps, Escape closes, and focus returns to the trigger. Desktop resize removes modal behavior.
10. **Library errors could look like an empty library.** Strategies now distinguishes failed retrieval from a confirmed empty collection and exposes a retry that refetches the actual library.

## Financial/data decisions that must not be invented

- Define daily P&L scope and overnight mark-to-market baseline, fee/tax availability, timezone rollover and whether realized totals include manual broker trades. Current label remains **open-position P&L**.
- Approve supported instruments/products, emergency exit order types, arm duration and basket partial-failure/repair policy. Disabled Flatten all is not acceptance of11-F05.
- Approve historical-data entitlements, corporate-action/adjustment policy and session calendar for each timeframe. Uploaded daily CSV cannot substantiate intraday/options execution.
- Decide workspace role/membership model and account-management permissions. Owner-only isolation is not viewer/editor/trader/admin authorization.
- Approve retention/archive/privacy policy. Current2000-record text retention is not the specified append-only audit design.

## Shared journeys and operational gates

All seven journeys remain **open as complete end-to-end journeys**:

- J01: immutable template → dataset-backed report → durable deployment → order/fill → audit correlation.
- J02: validated manual/AI draft → tested immutable version.
- J03: chain → canonical spread draft → frozen paper basket → orders.
- J04: recent authentication → broker capability/reconciliation → policy-bound authorization.
- J05: halt and scoped flatten with residual exposure retained.
- J06: outage/unknown submission recovery and reconciliation without duplicate orders.
- J07: authorized audit links across strategies, runs, connections and orders.

Repository tests exercise parts of these, especially OMS ambiguous-send recovery. They do not close a whole journey. Also outstanding: per-screen401/403/409/422/429/503 states; all93 capture comparisons; keyboard/390/768/1440/200%zoom coverage; 100-user/10-active capacity benchmark with hardware and p95 evidence; long-job isolation; migrations/backup restoration and monitoring/alert drills; connected Kotak acceptance. No new deployment or data-provider entitlement was authorized by the document itself.

## Evidence from this audit

- Final `npm run check`: **passed — 119 backend, 63 frontend and 6 architecture/register tests (188 total), zero failures/skips**, plus lint and type checking. Runtime code revision: `0add9b6`. The run used the existing workspace; pre-existing lockfile and two test-file edits were preserved and are not part of the new commits.
- Screen/shared commits: Audit `7a6cec9`; Overview/position valuation `a8a2072`; Backtest studio `780ecca`; Strategies `d92cabb`; session/API security `85388b8`; mobile shell `0add9b6`.
- New deterministic acceptance oracles: `tests/frontend/specification-calculations.test.ts`.
- Position exposure/missing-mark regressions: `tests/frontend/overview-model.test.ts`, `overview-adapter.test.ts`.
- Event ordering/IST tests: `tests/frontend/audit-model.test.ts`.
- Session/error envelope tests: `tests/frontend/api-contract.test.ts`, `tests/backend/api.test.mjs`.
- Existing backend suites cover isolated PostgreSQL transactions, auth/CSRF, broker session fencing, paper arithmetic and OMS retry/restart behavior. Existing tests containing synthetic fixtures are isolated test inputs, not application fallback data.
- `npm run build` passed for the backend and optimized Next application. The local API was restarted with live execution disabled and `/api/health` returned `status: ok`, `live_enabled: false`.
- Browser: Backtest studio rendered at390×844 with no page overflow; mobile menu focused Close, Shift+Tab wrapped to Sign out, Escape returned to Open navigation, and background had the inert attribute. No sign-out was activated. These observations do not certify every screen state.
- A batch of desktop screen navigation checks exceeded the browser tool timeout; it is **not** counted as successful screen acceptance.
- Browser tooling subsequently lost its tab attachment; a new background tab remained at its deferred initial load. Those attempts are not counted as completed acceptance. The existing writing extension also injected document attributes causing a development hydration warning; clean-profile visual QA remains required.
- Kotak is disconnected and local live execution is disabled. No claim of connected ticks, margin/fill reconciliation or broker certification.

## How to use the acceptance gate

`npm run audit:spec` summarizes known coverage. `npm run check:acceptance` intentionally exits nonzero while any requirement/flow branch remains open or product/operations release acceptance is absent. Keep ordinary `npm run check` green while incrementally implementing requirements; never convert disabled/unavailable features into green acceptance cases.

The register's `verified-automated` status means the named deterministic case has a linked passing regression. `partial` means only a subset is covered. All186 flow branches are tracked separately; a unit-model pass does not automatically sign off success/error UI and persistence evidence.

## Named test case register

This table is a review snapshot. The JSON register is the maintained status source; consult its evidence paths and requirement-page references when adding acceptance tests.

| Case | PDF page | Case title | Evidence status | Finding |
| --- | --- | --- | --- | --- |
| SH-T01 | 7 | Tenant/account isolation | partial | Owner isolation has tests; workspace membership/account-role matrix and export/download surfaces are incomplete. |
| SH-T02 | 7 | Role enforcement | open | Not accepted against the complete case. See the section assessment. |
| SH-T03 | 7 | UI state coverage | partial | Malformed response and state fencing covered; every screen's eight states and all HTTP failure branches not exercised. |
| SH-T04 | 8 | Accessibility and layout | partial | Browser checked 390px backtest/menu focus; 768px,200% zoom and all screen/dialog combinations not completed. |
| SH-T05 | 8 | Reconnect and ordering | partial | Session revocation/cache fencing tested; full sequence-gap resnapshot semantics not implemented. |
| SH-T06 | 8 | Retry and concurrency | partial | OMS retry/ambiguous-send concurrency tested; saves/previews/export jobs do not all meet shared idempotency contract. |
| SH-T07 | 8 | Persistence and recovery | partial | OMS restart recovery tested; durable runners/outbox/data jobs absent. |
| SH-T08 | 8 | Observability | partial | Public error codes, no-store, correlation IDs and no raw validation input tested. End-to-end event correlation, alerts and metrics incomplete. |
| SH-T09 | 8 | Capacity target | open | Not accepted against the complete case. See the section assessment. |
| SH-T10 | 8 | Degraded capacity | open | Not accepted against the complete case. See the section assessment. |
| 01-T01 | 18 | Mixed scope | partial | Mode isolation covered; multi-account race browser acceptance remains. |
| 01-T02 | 18 | P&L arithmetic | partial | Unknown/partial open books remain unavailable. Daily fees/baseline arithmetic is not implemented. |
| 01-T03 | 18 | Readiness truth | partial | Execution backend rejects missing authorization; Overview does not expose complete risk readiness reasons/lease. |
| 01-T04 | 18 | Partial outage | partial | Partial/outage snapshot retention tested; simultaneous broker outage and activity browser scenario not run. |
| 01-T05 | 18 | Event order | verified-automated | Server-time ordering and duplicate-ID projection verified in the model used by Overview. |
| 01-T06 | 18 | Navigation | open | Not accepted against the complete case. See the section assessment. |
| 02-T01 | 29 | Filter combination | open | Not accepted against the complete case. See the section assessment. |
| 02-T02 | 29 | Version pinning | open | Not accepted against the complete case. See the section assessment. |
| 02-T03 | 30 | Duplicate start | open | Not accepted against the complete case. See the section assessment. |
| 02-T04 | 30 | Pause with exposure | open | Not accepted against the complete case. See the section assessment. |
| 02-T05 | 30 | Runner crash | open | Not accepted against the complete case. See the section assessment. |
| 02-T06 | 30 | Definition restore | partial | Basket definitions persist in navigation; MA period schema and immutable version restore not implemented. |
| 03-T01 | 49 | EMA contract | open | Not accepted against the complete case. See the section assessment. |
| 03-T02 | 49 | RSI contract | open | Not accepted against the complete case. See the section assessment. |
| 03-T03 | 49 | Breakout window | verified-automated | Completed-close breakout excludes current high; next-open entry verified. |
| 03-T04 | 49 | Blocked rules | partial | Unresolved Hilega cannot run; clarify/save-rule workflow absent. |
| 03-T05 | 49 | Agent injection | open | Not accepted against the complete case. See the section assessment. |
| 03-T06 | 49 | Stale result | partial | Template-keyed remount clears local reports; exact version-handoff acceptance not run. |
| 04-T01 | 59 | No future information | verified-automated | Future-suffix mutation preserves earlier trades/equity for all three daily rules. |
| 04-T02 | 59 | Accounting oracle | verified-automated | Exact PDF oracle: quantity 10, 100→110, two 20 fees, net 60. |
| 04-T03 | 59 | Ambiguous stop/target | verified-automated | Both touched: stop-first exit at 98 and explicit reason. |
| 04-T04 | 59 | Gap behavior | verified-automated | Gap 95 takes priority over queued rule exit and cannot fill at stop 98. |
| 04-T05 | 59 | CSV boundary | verified-automated | 59/60/10000/10001 boundaries, duplicate/bad dates and invalid OHLC; duplicate CSV headers also rejected. |
| 04-T06 | 60 | Warmup and no trades | verified-automated | Warmup rejection, no-trade flat series and finite equity verified. |
| 04-T07 | 60 | Parameter/report binding | partial | Hashes/settings freeze before async work and input edits clear report; browser delayed-read/edit race not yet exercised. |
| 04-T08 | 60 | Timeframe boundary | open | Not accepted against the complete case. See the section assessment. |
| 04-T09 | 60 | Cancel and retry | open | Not accepted against the complete case. See the section assessment. |
| 04-T10 | 60 | Complete export | verified-automated | JSON round-trip retains all trades beyond 50-row table window. |
| 05-T01 | 76 | Input validation | open | Not accepted against the complete case. See the section assessment. |
| 05-T02 | 76 | Save idempotency | open | Not accepted against the complete case. See the section assessment. |
| 05-T03 | 76 | Concurrent editing | open | Not accepted against the complete case. See the section assessment. |
| 05-T04 | 76 | Real result binding | open | Not accepted against the complete case. See the section assessment. |
| 05-T05 | 76 | Instrument compatibility | open | Not accepted against the complete case. See the section assessment. |
| 05-T06 | 76 | Unsaved draft | open | Not accepted against the complete case. See the section assessment. |
| 05-T07 | 77 | AI parity | open | Not accepted against the complete case. See the section assessment. |
| 06-T01 | 88 | Known bull call | verified-automated | Exact PDF bull-call payoff oracle verified. |
| 06-T02 | 88 | Unbounded tail | verified-automated | Unbounded short-call loss and long-call profit verified. |
| 06-T03 | 89 | Lot metadata | partial | Explicit signed units used by payoff; historical lot-master revision integration unverified. |
| 06-T04 | 89 | Margin vs credit | partial | Unsupported shorts fail closed; server basket margin preview is not connected. |
| 06-T05 | 89 | Partial basket | partial | Core spread coordinator has orphan/partial tests; executable Spread builder preview-to-repair flow unavailable. |
| 06-T06 | 89 | Stale draft | open | Not accepted against the complete case. See the section assessment. |
| 06-T07 | 89 | Empty builder | partial | Empty options draft supported and backend rejects empty legs; complete browser save/run/review rejection paths unverified. |
| 07-T01 | 104 | Environment isolation | partial | Paper/live routes isolated; tampered future account-ID contract not implemented. |
| 07-T02 | 104 | Cash transaction | partial | Reservation arithmetic covered; named simultaneous HTTP cash-overcommit scenario still needs acceptance evidence. |
| 07-T03 | 104 | Limit matching | partial | Quote-driven marketability covered; PDF exact 105→99 scenario not separately recorded. |
| 07-T04 | 105 | Sell inventory | partial | Unfunded inventory sales reject; UI/server acceptance trace needs attachment. |
| 07-T05 | 105 | Partial cancel | open | Not accepted against the complete case. See the section assessment. |
| 07-T06 | 105 | Preview expiry | partial | Client TTL exists but no frozen server preview. A client-only timeout does not satisfy the requirement. |
| 07-T07 | 105 | Account separation | user-override | User limited implementation to Kotak; ICICI must not be fabricated. Paper remains hidden in live mode. |
| 08-T01 | 124 | Call/put identity | partial | CE/PE metadata normalized; full drawer→persisted canonical-draft acceptance not run. |
| 08-T02 | 124 | Expiry switch race | partial | Subscription stability/generation cleanup exists; exact A/B delayed snapshot case not recorded. |
| 08-T03 | 124 | Missing field | partial | Missing provider fields normalize to null; connected UI case still required. |
| 08-T04 | 124 | Sequence recovery | open | Not accepted against the complete case. See the section assessment. |
| 08-T05 | 124 | Freshness | partial | Stale/future price rejection covered; executable preview/feed outage journey not certified. |
| 08-T06 | 124 | No execution side effect | partial | Read-only feed boundary covered; browser spy across all quote/draft actions not run. |
| 08-T07 | 124 | Metadata change | open | Not accepted against the complete case. See the section assessment. |
| 08-T08 | 124 | Draft limits and duplicates | partial | Four-leg cap exists. Duplicate policy currently rejects the contract regardless of side, stricter than same-side-only requirement. |
| 08-T09 | 125 | Greeks provenance | partial | Missing Greeks shown unavailable; provenance/model timestamp scenario not end-to-end tested. |
| 09-T01 | 136 | Partial arithmetic | partial | Core cumulative quantities covered; distinct fill ledger/central UI cancellation acceptance incomplete. |
| 09-T02 | 136 | Fill/cancel race | partial | Unconfirmed cancellations remain unresolved; specified late full-fill race through UI unverified. |
| 09-T03 | 136 | Duplicate fill | partial | Monotonic broker observations tested; separate unique provider-fill ledger absent. |
| 09-T04 | 137 | Ambiguous placement | partial | Lost/malformed acknowledgement stays UNKNOWN without blind retry; support/UI recovery journey not fully exercised. |
| 09-T05 | 137 | State regression | partial | Regression halts rather than rewriting order truth; complete UI timeline acceptance incomplete. |
| 09-T06 | 137 | Export security | partial | Formula/quote/newline encoding tested; complete authorized paginated server export not implemented. |
| 09-T07 | 137 | Account access | partial | Account-bound OMS guards tested; export job URL ownership not applicable until jobs exist. |
| 10-T01 | 158 | Callback replay | open | Not accepted against the complete case. See the section assessment. |
| 10-T02 | 158 | Cross-user callback | open | Not accepted against the complete case. See the section assessment. |
| 10-T03 | 159 | Secret leakage | partial | Sensitive broker diagnostics redacted in adapter tests; all browser/error/audit surfaces require combined acceptance. |
| 10-T04 | 159 | Expiry handling | partial | Session gate halts dispatch; outage exposure retained only in mounted UI, not durable across restart. |
| 10-T05 | 159 | Disconnect race | partial | Session fencing tested; disconnect command/exposure dialog race needs complete acceptance. |
| 10-T06 | 159 | Capability mismatch | partial | Unsupported execution fails closed; broker UI capability verification is not account-specific. |
| 10-T07 | 159 | Reconnect identity | open | Not accepted against the complete case. See the section assessment. |
| 11-T01 | 173 | All open positions | open | Not accepted against the complete case. See the section assessment. |
| 11-T02 | 173 | Known valuation | verified-automated | 10 units, average2910/mark2940→300; missing mark remains unavailable. |
| 11-T03 | 173 | Halt race | partial | Final entry gate rechecks halt/session; exact paused-dispatch generation scenario requires acceptance trace. |
| 11-T04 | 173 | Protective exits | partial | Risk-reducing core semantics exist; user-facing external-position emergency exits not implemented. |
| 11-T05 | 173 | Re-arm expiry | partial | Permission expiry tested; browser stale Armed banner journey not executed. |
| 11-T06 | 173 | Double flatten | open | Not accepted against the complete case. See the section assessment. |
| 11-T07 | 173 | Partial failure | open | Not accepted against the complete case. See the section assessment. |
| 11-T08 | 173 | Broker outage | partial | Mounted same-account exposure retained on disconnect/partial failure. Persisted last-known snapshot after navigation/restart remains open. |
| 12-T01 | 187 | Enrollment proof | open | Not accepted against the complete case. See the section assessment. |
| 12-T02 | 187 | OTP replay | partial | TOTP replay prevention tested; general action-scoped single-use reauth challenge not implemented. |
| 12-T03 | 187 | Recovery single-use | partial | Hashed recovery use covered; exact concurrent recovery-code scenario requires evidence. |
| 12-T04 | 188 | MFA disable gate | partial | MFA change disconnects broker access; armed exposure/protective-exit combined case incomplete. |
| 12-T05 | 188 | Session enforcement | partial | Session revocation and feed lease enforcement tested separately; socket/cached-token acceptance journey not run. |
| 12-T06 | 188 | Cross-user sessions | partial | Cross-owner session revoke and opaque session listing tested; full UI read/revoke scenario not executed. |
| 12-T07 | 188 | Sensitive response | partial | no-store headers enforced; all browser history/cache/analytics recovery surfaces not examined. |
| 13-T01 | 204 | Atomic recording | open | Not accepted against the complete case. See the section assessment. |
| 13-T02 | 204 | Event deduplication | partial | UI duplicate projection covered; transactional outbox consumer event-ID uniqueness not implemented. |
| 13-T03 | 204 | Timezone boundary | partial | IST day-boundary rendering tested; server date filters absent. |
| 13-T04 | 204 | Redaction | partial | Broker error redaction tested; structured audit whitelist absent. |
| 13-T05 | 204 | Export completeness | open | Not accepted against the complete case. See the section assessment. |
| 13-T06 | 204 | Link permissions | open | Not accepted against the complete case. See the section assessment. |
| 13-T07 | 204 | No mutation | partial | No edit/delete UI or routes; append-only database privileges absent and retention deletes history. |

## Implementation order to close the remaining gaps

Product clarification requested: owner-only versus shared roles; retain entry-cost open-position P&L versus implement prior-close daily P&L; app-managed exits versus adopting externally opened Kotak exposure. Until decided, do not silently expand account access or order authority.

1. Shared identity/role/account scope, canonical contracts, error/event envelopes and transactional outbox.
2. Immutable strategy/version/draft revisions and durable data/run registry; move long research work to fenced workers.
3. Deployment lifecycle with pinned versions, pause semantics and recovered leases.
4. Canonical instrument/quote freshness and snapshot-sequence reconciliation; preserve metadata across chain/builder/review.
5. Frozen server previews, complete order/fill ledgers and authorized cursor/export queries.
6. Policy-approved exit/flatten coordinator with partial-failure recovery and persistent broker position snapshots.
7. Structured audit, complete security recovery flows, then execute every registered success/error branch and operational gate.

Do not enable unattended real-money execution on the strength of screen parity or model tests alone.
