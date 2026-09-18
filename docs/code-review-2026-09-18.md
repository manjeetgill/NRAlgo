# Foundation code review — 18 September 2026

## Decision

The repository is substantially safer to extend after this pass: every workspace
destination has a dedicated screen, session/read lifecycles have clear owners,
critical live-control findings are fixed, and the quality gate now includes the
frontend and structural checks. Continue screen development using these boundaries.

**Do not interpret this as approval for unattended or public real-money trading.**
The execution implementation is deliberately narrow and the operational acceptance
gates below remain open. A code review cannot prove the absence of all loopholes.

This pass preserves existing account data, credentials, ledger history, API payload
names and database columns. It does not enable execution, arm a broker, submit/cancel
a real order, reset PostgreSQL, or install a new broker. Unrelated concurrent
package-manager changes are outside this review's code changes.

## Scope and method

Reviewed the application composition/authentication/CSRF boundaries, database and
worker ownership, broker transports and normalization, provider interfaces, paper
ledger/research paths, live adapter/manager/risk/OMS, frontend navigation and request
lifecycle, production packaging, CI, tests and documentation. Followed both source
imports and actual request paths rather than judging files by their names.

Verification combines TypeScript compilation, lint, isolated PostgreSQL/offline
broker tests, pure frontend models/render tests, architecture assertions, production
builds, package audits and read-only browser navigation. This is not a line-by-line
formal proof, independent penetration test, benchmark or exchange certification.

## Findings fixed in this pass

Severity reflects the failure mode before the change. Tests are reproducible evidence,
not a guarantee about an external broker or deployed environment.

| ID | Severity | Finding and consequence | Remediation / evidence |
| --- | --- | --- | --- |
| F01 | High | `GET /api/live/status` called the manager's entry initializer. Opening an ostensibly read-only view could reset permissions/state and start a monitor capable of cancellation. | Status now reads an existing entry or owner/broker-scoped durable records without opening controls. Explicit commands own initialization. `live-status-readonly.test.mjs` asserts SELECT-only queries, no locks/writes, no broker I/O and no started entry at close. |
| F02 | High | Ordinary workspace/API quota exhaustion could prevent an emergency halt request from reaching its handler. | Separate bounded halt admission at source and authenticated-account levels, retaining auth/CSRF. `halt-admission.test.mjs` exhausts workspace reads, verifies unauthenticated-CSRF rejection, then verifies the valid halt reaches the disabled manager instead of normal throttling. This does not guarantee broker-side cancellation. |
| F03 | High, deployment | The frontend constituent parser imported `csv-parse`, but only the root package declared it. A standalone web install could miss a dependency hidden by the monorepo's local node_modules. | Declared and locked the existing exact `7.0.2` package in frontend dependencies. Architecture checks verify frontend package imports and lock consistency. Clean container installation remains a CI/deployment gate. |
| F04 | Medium | The Next route mixed authentication, navigation, forms, synthetic replay tables, audit presentation and multiple screens in about 1,090 lines. Changes to one concern risked unrelated screens. | Six-line composition route; feature-owned screens, workspace shell, dispatcher, session hook, contracts and error boundary. Old component paths are moved, not duplicated. Structural checks enforce a thin route and required screen files. |
| F05 | Medium | Root workspace polling and unguarded completions could overlap reads and reapply obsolete authentication/account data. | Abort/generation gate; runtime response validation; identity checks after each await; private UI remount on session change; sequential polling only for active paper jobs. Pure gate and malformed-response regressions cover the new primitives. |
| F06 | Medium | Research used an always-running clock and recalculated the payoff grid during unrelated editor renders. Replay advanced one state while updating another inside its updater. | Clock runs only in the quote view and skips hidden documents; payoff is memoized from financial inputs/freshness; playback advances via a cleaned-up timeout with pure updates. |
| F07 | Medium | CI's previous test step omitted frontend tests/type-checking/lint; the frontend test glob also omitted constituent `.test.mjs` cases. | One `npm run check` command covers lint, backend compile/tests, frontend TS/MJS tests/type-check and architecture tests. CI invokes it, then retains build/browser/audit/container/restore gates. |
| F08 | Medium | Live ticket mount reads could complete after departure; React busy state alone left a rapid-submit window. | Stable abortable status refresh, invalidation on unmount, and a synchronous mutation ref lock. Server durable idempotency and uncertain-outcome handling remain authoritative. No automatic mutation retry was added. |
| F09 | Medium | README/security documentation falsely stated that no live routes, activation flag or Kotak execution adapter existed. | Corrected current capabilities, disabled-by-default configuration, read-only/control distinction and limitations. Documentation no longer encourages assumptions contradicted by executable code. |
| F10 | Low | A cash-symbol picker cleanup captured an old generation number, which could collide with a newer in-flight search. | Cleanup increments the current generation instead of assigning a captured value. No changes to broker identity or selected contracts. |
| F11 | Low | Screens had broker/paper implementation names in generic entry points, and responsibilities were hard to discover. | Broker-neutral screen and picker names; protocol adapter names retained where accurate. Added purpose/lifecycle comments and a complete owned-source responsibility map with an inventory regression check. |

## Resulting frontend structure

Each navigable destination has a feature-owned screen file. Overview stays the initial
screen; non-overview screens are loaded through static dynamic-import paths. A screen
render failure preserves navigation and does not replay an action. Form state remains
inside the screen that owns it, rather than in a global trading modal.

| Responsibility | Owner |
| --- | --- |
| Next route | `frontend/src/app/page.tsx` |
| Auth/session reads and explicit login/logout | `features/workspace/use-workspace-session.ts` |
| Shared layout/navigation | `features/workspace/workspace-shell.tsx` |
| Lazy destination selection | `features/workspace/workspace-content.tsx` |
| Account snapshot/stream lifecycle | `features/overview/use-overview-account.ts` |
| Position/headline P&L calculation | `features/overview/overview-model.ts` |
| Broker connection lifecycle | `features/brokers/use-broker-connection.ts` |
| Read-only live history lifecycle | `features/orders/use-live-orders.ts` |
| Explicit live commands | `features/live-trading/live-order-ticket.tsx` and guarded backend routes |

`useCallback` is used where function identity controls effects or a shared contract.
`useMemo` is used for material derived work such as payoff points and flattened replay
fills. `useRef` tracks mutable request identities/in-flight guards. `useEffect` owns
external lifecycles with cleanup. Adding every React hook everywhere would add
complexity without making the application faster; memoization is never authorization.

The historical research, paper and market-data forms are still sizable. Separation
is a foundation, not a claim that every component is now optimally small. Continue
extracting feature-specific models/hooks/subcomponents when changing those workflows,
with behavior tests, rather than mechanically fragmenting JSX into trivial files.

## Security and trading boundaries retained

- Auth uses bounded password work, hashed sessions, owner-scoped queries and CSRF.
  Production settings enforce HTTPS/cookie/setup/MFA prerequisites. Logout and
  security changes revoke broker access; reconnect/restart never silently re-arm.
- Transport inputs are validated; approved broker hosts and instrument-master paths
  are constrained. Browser API transport is same-origin, rejects redirects and
  applies a deadline. Broker secrets remain server/session-bound, not localStorage.
- Read-only market-data provider, broker account, paper ledger/replay, and execution
  adapter remain separate. Selecting a source or toggling presentation cannot grant
  order permission. Adding another provider requires contract mapping/tests, not
  simply substituting an arbitrary URL.
- Live intent persistence precedes placement. Ambiguous acknowledgements/timeouts
  remain unresolved and are reconciled, not blindly retried. Concurrent capital
  reservations, duplicate confirmations, account isolation and order ownership have
  existing offline regression coverage.
- Display prices and P&L remain distinct from fill authorization. Overview matches
  exchange plus token, rejects stale/future/out-of-order ticks and updates rows and
  totals together. Missing values do not become zero or fall back to virtual funds.
- `PAPER_TRADING_ENABLED=false` removes paper presentation only. Research remains
  research. All other screens remain available. This flag is not a server permission
  boundary and does not delete historical records or stop already queued jobs.

## Open findings and release gates

These are deliberately not hidden behind a generic “production ready” label.

### R01 — High: real broker and deployment acceptance

Offline fixtures cannot establish actual entitlements, production feed framing,
market-hours freshness, account/product behavior, static-IP configuration or order
acceptance. Complete read-only integration acceptance first. Any later real-money
test needs a separately reviewed procedure and explicit human authorization; do not
turn on server flags as part of UI development. CI container/browser success and an
actual server backup/restore drill are also required before deployment approval.

### R02 — High: exit policy after a loss-limit halt

`evaluateLiveRisk` checks the daily loss limit before its reduce-only branch, and a
halted account cannot use the normal submission path. Therefore the app is not a
guaranteed emergency position exit mechanism. Halt cancels rests; it does not flatten.
Changing this needs an explicit risk-policy decision, quantity/race tests and broker
acceptance—not silently weakening the existing gate. Until then, broker-native
manual intervention is part of the operational runbook.

### R03 — High: day rollover and concurrent external trading

The live flow starts from a dedicated flat account/empty day book and does not
automatically adopt manual or carry-forward exposure. Book rollover, unmatched
orders and reconciliation drift require operator review. Do not trade the same
account from another client. Define and test day-end reconciliation, restart and
recovery procedures before multi-day/unattended operation.

### R04 — Medium: single-process ownership

Broker sessions, stream ownership and admission limits are partly in memory. Run
one API process. Multiple replicas require a coordinated session registry, rate
limits and execution leadership, not just a load balancer. The worker already uses
database leasing, but that does not make the API horizontally safe.

### R05 — Medium: unbounded durable live history

Live status/reconciliation currently loads all account order history. Long-lived
accounts need bounded/paginated presentation and a separately designed reconciliation
working set/archive policy. Adding an arbitrary LIMIT inside reconciliation would
hide unresolved intents and is unsafe. Preserve every unresolved order during any
future retention migration.

### R06 — Medium: remaining legacy browser boundaries

The new workspace boundary validates JSON, and Overview has explicit adapters, but
several legacy panels and the live-history loader still trust selected server shapes
through TypeScript types. Expand runtime response validation and mounted lifecycle
tests screen by screen. Generation fencing is present widely, but not every legacy
read is physically aborted; the screen/session remount remains important. Consolidate
legacy account-report valuation onto the tested Overview model before extending it.

### R07 — Medium: future adapter cancellation conformance

The Kotak adapter independently verifies app ownership before cancellation. Generic
OMS fallback cancellation depends on the adapter's scoped snapshot/cancel contract.
Before adding a second broker, run adversarial adapter tests with unrelated manual
orders, duplicated correlations, partial fills and uncertain acknowledgements.
Never assume a broker's complete order book is an app-owned cancel list.

### R08 — Medium: financial scope and operational observability

Kotak RMS buying power is not settled cash; cash-ledger drift reconciliation and
derivative SPAN margin are unavailable. Multi-leg models are tested but not exposed
as live basket execution. Historical fills omit real liquidity/tax/execution effects.
Add actionable alerts for stale feeds, permission expiry, unknown orders, drift,
database/worker health and backup age without logging credentials. Test alert delivery.

### R09 — Low/Medium: audit semantics and UX tests

Presentation-mode filtering currently recognises legacy paper labels in audit text.
Move new events to structured domain/action metadata before adding complex audit
search; retain original durable records. Existing frontend tests cover pure models,
adapters and markup, not every mounted React hook interaction or accessibility flow.
Add keyboard/focus, responsive, session-expiry and delayed-network browser cases as
each next screen is built. No measured performance/latency target is claimed here.

### R10 — Operational security remains a deployment task

Keep API/database/debug ports private, configure the trusted edge correctly, keep
encryption keys separately recoverable, restrict registration, monitor process memory,
and test off-server restores. No OS/container-image penetration test, Git-history
secret audit, public abuse/load test or support/key-rotation service was completed
in this review. A clean npm audit covers known dependency advisories only.

## Cleanup decisions

Removed old component locations after moving their implementations into dedicated
screen folders and updating imports. No blanket removal of README files or tests.
The repository map explains why each owned file remains.

Removed the unused legacy automatic account-report refresh option. Live price
updates keep reading the shared feed cache, not repeatedly fetching broker records;
the initial and explicit refresh paths remain.

Retained tests, fixtures, migrations, backup/import tools, lockfiles, the non-executing
shadow model and bounded spread-policy tests. These prevent regressions or support
recovery. `.dockerignore` keeps tests/docs/development material out of runtime images.
Local databases, credentials, `.runtime/` and backups were not deleted. Historical
paths remain recoverable from Git; no user data was removed.

Documentation now has distinct purposes: README for operation, development guide for
patterns/contracts, security review for boundaries, file map for ownership and this
dated review for evidence and outstanding work. This is intentional documentation,
not duplicate unmaintained README files in every folder.

## Verification record

- `npm run check`: lint, backend compilation and **124 backend tests**, frontend
  type-check and **70 frontend tests** passed. **Six architecture checks** passed,
  including the owned-source documentation inventory. Offline brokers and isolated
  schemas only.
- `npm run build`: backend plus optimized standalone Next build passed.
- Production dependency audits: **zero known vulnerabilities** reported for root
  and frontend at review time. Both workspaces now pin the public npm registry so
  installs and audits do not silently inherit a machine-wide corporate registry.
  Re-run audits in CI after lockfile updates.
- Browser checks: Overview, Strategies, Strategy lab, Orders & trades,
  Brokers, Live trading, Account & security, Activity log and Learning guide inspected
  in the existing local session without broker login or order submission. Live-only
  navigation and disconnected/disabled states were preserved. Paper behavior is covered by
  automated markup/model tests; this pass does not claim a real broker tick demo.
- The standalone Playwright/Chromium smoke suite passed against an isolated database
  and mocked Kotak transport: cash/options paper fills, research, chart lifecycle,
  cached live marks and MFA. It made no real broker calls.
- Production API/web/migration/backup images built successfully. A disposable
  Compose database/migration/API/web stack reached healthy status and its API health
  and readiness endpoints passed before the validation stack was removed.
- Not run locally in this pass: encrypted/off-server restoration, public TLS/firewall
  validation, production load/penetration tests and real-money acceptance.

The existing development backend was not restarted during the review. Restart it
before relying on the new status/admission behavior; normal restart invalidates
in-memory broker connections, and live permission must never be restored implicitly.

## Next development sequence

1. Finish/verify the current foundation commit and CI gates before another screen.
2. Build one screen per feature/commit using the documented screen/hook/model/API
   pattern; include empty, unavailable, stale, permission and account-change states.
3. Expand runtime browser schemas and consolidate legacy report calculations while
   touching those screens. Measure performance before adding more caching.
4. Treat live-operational acceptance, exit/day-end policy and a second broker as
   separate safety milestones. Keep all activation flags disabled until those gates
   are explicitly completed.

For the exact file owners and future conventions, use the
[repository map](repository-map.md) and [development guide](development-guide.md).
