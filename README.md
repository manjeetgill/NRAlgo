# NRIAlgo terminal

A single-user trading workspace with React/Next.js, an Express API, PostgreSQL and a private Python calculation service. Real execution is disabled by default. A successful build is not certification for live trading.

## Responsibilities

| Layer             | Owns                                                                                                   | Must not do                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| React / Next.js   | Screens, forms, charts, selection and rendering validated results                                      | Authoritative strategy pricing or direct broker execution  |
| Node.js / Express | Authentication, brokers, live data, order execution, execution risk, persistence and job orchestration | Maintain a second backtest/payoff engine                   |
| Python / FastAPI  | Historical processing, indicators, strategy simulation, payoff, Greeks and analytical risk             | Receive broker credentials or place orders                 |
| PostgreSQL        | Account isolation, durable jobs, historical candles, orders and audit records                          | Grant the runtime account schema-administration privileges |

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

| Location                                                                 | Responsibility                                                                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/main.ts`                                                        | Express composition, session/authentication and protected route registration                                                                                            |
| `backend/database.ts`, `types.ts`, `local-database.ts`                   | Schema migrations, database contracts and development PostgreSQL lifecycle                                                                                              |
| `backend/backup.ts`, `import-legacy-sqlite.ts`                           | Encrypted backup/restore and explicit legacy migration; not request handlers                                                                                            |
| `backend/security.ts`, `mfa.ts`                                          | Password/session protections, second factor and credential encryption                                                                                                   |
| `backend/broker-registry.ts`, `zerodha-connection.ts`                    | Owner-scoped active selection and one-use Zerodha authorization with a private SDK adapter                                                                              |
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
| `frontend/src/features/option-chain/`                                    | Live/stored chain selection, exact stored chart reads, chart rendering and standalone-chain Python-derived IV/Greeks; Builder and Simulator do not request chain Greeks |
| `frontend/src/features/backtest-studio/`, `spread-builder/`, `research/` | Form inputs and presentation of Python calculation results                                                                                                              |
| Other `frontend/src/features/` folders                                   | Account, audit, database, learning and saved-strategy screens, each with its own screen entrypoint                                                                      |
| `frontend/src/components/`, `lib/`                                       | Shared controls, instrument pickers, request validation and presentation utilities                                                                                      |
| `scripts/download*`, `audit-nse*`, `import-*`                            | Explicit historical-data download, quality audit and additive import commands                                                                                           |
| `scripts/check-production-environment.mjs`                               | Fail-closed deployment settings validation; never prints secrets                                                                                                        |
| `scripts/preflight-commit.mjs`, `.githooks/`, `.github/workflows/`       | Staged/revision build gates and commit-by-commit CI                                                                                                                     |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `Makefile`              | Runtime images, single-host service wiring, HTTPS and operator commands                                                                                                 |

## Data and calculations

- Backtest studio reads stored daily cash/index candles and queues a Python job. It does not fabricate missing prices or silently use a broker-history fallback.
- The historical simulator is for indexes using saved data. Available daily candles do not establish historical intraday option-premium coverage.
- Options builder sends premiums, strikes, quantities, dates and volatility assumptions to Python. Returned results include payoff curves, signed net debit/credit, breakevens, extrema and Greeks. Model output is not a broker margin quote or an execution guarantee.
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

Kotak live execution is implemented behind explicit enablement. Zerodha authorization/connection is separate from execution capability; selecting an unsupported execution adapter fails closed. ICICI is not implemented.

The server resolves the active broker when an intent is bound. Changing the selection must not move existing orders or positions to another broker. Live execution requires configured server flags, app MFA, an authenticated broker session, registered static-IP prerequisites, risk limits, fresh reconciliation and explicit time-limited arming.

Preview is not submission. Unknown submission outcomes must be reconciled, never automatically resent. Halt latches permission off; cancellation acknowledgements do not prove exchange cancellation, and halt does not automatically flatten positions. Keep `LIVE_TRADING_ENABLED=false` until these paths have been manually verified with the broker.

## Single-host deployment

The supported topology is one Linux host, one API and **one calculator container**. A 4 GiB host is a starting configuration, not a live-trading performance guarantee. Steady-state container memory caps total 2,816 MiB; migrations add at most 384 MiB temporarily. Leave the remaining memory for Linux and Docker. Builds and recovery drills belong on development/CI machines, never on the trading host.

### Worker safety and resource limits

- PostgreSQL serializes job claims globally. Each claim has a unique token, a renewable 150-second lease and at most three recovery attempts. Starting an API never resets another worker's unexpired claim. Every completion is fenced by its token; cancellation is persisted and checked on the five-second heartbeat.
- Stored candles are read in 500-row pages from a consistent snapshot, with a hard 10,000-row final payload limit. This is bounded batching, not an unlimited streaming backtest engine.
- `calculation_engine/worker.py` is the only supported HTTP entrypoint. It admits one request at a time and runs numerical routes in a disposable process. Disconnect, crash, timeout and shutdown release that process; Linux parent-death protection prevents orphan computation. An eight-MiB measured request limit also covers chunked bodies. Child limits are 60 CPU seconds, 640 MiB address space and 90 seconds wall time. The container has 768 MiB, 0.75 CPU and 64 PIDs; numerical libraries use one thread.
- Heavy backtests and stored-session research are paused whenever `LIVE_TRADING_ENABLED=true`, even before an account is armed. Payoff/Greeks remain available, but compete for the same bounded calculator. Research never bypasses Node's live execution checks.
- `/api/health` checks database liveness; `/api/ready` additionally checks calculator health and worker progress. Calculator health remains responsive while busy. Do not scale the calculator or enable several live API instances without a separate capacity/execution review.

### CI release and first deployment

Every incoming commit runs the isolated build preflight. Successful pushes to `main` additionally build four runtime images, run the disposable recovery drill, and only then publish images to GHCR. The `release-<commit>` artifact contains `release.env`, including digests for app, PostgreSQL and Caddy images. It currently targets Linux amd64; use an amd64 EC2 instance. Images are not automatically deployed to AWS.

Provision Docker Compose, Node 22+, AWS CLI, iptables/ip6tables, a real domain/TLS, encrypted EBS and a private versioned S3 backup bucket. The EC2 security group should expose only 80/443; use SSM for administration instead of a public database or broad SSH rule. Require IMDSv2. The backup container needs metadata hop limit 2; container forwarding rules restrict metadata access to its dedicated network.

Keep `.env` nonsecret and mode 0600. Put the release artifact at `.env.release`. Use a separate deployment identity to retrieve a Secrets Manager JSON document containing the uppercase names listed in `scripts/host-operations.mjs`. Export into a **new** versioned directory; files are explicitly readable by their mounted container UID while the enclosing directory remains owner-only. No secrets are copied into images or published in Docker environment metadata. Optional registration/Zerodha fields may be empty, but their files must exist. Do not keep permanent AWS access keys in `.env`.

```sh
# Run export using a deployment identity authorized for this one secret.
SECRETS_DIR=/etc/nraialgo/secrets-v1 SECRETS_MANAGER_ID=your-secret-id \
  node scripts/host-operations.mjs export-secrets
# Set SECRETS_DIR, APP_DOMAIN, BACKUP_S3_URI, AWS_REGION and flags in .env.
# Copy release.env from the verified CI artifact to .env.release.
chmod 600 .env
make preflight
make deploy
make status
```

`make deploy` pulls immutable images, creates service networks, requires a privileged metadata-protection command, then starts the stack without building. Run from a stable Linux path such as `/opt/nraialgo`; `/usr/bin/node` and sudo are required for the firewall command. Never skip this step to work around a host configuration failure. Only Caddy publishes ports. Frontend, gateway, database and analytics use separate internal networks; only the API, public-reference calculator and backup have scoped egress networks. Migrations alone receive database-admin credentials. Reapply metadata protection after Docker/network recreation; the installed host unit reapplies it on boot. Validate firewall behavior and IMDSv2 from the actual EC2 host before enabling live execution.

### Backups, alerts and recovery

Backups run daily under a read-only database role, retain at most 14 local encrypted archives, upload with authenticated application encryption plus S3 encryption/checksum, and verify remote object length before updating the success marker. Failures retry after 15 minutes; a marker older than 26 hours is unhealthy. S3 bucket versioning/lifecycle/Object Lock policy and encryption-key custody are operator responsibilities. Local retention is recoverable only from a retained S3 copy after local archives are pruned.

The EC2 role needs only backup-prefix `s3:PutObject`, `s3:GetObject` (remote HEAD/restore verification), multipart-upload permissions as required, and `cloudwatch:PutMetricData` restricted to `NRAlgo/Host`. It must not read Secrets Manager, administer IAM or submit broker orders. Use a separate deployment identity for Secrets Manager export and `cloudwatch:PutMetricAlarm`. Confirm an SNS subscription before configuring alerts.

```sh
# .env includes ALERT_SNS_TOPIC_ARN and optional DEPLOYMENT_NAME.
node --env-file=.env scripts/host-operations.mjs configure-alerts
# Run once as root after Docker networks exist; installs a one-minute systemd timer.
sudo /usr/bin/node --env-file=.env scripts/host-operations.mjs install-monitor
```

The monitor sends only operational counters to CloudWatch: public HTTPS readiness, service health, backup age, host memory/disk usage and its own heartbeat. Alarms fire after three one-minute periods; missing metrics are treated as failure so host/monitor loss does not go silent. Alerts never restart services or trade automatically. Verify notification delivery with a staging outage; configuration alone is not evidence of delivery. Docker logs are size/rotation bounded locally; off-host application log shipping and broker-feed-specific alerts still need deployment-specific setup.

Run `make recovery-images` then `make recovery-check` on a development/CI machine. The drill derives an isolated configuration from production Compose, uses fresh secrets and synthetic rows, disables live trading and public ports, and checks process cancellation/crash/timeouts, resource caps, concurrent claims, stale-result fencing, lease recovery, cross-worker cancellation, encrypted backup restoration, tamper rejection and database/service restart. It deletes only its randomly named disposable containers/volumes and writes `.runtime/staging-recovery.json`. It does **not** prove S3 download recovery, SNS delivery, AWS security-group policy, live broker reconciliation or real-world trading latency.

Before live deployment, also restore an actual S3 object into a separate staging database, verify the retained key decrypts it, and test SNS delivery, EC2 reboot/firewall persistence, image vulnerability scans and broker reconnect/reconciliation. Keep live execution disabled through those drills. An API restart never preserves an armed trading session. Roll back by selecting a prior digest manifest only when its code is compatible with the forward-only schema; never roll a production database backward automatically. Preserve broker/backup encryption keys separately and rotate them only with a migration/recovery plan.

Implementation references: [Compose secret mounts](https://docs.docker.com/compose/how-tos/use-secrets/), [container resource settings](https://docs.docker.com/reference/compose-file/services/), [GitHub image publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [CloudWatch alarm behavior](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Alarms.html).

## Maintenance

### Sensitive data

Never commit credentials, private keys, database exports or logs. The commit preflight scans the exact candidate snapshot before running builds; `node scripts/check-secrets.mjs` checks tracked/unignored working files and `node scripts/check-secrets.mjs --history` audits reachable history. Findings show identifiers/categories only. This heuristic is not proof that arbitrary secrets or personal data are absent; review findings and use GitHub secret scanning where available. Removing a leaked secret from HEAD does not revoke it or erase history: rotate/revoke it first, then coordinate any history rewrite with collaborators.

Passwords use salted scrypt, session/recovery tokens use one-way hashes, and broker sessions/MFA secrets use account-bound AES-256-GCM encryption. Broker MPIN, password and TOTP inputs are not persisted. Do not add browser localStorage or logging for credentials. Local PostgreSQL bootstrap credentials are now AES-256-GCM encrypted in `.runtime/postgres-access.json`; reading a legacy plaintext file migrates it atomically without changing database passwords. Its separate `.runtime/postgres.key` is mode 0600 inside a mode-0700 directory. Keep that key out of exports; losing it loses access to the encrypted configuration. Replacing a plaintext file does not securely erase old filesystem snapshots or backups.

Encryption needs a protected bootstrap key: encrypting that key beside another key is not extra protection. Local key files and AWS mounted secrets remain readable to the owning process/OS administrator. Enable FileVault locally and encrypted EBS in AWS; production credentials originate in Secrets Manager and must not be copied into `.env`. Trade records, account usernames and operational metadata remain database records rather than individually encrypted fields; protect their disks, access and encrypted backups. Do not describe the complete database or a compromised host as protected by field encryption alone.

### Broker session recovery

Broker authorization tokens are encrypted in PostgreSQL with `BROKER_ENCRYPTION_KEY`, bound to the user, provider and original app login. Keep this key stable across restarts and outside the database; changing it requires fresh broker authorization. Passwords, MPIN and TOTP codes are never persisted. Existing memory-only connections require one fresh authorization after this upgrade.

After an API restart, broker/data reads attempt bounded, read-only verification before publishing a restored connection. Expiry is never extended (Kotak retains the app's eight-hour cap; Kite retains the next-06:00-IST cap). Logout/session deletion cascades to saved tokens; disconnect and security changes remove them explicitly. Live trading permission is not restored. Kite disconnect attempts remote API-token revocation; if that cannot be confirmed, the UI reports it. Kotak disconnect removes local access only.

Kotak feed interruptions retry at most five times with backoff while the original login remains valid and the viewer polls. Authentication rejection, explicit stop and session expiry are not retried. No order or login submission is automatically retried. Local storage assumes the existing single-API-process deployment; horizontal replicas require distributed connection/revocation coordination.

Run `node --import tsx scripts/verify-broker-sessions.mjs` against local PostgreSQL to check migration replay, encrypted restart recovery, isolation, logout cleanup, verification races and bounded fake-socket retries. It creates and removes only a disposable verification database and never contacts a real broker.

Keep this as the only project Markdown file. Next.js agent-file generation is disabled in `frontend/next.config.ts`. Read the installed framework's relevant documentation under `frontend/node_modules/next/dist/docs/` before changing Next behavior.

Do not remove validation, ownership checks, explicit confirmation or execution-risk code to reduce line count. Shared utilities and broker/analytics boundaries are intentionally separate. Prefer meaningful commits such as “Add stored option history” or “Simplify live order screen”, without mandatory type prefixes. Never include secrets, databases, generated build output or imported price files in a commit.
