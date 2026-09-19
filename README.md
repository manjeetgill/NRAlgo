# NRIAlgo terminal

A single-user trading workspace with React/Next.js, an Express API, PostgreSQL and a private Python calculation service. Real execution is disabled by default. A successful build is not certification for live trading.

## Responsibilities

| Layer | Owns | Must not do |
| --- | --- | --- |
| React / Next.js | Screens, forms, charts, selection and rendering validated results | Authoritative strategy pricing or direct broker execution |
| Node.js / Express | Authentication, brokers, live data, order execution, execution risk, persistence and job orchestration | Maintain a second backtest/payoff engine |
| Python / FastAPI | Historical processing, indicators, strategy simulation, payoff, Greeks and analytical risk | Receive broker credentials or place orders |
| PostgreSQL | Account isolation, durable jobs, historical candles, orders and audit records | Grant the runtime account schema-administration privileges |

Express runs inside Node.js; it is not an additional server. Chart geometry, display-only overlays and input validation remain in React. Analytical risk belongs in Python; fresh quotes, arming, quantity/notional limits, idempotency and reconciliation are independently enforced by Node before execution.

Historical CSV import scripts still normalize some rows in Node. They are operator-only, not a second strategy engine. Moving that preprocessing to Python remains work to do.

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
npm run check               # Lint and both TypeScript checks on the working tree.
npm run preflight:commit    # Build only the staged snapshot, not unstaged changes.
node scripts/preflight-commit.mjs HEAD  # Recheck a particular committed revision.
```

The hook checks out the Git index into a disposable temporary directory. It installs dependencies from that snapshot's exact manifests/lockfiles, runs lint, compiles the backend, produces a Next.js production build and parses Python modules for syntax errors. Lockfile-keyed dependency caches live outside this repository. It never launches the trading app, migrates a database or contacts a broker. Build errors reject the commit. Staging fixes and retrying is required; do not bypass the hook with `--no-verify`.

GitHub Actions runs this preflight separately for each incoming commit in a push or pull request, with the failing revision in the job name. A new branch with no previous SHA checks its tip; pull requests check the full base-to-head range. Large pushes above the matrix limit must be split. Existing historical commits can be checked explicitly with the command above. Configure required CI checks/branch protection in GitHub to prevent bypass; local hooks are not distributed Git policy.

Automated test files, fixtures, browser-test dependencies and the obsolete specification acceptance register were removed at the owner's request. Build validation does **not** replace behavioral, broker integration, security or regression tests. Python syntax checks do not prove its dependencies install or calculations are correct. Exercise relevant screens and failure paths before release.

## Code map

Modules document their responsibility at the relevant component, class or function. Related private helpers live with their owning screen. Framework entrypoints and security boundaries remain separate intentionally.

Consolidated frontend modules have explicit owners: `features/overview/account-model.ts` holds shared account contracts and display valuation; `lib/stored-market-data.ts` validates stored instruments and daily reads; `features/workspace/workspace-views.tsx` groups reusable page commands, error containment and help. Snapshot validation stays private to `use-workspace-session.ts`. Broker views share `broker-hooks.ts`; presentation never owns live-order authorization.

| Location | Responsibility |
| --- | --- |
| `backend/main.ts` | Express composition, session/authentication and protected route registration |
| `backend/database.ts`, `types.ts`, `local-database.ts` | Schema migrations, database contracts and development PostgreSQL lifecycle |
| `backend/backup.ts`, `import-legacy-sqlite.ts` | Encrypted backup/restore and explicit legacy migration; not request handlers |
| `backend/security.ts`, `mfa.ts` | Password/session protections, second factor and credential encryption |
| `backend/broker-registry.ts`, `zerodha-connection.ts` | Owner-scoped active selection and one-use Zerodha authorization with a private SDK adapter |
| `backend/kotak-*`, `market-data-provider.ts`, `instrument-master.ts` | Kotak adapter, bounded provider contracts, streaming and exact instrument identity |
| `backend/live/` | Order intent binding, preview/confirmation, risk reservations, adapter dispatch, reconciliation and halt controls |
| `backend/paper-trading-*` | Separate virtual-account ledger; cannot authorize real orders |
| `backend/stored-market-data.ts` | Stored instrument/candle validation, batch persistence and bounded reads |
| `backend/option-chain-history.ts` | Exchange-session display selection and captured-chain fallback |
| `backend/historical-market-data*` | Broker historical-data transport validation; not backtest calculations |
| `backend/research-contracts.ts`, `strategy-research-routes.ts` | Saved strategy validation and delegation of research calculations |
| `backend/calculation-client.ts`, `calculation-jobs.ts` | Validated private Python calls and durable owner-scoped job lifecycle |
| `backend/database-browser-routes.ts` | Authenticated, read-only, owner-filtered inspection of allowlisted records |
| `calculation_engine/app.py`, `contracts.py` | Private authenticated calculation API and strict numerical inputs |
| `calculation_engine/backtest.py`, `payoff.py` | Canonical backtests, stored-session simulation, option payoff and portfolio Greeks |
| `calculation_engine/market_insights.py` | Bounded read-only public NSE reference datasets |
| `frontend/src/app/`, `proxy.ts` | Next.js entrypoints, broker callback, attribution and request boundary |
| `frontend/src/features/workspace/` | Navigation, session lifecycle, shared layout, dialogs and ordered workspace styles |
| `frontend/src/features/brokers/broker-hooks.ts`, `brokers-screen.tsx` | Shared connection/selection hooks and grouped broker views; authentication never arms execution |
| `frontend/src/features/live-trading/`, `orders/` | Explicit execution controls and read-only order records |
| `frontend/src/features/overview/` | Mode-isolated account snapshots, streamed display marks and explicit market-insight reads |
| `frontend/src/features/option-chain/` | Live/stored chain selection, exact stored chart reads, chart rendering and standalone-chain Python-derived IV/Greeks; Builder and Simulator do not request chain Greeks |
| `frontend/src/features/backtest-studio/`, `spread-builder/`, `research/` | Form inputs and presentation of Python calculation results |
| Other `frontend/src/features/` folders | Account, audit, database, learning and saved-strategy screens, each with its own screen entrypoint |
| `frontend/src/components/`, `lib/` | Shared controls, instrument pickers, request validation and presentation utilities |
| `scripts/download*`, `audit-nse*`, `import-*` | Explicit historical-data download, quality audit and additive import commands |
| `scripts/check-production-environment.mjs` | Fail-closed deployment settings validation; never prints secrets |
| `scripts/preflight-commit.mjs`, `.githooks/`, `.github/workflows/` | Staged/revision build gates and commit-by-commit CI |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `Makefile` | Runtime images, single-host service wiring, HTTPS and operator commands |

## Data and calculations

- Backtest studio reads stored daily cash/index candles and queues a Python job. It does not fabricate missing prices or silently use a broker-history fallback.
- The historical simulator is for indexes using saved data. Available daily candles do not establish historical intraday option-premium coverage.
- Options builder sends premiums, strikes, quantities, dates and volatility assumptions to Python. Returned results include payoff curves, signed net debit/credit, breakevens, extrema and Greeks. Model output is not a broker margin quote or an execution guarantee.
- Historical charts identify underlying candles separately from option premiums. KLineChart handles drawing/indicator presentation; attribution is available at `/legal/charting`.
- Importers validate by default where their CLI offers `--commit`. Review their usage before running; never point an unreviewed import at production. Preserve source/provenance and adjustment status. Missing candles are not invented.
- `scripts/requirements-bhavcopy.lock` contains optional historical-download dependencies; install separately when using those scripts. Runtime Python dependencies are in `calculation_engine/requirements.lock`.

## Broker and order safety

Kotak live execution is implemented behind explicit enablement. Zerodha authorization/connection is separate from execution capability; selecting an unsupported execution adapter fails closed. ICICI is not implemented.

The server resolves the active broker when an intent is bound. Changing the selection must not move existing orders or positions to another broker. Live execution requires configured server flags, app MFA, an authenticated broker session, registered static-IP prerequisites, risk limits, fresh reconciliation and explicit time-limited arming. A paper-mode setting never grants live permission.

Preview is not submission. Unknown submission outcomes must be reconciled, never automatically resent. Halt latches permission off; cancellation acknowledgements do not prove exchange cancellation, and halt does not automatically flatten positions. Keep `LIVE_TRADING_ENABLED=false` until these paths have been manually verified with the broker.

## Single-host deployment

Configure a real domain and private `.env` from `.env.example`. Keep runtime, migration, backup and encryption secrets distinct. Retain the broker/backup encryption keys securely outside the host: lost keys can make encrypted data unrecoverable.

```sh
chmod 600 .env
make preflight
make deploy
make status
make logs
```

Only Caddy publishes ports 80/443. PostgreSQL, the API and calculator stay on the private container network. Migrations run before the API. Backups use a separate read-only database account, authenticated encryption and configured S3 upload. Use an EC2 IAM role instead of permanent AWS keys where possible. Perform an actual restore drill; a green health check is not proof of recoverability.

`make deploy` currently builds on the host. Before using a small AWS trading host, move builds to CI and deploy immutable images. Pin a known release and plan database-compatible rollback. The database inspector's extra Next.js process is development-only, not a production Compose service.

### Remaining hosting limitations

- The job runner serializes jobs per API process, not globally. Startup recovery resets running jobs; do not run multiple API instances until job ownership/leases are implemented.
- HTTP cancellation does not terminate running Python work. Add process-level cancellation, time limits, CPU/memory caps and a live-execution research gate.
- Python's request-size guard currently trusts Content-Length rather than measuring chunked payloads.
- API readiness checks the database; ongoing calculator/worker health and broker-feed freshness need separate monitoring.
- Add off-host logs, memory/disk/backup alerts, secret rotation, restart/reconciliation drills and verified dependency/image scans before live deployment.

## Maintenance

Keep this as the only project Markdown file. Next.js agent-file generation is disabled in `frontend/next.config.ts`. Read the installed framework's relevant documentation under `frontend/node_modules/next/dist/docs/` before changing Next behavior.

Do not remove validation, ownership checks, explicit confirmation or execution-risk code to reduce line count. Shared utilities and broker/analytics boundaries are intentionally separate. Prefer meaningful commits such as “Add stored option history” or “Simplify live order screen”, without mandatory type prefixes. Never include secrets, databases, generated build output or imported price files in a commit.
