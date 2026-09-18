# Repository responsibility map

Updated 18 September 2026. Paths are relative to the repository root. This covers owned code, configuration and tests; generated dependencies/builds are described separately. Each file has one primary responsibility. Broker-specific names are intentional only at protocol adapters and diagnostic boundaries.

## Dependency direction

New screen infrastructure:
- [backend/historical-market-data.ts](../backend/historical-market-data.ts): bounded provider-neutral historical requests and candle validation.
- [backend/historical-market-data-routes.ts](../backend/historical-market-data-routes.ts): owner-authenticated, CSRF-protected, quota-limited history for research and charts; exact master identities only.
- [frontend/src/lib/market-history.ts](../frontend/src/lib/market-history.ts): same-origin history transport, IST dates, exact contract requests and response-scope validation.
- [frontend/src/features/option-chain/use-contract-history.ts](../frontend/src/features/option-chain/use-contract-history.ts): abortable selection-keyed history reads without tick-driven refetches.
- [frontend/src/features/option-chain/contract-price-chart.tsx](../frontend/src/features/option-chain/contract-price-chart.tsx): lazy-loaded Lightweight Charts candlesticks plus a shared-feed LTP line; no generated candles.
- [frontend/src/app/legal/charting/page.tsx](../frontend/src/app/legal/charting/page.tsx): public TradingView attribution and license link.
- [backend/api-error-contract.ts](../backend/api-error-contract.ts): public JSON error codes, retry classification and server-generated correlation IDs without exposing raw exceptions.
- [frontend/src/features/backtest-studio/backtest-report.ts](../frontend/src/features/backtest-studio/backtest-report.ts): local immutable-input report manifest with SHA-256 dataset/configuration fingerprints; does not claim durable server storage or verified provenance.
- [frontend/src/features/backtest-studio/use-daily-backtest.ts](../frontend/src/features/backtest-studio/use-daily-backtest.ts): abortable broker history reads, immediate selection invalidation and generation-fenced report calculation.
- [frontend/src/features/account/account-sessions.tsx](../frontend/src/features/account/account-sessions.tsx): real owner-scoped session listing and confirmed revocation without device metadata fabrication.
- [frontend/src/features/orders/order-records-table.tsx](../frontend/src/features/orders/order-records-table.tsx): selected-domain filtering, details, safe export and explicit virtual cancellation.
- [frontend/src/features/option-chain/option-chain-screen.tsx](../frontend/src/features/option-chain/option-chain-screen.tsx): standalone chain and research-draft navigation.
- [frontend/src/features/option-chain/use-market-feed.ts](../frontend/src/features/option-chain/use-market-feed.ts): abortable sequential shared-price cache reads, without broker report polling.
- [frontend/src/features/backtest-studio/backtest-studio-screen.tsx](../frontend/src/features/backtest-studio/backtest-studio-screen.tsx): broker instrument/date selection, historical daily data, calculated results and provenance export.
- [frontend/src/features/backtest-studio/daily-backtest.ts](../frontend/src/features/backtest-studio/daily-backtest.ts): bounded OHLC validation and deterministic EMA/RSI/channel research calculations; no data generator.
- [frontend/src/lib/download.ts](../frontend/src/lib/download.ts): local file downloads and formula-safe CSV encoding.
- [frontend/src/features/strategy-library/strategy-library-screen.tsx](../frontend/src/features/strategy-library/strategy-library-screen.tsx): rule catalog and explicit configuration navigation.
- [frontend/src/features/strategy-library/strategy-templates.ts](../frontend/src/features/strategy-library/strategy-templates.ts): versioned EMA, RSI and channel rule descriptions and parameter defaults.
- [frontend/src/features/spread-builder/spread-payoff.ts](../frontend/src/features/spread-builder/spread-payoff.ts): exact expiry extrema and breakevens with unbounded tail handling.
- [frontend/src/features/research/research-workbench.tsx](../frontend/src/features/research/research-workbench.tsx): shared saved definitions, actual historical runs and quote-derived payoff for Algo lab and Spread builder.
- [frontend/src/features/spread-builder/spread-builder-screen.tsx](../frontend/src/features/spread-builder/spread-builder-screen.tsx): dedicated options research entry point; starts with no fabricated contracts.
- [frontend/src/features/strategies/use-strategy-library.ts](../frontend/src/features/strategies/use-strategy-library.ts): abortable, validated real research library reads.
- [frontend/src/features/workspace/workspace-responsive.css](../frontend/src/features/workspace/workspace-responsive.css): shared responsive screen layout and mobile navigation.

Screens call feature hooks/adapters → same-origin API → authenticated application services → read-only data provider **or** separately authorized execution adapter. Pure models do not fetch or submit. Research and paper engines never import the live adapter. The workspace presentation flag is not execution permission.

## Runtime and repository configuration

| File | Responsibility / boundary |
| --- | --- |
| [run.ts](../run.ts) | Local development supervisor: starts private PostgreSQL, API and Next; owns child-process shutdown. |
| [package.json](../package.json) | Backend/runtime dependencies and complete check/build/dev commands. |
| [package-lock.json](../package-lock.json) | Exact root dependency graph for reproducible installation; never hand-upgrade transitive versions. |
| [tsconfig.json](../tsconfig.json) | Strict backend TypeScript compilation and output boundary. |
| [eslint.config.js](../eslint.config.js) | Repository lint, React hook-dependency and formatting rules; do not suppress safety rules to pass a build. |
| [.env.example](../.env.example) | Public configuration template with disabled-by-default live execution; never commit real secrets. |
| [.gitignore](../.gitignore) | Excludes credentials, databases, generated builds, dependencies and test evidence. |
| [.dockerignore](../.dockerignore) | Excludes local state, documentation and tests from production build contexts. |
| [.github/workflows/checks.yml](../.github/workflows/checks.yml) | Isolated quality, browser, dependency, container and encrypted-backup gates. |
| [.vscode/launch.json](../.vscode/launch.json) | Private local Node debugging configuration; debugger memory can contain credentials. |
| [Makefile](../Makefile) | Developer shortcuts and explicit single-host deployment lifecycle. |
| [Dockerfile](../Dockerfile) | Separate compiled API/worker/backup and standalone Next production targets. |
| [docker-compose.yml](../docker-compose.yml) | Single-host service wiring, restricted roles, private ports, health checks and volumes. |
| [Caddyfile](../Caddyfile) | TLS edge and trusted-header overwrite; internal API ports must remain private. |
| [LICENSE](../LICENSE) | Repository licensing terms. |
| [README.md](../README.md) | Current capabilities, safe local setup, deployment and backup/restore procedure. |
| [docs/development-guide.md](../docs/development-guide.md) | Naming, screen/hooks conventions, data/exec contracts and debugging guidance. |
| [docs/security-review.md](../docs/security-review.md) | Current security boundaries and release gates. |
| [docs/kotak-api-coverage.md](../docs/kotak-api-coverage.md) | Kotak market-data operation coverage; not permission for live execution. |
| [docs/code-review-2026-09-18.md](../docs/code-review-2026-09-18.md) | Dated findings, remediation evidence and remaining risks. |
| [docs/repository-map.md](../docs/repository-map.md) | This inventory; update alongside additions, removals and responsibility moves. |

## Backend: composition, storage and account security

| File | Responsibility / boundary |
| --- | --- |
| [backend/main.ts](../backend/main.ts) | Composition root, authentication/CSRF, request admission and HTTP route registration; only explicit commands enable execution. |
| [backend/types.ts](../backend/types.ts) | Workspace strategy/job schemas retained for current records and legacy migration compatibility. |
| [backend/database.ts](../backend/database.ts) | PostgreSQL transactions, migrations, roles and durable ledgers; application data must not be reset during refactors. |
| [backend/local-database.ts](../backend/local-database.ts) | Project-local PostgreSQL cluster discovery/start/stop; not a production orchestrator. |
| [backend/security.ts](../backend/security.ts) | Password hashing, session hashing, secret encryption, request limits and safe error primitives. |
| [backend/mfa.ts](../backend/mfa.ts) | Encrypted TOTP enrollment, verification/replay rejection, recovery codes and revocation. |
| [backend/backup.ts](../backend/backup.ts) | Encrypted PostgreSQL backup, optional off-server upload, health and explicit restore/decrypt tooling. |
| [backend/import-legacy-sqlite.ts](../backend/import-legacy-sqlite.ts) | Offline legacy import into PostgreSQL; retained migration tool, not a runtime database dependency. |

## Backend: data, virtual execution and research

| File | Responsibility / boundary |
| --- | --- |
| [backend/broker-data-access.ts](../backend/broker-data-access.ts) | Read-only broker reader contract plus per-owner admission guard; deliberately no place/modify/cancel methods. |
| [backend/market-data-provider.ts](../backend/market-data-provider.ts) | Broker-independent discovery, display/fill quotes, history and shared-feed contract. |
| [backend/kotak-market-data-provider.ts](../backend/kotak-market-data-provider.ts) | Maps the provider contract onto the authenticated Kotak client. |
| [backend/kotak-market-data-client.ts](../backend/kotak-market-data-client.ts) | Session-bound Kotak auth, allowlisted transports, normalized reads and guarded execution connection factory. |
| [backend/kotak-market-data-contracts.ts](../backend/kotak-market-data-contracts.ts) | Bounded explorer request schemas, approved endpoint construction and response parsers. |
| [backend/kotak-market-data-routes.ts](../backend/kotak-market-data-routes.ts) | Authenticated explorer operation/feed endpoints and request-budget enforcement. |
| [backend/kotak-market-data-stream.ts](../backend/kotak-market-data-stream.ts) | Server WebSocket lifecycle, bounded binary decoding, feed cache and viewer lease cleanup. |
| [backend/instrument-master.ts](../backend/instrument-master.ts) | Allowlisted master CSV loading, freshness and exact contract/tick/lot resolution. |
| [backend/broker-portfolio-normalizer.ts](../backend/broker-portfolio-normalizer.ts) | Normalizes positions, funds, reports and valuation coefficients while preserving unknown values. |
| [backend/paper-trading-ledger.ts](../backend/paper-trading-ledger.ts) | Integer-paise virtual balances, reservations, fill matching and option restrictions; no execution adapter. |
| [backend/paper-trading-routes.ts](../backend/paper-trading-routes.ts) | Owner-scoped virtual ledger APIs and shared market-data compatibility routes. |
| [backend/historical-strategy-simulator.ts](../backend/historical-strategy-simulator.ts) | Pure historical basket replay with explicit fill/timing/slippage assumptions. |
| [backend/strategy-research-routes.ts](../backend/strategy-research-routes.ts) | Owner-scoped saved research, history retrieval, runs and batch replay requests. |

## Backend: real-money execution boundary

| File | Responsibility / boundary |
| --- | --- |
| [backend/live/contracts.ts](../backend/live/contracts.ts) | Normalized execution intents, snapshots, risk limits and ExecutionBrokerAdapter contract. |
| [backend/live/risk.ts](../backend/live/risk.ts) | Pure freshness/exposure/loss/position/limit checks; integer paise and exchange-unit quantities. |
| [backend/live/execution.ts](../backend/live/execution.ts) | Durable intent/OMS state transitions, idempotency, reconciliation, uncertain outcomes and halt/cancel. |
| [backend/live/kotak-live-adapter.ts](../backend/live/kotak-live-adapter.ts) | Exact Kotak payload/status mapping and app-owned cancellation checks; no implicit adoption of external orders. |
| [backend/live/kotak-live-manager.ts](../backend/live/kotak-live-manager.ts) | Owner/account/session binding, explicit configure/arm/preview lifecycle and bounded monitoring; status reads do not initialise controls. |
| [backend/live/kotak-live-routes.ts](../backend/live/kotak-live-routes.ts) | Validated live HTTP commands mounted after auth/CSRF; activation is independently gated. |
| [backend/live/spread-policy.ts](../backend/live/spread-policy.ts) | Tested multi-leg policy model; not exposed as live basket submission. |
| [backend/live/shadow.ts](../backend/live/shadow.ts) | Pure would-submit/risk-reject planner; structurally unable to submit or cancel. |

## Frontend: framework and shared utilities

| File | Responsibility / boundary |
| --- | --- |
| [frontend/package.json](../frontend/package.json) | Frontend-only dependencies and TS/MJS tests; production imports must be declared here, not only at root. |
| [frontend/package-lock.json](../frontend/package-lock.json) | Exact frontend install graph used by the standalone web build. |
| [frontend/tsconfig.json](../frontend/tsconfig.json) | Frontend typing and @/ source alias. |
| [frontend/next.config.ts](../frontend/next.config.ts) | Standalone Next build, API rewrite and server configuration. |
| [frontend/postcss.config.mjs](../frontend/postcss.config.mjs) | Tailwind/PostCSS build configuration. |
| [frontend/next-env.d.ts](../frontend/next-env.d.ts) | Next-generated type entry; framework may rewrite dev/build paths, do not maintain manually. |
| [frontend/AGENTS.md](../frontend/AGENTS.md) | Repository-specific Next development instructions for coding agents. |
| [frontend/CLAUDE.md](../frontend/CLAUDE.md) | Companion agent entry documentation; not shipped to production. |
| [frontend/src/proxy.ts](../frontend/src/proxy.ts) | Per-document nonce/CSP and browser response security headers. |
| [frontend/src/app/layout.tsx](../frontend/src/app/layout.tsx) | Document metadata, root markup and shared styles. |
| [frontend/src/app/page.tsx](../frontend/src/app/page.tsx) | Thin route composition only; no forms, broker calls or calculations. |
| [frontend/src/app/globals.css](../frontend/src/app/globals.css) | Existing shared visual tokens/layout/component classes; avoid unrelated global selector changes. |
| [frontend/src/app/reference/index-constituents/route.ts](../frontend/src/app/reference/index-constituents/route.ts) | Allowlisted server-side constituent CSV route with bounded downloads and caching; not an arbitrary URL proxy. |
| [frontend/src/lib/api.ts](../frontend/src/lib/api.ts) | Same-origin JSON transport, CSRF, deadlines/caller abort and non-retried mutations. |
| [frontend/src/lib/latest-request.ts](../frontend/src/lib/latest-request.ts) | Generation plus abort gate so superseded reads cannot overwrite current state. |
| [frontend/src/lib/format.ts](../frontend/src/lib/format.ts) | Shared cached INR formatter; unavailable values are not converted to zero. |
| [frontend/src/lib/index-constituents.ts](../frontend/src/lib/index-constituents.ts) | Official index-source registry and validated constituent CSV parsing. |
| [frontend/src/lib/trading-mode.ts](../frontend/src/lib/trading-mode.ts) | Presentation-mode/navigation/activity policy; never grants backend live permission. |
| [frontend/src/components/ui/button.tsx](../frontend/src/components/ui/button.tsx) | Shared typed button presentation and variants. |
| [frontend/src/components/instrument-picker.tsx](../frontend/src/components/instrument-picker.tsx) | Reusable exact-contract/cash-symbol selection with fenced searches; broker wire identity is retained. |
| [frontend/src/components/option-chain-picker.tsx](../frontend/src/components/option-chain-picker.tsx) | Manual option identity fields used in research/paper forms. |
| [frontend/src/components/kotak-option-chain.tsx](../frontend/src/components/kotak-option-chain.tsx) | Broker-master chain selector for paper/research workflows. |
| [frontend/src/components/live-option-chain.tsx](../frontend/src/components/live-option-chain.tsx) | Index/constituent/expiry/strike selection and valid cached-tick display; no order submission. |
| [frontend/src/components/kotak-account-reports.tsx](../frontend/src/components/kotak-account-reports.tsx) | Legacy Kotak report details and cached-price revaluation on the Live trading page. |
| [frontend/src/components/broker-portfolio-panel.tsx](../frontend/src/components/broker-portfolio-panel.tsx) | Read-only normalized broker portfolio panel reused beside virtual trading. |

## Frontend: dedicated screens and their supporting modules

| File | Responsibility / boundary |
| --- | --- |
| [frontend/src/features/workspace/workspace-app.tsx](../frontend/src/features/workspace/workspace-app.tsx) | Auth vs signed-in root; keyed session boundary prevents private form state leaking across accounts. |
| [frontend/src/features/workspace/workspace-shell.tsx](../frontend/src/features/workspace/workspace-shell.tsx) | Navigation, shared layout and mode policy only; independent screen failures do not remove the sidebar. |
| [frontend/src/features/workspace/workspace-content.tsx](../frontend/src/features/workspace/workspace-content.tsx) | Lazy screen dispatcher with accessible loading fallback. |
| [frontend/src/features/workspace/workspace-navigation.ts](../frontend/src/features/workspace/workspace-navigation.ts) | Known destinations/icons; no network operations or arbitrary URL navigation. |
| [frontend/src/features/workspace/workspace-types.ts](../frontend/src/features/workspace/workspace-types.ts) | Browser workspace/auth/replay contracts. |
| [frontend/src/features/workspace/workspace-api.ts](../frontend/src/features/workspace/workspace-api.ts) | Runtime validation of workspace and public authentication-policy JSON. |
| [frontend/src/features/workspace/use-workspace-session.ts](../frontend/src/features/workspace/use-workspace-session.ts) | Abortable/fenced session reads, explicit auth/logout and sequential active-job polling. |
| [frontend/src/features/workspace/screen-error-boundary.tsx](../frontend/src/features/workspace/screen-error-boundary.tsx) | Screen-local render failure containment; never automatically repeats a mutation. |
| [frontend/src/features/auth/auth-screen.tsx](../frontend/src/features/auth/auth-screen.tsx) | Sign-in/setup/registration form presentation; clears submitted credentials and delegates auth lifecycle. |
| [frontend/src/features/overview/overview-screen.tsx](../frontend/src/features/overview/overview-screen.tsx) | Overview presentation and shared-data actions, not broker protocol parsing. |
| [frontend/src/features/overview/overview-screen.module.css](../frontend/src/features/overview/overview-screen.module.css) | Scoped Overview visual layout and responsive styles. |
| [frontend/src/features/overview/overview-types.ts](../frontend/src/features/overview/overview-types.ts) | Broker-neutral account, position, tick and adapter contracts. |
| [frontend/src/features/overview/overview-model.ts](../frontend/src/features/overview/overview-model.ts) | Pure P&L/position revaluation and unavailable/freshness rules. |
| [frontend/src/features/overview/use-overview-account.ts](../frontend/src/features/overview/use-overview-account.ts) | Session/mode-scoped account snapshot and feed-consumer lifecycle. |
| [frontend/src/features/overview/load-overview-snapshot.ts](../frontend/src/features/overview/load-overview-snapshot.ts) | Reads only the selected live or virtual account domain. |
| [frontend/src/features/overview/broker-registry.ts](../frontend/src/features/overview/broker-registry.ts) | Enabled UI account-adapter registration; no implicit unsupported broker fallback. |
| [frontend/src/features/overview/providers/kotak-account-adapter.ts](../frontend/src/features/overview/providers/kotak-account-adapter.ts) | Kotak account/price-cache normalization behind the Overview adapter interface. |
| [frontend/src/features/strategies/strategies-screen.tsx](../frontend/src/features/strategies/strategies-screen.tsx) | Actual saved research library, search/filter and cash/spread editor navigation. |
| [frontend/src/features/strategy-lab/strategy-lab-screen.tsx](../frontend/src/features/strategy-lab/strategy-lab-screen.tsx) | Research basket editor, quotes, payoff and historical playback; no automatic live execution. |
| [frontend/src/features/paper-trading/paper-trading-screen.tsx](../frontend/src/features/paper-trading/paper-trading-screen.tsx) | Separate virtual wallet, paper order form and optional quote-driven matching. |
| [frontend/src/features/market-data/market-data-screen.tsx](../frontend/src/features/market-data/market-data-screen.tsx) | Read-only Kotak diagnostic tools and shared feed controls; provider wire fields stay at this boundary. |
| [frontend/src/features/orders/orders-screen.tsx](../frontend/src/features/orders/orders-screen.tsx) | Chooses actual live OMS history or the separate virtual-ledger order records. |
| [frontend/src/features/orders/live-orders-screen.tsx](../frontend/src/features/orders/live-orders-screen.tsx) | Read-only app-managed live order/fill table with unavailable states. |
| [frontend/src/features/orders/live-orders-api.ts](../frontend/src/features/orders/live-orders-api.ts) | Loads and interprets live OMS status, never a virtual fallback ledger. |
| [frontend/src/features/orders/use-live-orders.ts](../frontend/src/features/orders/use-live-orders.ts) | Entry/manual history reads with generation fencing; no automatic order polling. |
| [frontend/src/features/orders/paper-orders-screen.tsx](../frontend/src/features/orders/paper-orders-screen.tsx) | Actual virtual-ledger order history, explicit reads and safe exports. |
| [frontend/src/features/brokers/brokers-screen.tsx](../frontend/src/features/brokers/brokers-screen.tsx) | Broker-neutral connection screen delegating protocol/auth behavior to an adapter. |
| [frontend/src/features/brokers/broker-connection-adapter.ts](../frontend/src/features/brokers/broker-connection-adapter.ts) | Connection field metadata, wallet-independent status/login and safe credential boundaries. |
| [frontend/src/features/brokers/use-broker-connection.ts](../frontend/src/features/brokers/use-broker-connection.ts) | Connection request state, duplicate-submit lock and stale-result fencing. |
| [frontend/src/features/live-trading/live-trading-screen.tsx](../frontend/src/features/live-trading/live-trading-screen.tsx) | Composes explicit order ticket and read-only account reports. |
| [frontend/src/features/live-trading/live-order-ticket.tsx](../frontend/src/features/live-trading/live-order-ticket.tsx) | Risk configuration, MFA arming, preview, confirmation and halt controls; no effect-driven submission. |
| [frontend/src/features/account/account-screen.tsx](../frontend/src/features/account/account-screen.tsx) | App password/MFA/session management; not broker credential configuration. |
| [frontend/src/features/activity/activity-screen.tsx](../frontend/src/features/activity/activity-screen.tsx) | Escaped audit text and presentation-mode filtering; stored audit records are retained. |
| [frontend/src/features/activity/audit-model.ts](../frontend/src/features/activity/audit-model.ts) | Pure derived audit categories, bounded search and explicit IST timestamp formatting. |
| [frontend/src/features/research/research-draft.ts](../frontend/src/features/research/research-draft.ts) | Full in-memory spread parameters and saved identity, preserved across chain/builder navigation. |
| [frontend/src/features/learning/learning-screen.tsx](../frontend/src/features/learning/learning-screen.tsx) | Static architecture/learning guide with no trading side effects. |

## Tests: retain in Git, exclude from production runtime

| File | Responsibility / boundary |
| --- | --- |
| [tests/helpers/postgres.mjs](../tests/helpers/postgres.mjs) | Disposable randomly named schemas, migrations and cleanup for tests; never the application schema. |
| [tests/fixtures/fake-execution-broker.mjs](../tests/fixtures/fake-execution-broker.mjs) | Deterministic execution adapter supporting timeout/reconciliation/fill scenarios. |
| [tests/fixtures/instruments.mjs](../tests/fixtures/instruments.mjs) | Synthetic master contracts for exact identity/lot/tick tests. |
| [tests/fixtures/kotak-data.mjs](../tests/fixtures/kotak-data.mjs) | Offline market-data/feed payload fixtures; no real broker connection. |
| [tests/fixtures/legacy-password.mjs](../tests/fixtures/legacy-password.mjs) | Compatibility-only password fixture for legacy import tests. |
| [tests/backend/api.test.mjs](../tests/backend/api.test.mjs) | Auth, workspace/jobs, isolation, security boundaries and API lifecycle. |
| [tests/backend/security.test.mjs](../tests/backend/security.test.mjs) | Secret encryption/password/security primitives. |
| [tests/backend/import.test.mjs](../tests/backend/import.test.mjs) | Offline legacy migration behavior and ownership. |
| [tests/backend/instrument-master.test.mjs](../tests/backend/instrument-master.test.mjs) | Master allowlists, parsing, contracts and bounded searches. |
| [tests/backend/kotak-auth.test.mjs](../tests/backend/kotak-auth.test.mjs) | Kotak login/session races, revocation and credential handling. |
| [tests/backend/kotak-market-data.test.mjs](../tests/backend/kotak-market-data.test.mjs) | REST operation contracts/parsers, routes and offline WebSocket protocol fixtures. |
| [tests/backend/kotak-research.test.mjs](../tests/backend/kotak-research.test.mjs) | Broker history/quotes and paper/research integration. |
| [tests/backend/market-data-provider.test.mjs](../tests/backend/market-data-provider.test.mjs) | Provider injection, capability/namespace checks and separation from account access. |
| [tests/backend/paper.test.mjs](../tests/backend/paper.test.mjs) | Virtual ledger reservations, fills, ownership and validation. |
| [tests/backend/research.test.mjs](../tests/backend/research.test.mjs) | Historical replay correctness and research API behavior. |
| [tests/backend/live.test.mjs](../tests/backend/live.test.mjs) | Generic OMS/risk/shadow/spread behavior, uncertainty, drift and restart recovery. |
| [tests/backend/kotak-live.test.mjs](../tests/backend/kotak-live.test.mjs) | Offline Kotak execution payloads, permissions, duplicate confirmation and cancellation ownership. |
| [tests/backend/live-status-readonly.test.mjs](../tests/backend/live-status-readonly.test.mjs) | Dormant live GET performs only owner/broker-scoped SELECTs and starts no control session. |
| [tests/backend/halt-admission.test.mjs](../tests/backend/halt-admission.test.mjs) | Ordinary request exhaustion cannot consume halt capacity; CSRF still required. |
| [tests/backend/trading-mode.test.mjs](../tests/backend/trading-mode.test.mjs) | Server presentation flags and wallet-independent broker/account routes. |
| [tests/frontend/index-constituents.test.mjs](../tests/frontend/index-constituents.test.mjs) | Official CSV validation, allowlists, per-index caching and failure behavior. |
| [tests/frontend/overview-adapter.test.ts](../tests/frontend/overview-adapter.test.ts) | Account normalization and provider read paths; unknown values remain unknown. |
| [tests/frontend/overview-model.test.ts](../tests/frontend/overview-model.test.ts) | Atomic row/headline P&L, stale/future/out-of-order tick rejection and valuation units. |
| [tests/frontend/overview-mode-render.test.ts](../tests/frontend/overview-mode-render.test.ts) | Server-rendered Overview markup keeps live/paper presentation distinct. |
| [tests/frontend/trading-mode.test.ts](../tests/frontend/trading-mode.test.ts) | Mode/navigation/activity guards and selected account source. |
| [tests/frontend/live-orders.test.ts](../tests/frontend/live-orders.test.ts) | Read-only live history and unavailable/error behavior without paper fallback. |
| [tests/frontend/workspace-foundation.test.ts](../tests/frontend/workspace-foundation.test.ts) | Obsolete-read invalidation plus malformed workspace/auth payload rejection. |
| [tests/architecture/boundaries.test.mjs](../tests/architecture/boundaries.test.mjs) | Thin route, dedicated screens, source boundary/dependency/lock consistency, documentation inventory and CI coverage. |
| [tests/e2e/kotak-smoke.mjs](../tests/e2e/kotak-smoke.mjs) | Isolated mocked-broker production browser workflow; explicit paper fixture, never a real broker smoke trade. |

## Generated/private directories and cleanup policy

- `node_modules/`, `frontend/node_modules/`, `dist/`, `frontend/.next/`, TypeScript caches and ESLint caches are regenerable, ignored build inputs/outputs. Do not commit them.
- `.runtime/` contains private local database/configuration/keys. `backups/` and `.env` are also private. They are **not junk** and were not deleted during the review.
- `tests/artifacts/` is ignored test evidence. Keep useful regression tests in Git; production images do not need their source files.
- Old screen component paths were removed only after moving their implementations and updating imports. No duplicate compatibility wrappers are retained.
- The legacy importer, backup tool, shadow planner and spread policy remain deliberate tools/tested models, not accidentally orphaned production routes. Do not remove them solely because the browser does not import them.
- Keep lockfiles, migration definitions, CI and agent instructions. Local package-manager configuration may exist outside the source inventory; never store registry credentials in it.
