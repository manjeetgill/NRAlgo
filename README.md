# NRIAlgo — trading workspace

One TypeScript repository: Next.js UI, Express API, PostgreSQL, independent market-data contracts, research/paper engines, and a separately authorized live OMS. Kotak Neo is the only implemented broker. **Real-order endpoints exist but are disabled by default.** This is a development foundation, not a production or real-money certification.

## Run locally

Use Node.js 22.13+ and PostgreSQL 17. On macOS:

```sh
brew install postgresql@17
make install
make run
```

Open http://localhost:3000. The launcher starts this project's PostgreSQL on 127.0.0.1:55432, applies migrations, starts the API/web, and opens the browser. Ctrl+C stops the app; `make db-stop` stops the database. `NEXUS_NO_BROWSER=1 make run` skips browser opening.

Create an app account, then open **Broker connections** and connect Kotak with your API access token, registered mobile, UCC, current TOTP and MPIN. Credentials are sent only to the server; Kotak tokens stay in session-bound memory. Reconnect after logout or restart. Never put credentials in chat, Git, or frontend environment variables.

Existing local data is preserved. Never reset a database as part of a normal upgrade; back up first and apply the reviewed migrations.

## What works

- **Paper trading (when enabled):** searchable current NSE cash symbols, option contracts and paginated option-chain snapshots. Paper fills and P&L use broker bid/ask data with freshness checks and virtual funds. They never reach a real order endpoint.
- **Broker portfolio:** separate read-only positions, holdings, funds, order book and trade book. Real account assets are never copied into the paper balance. Missing data stays unavailable.
- **Algo lab / Spread builder:** saved cash/options baskets, live snapshots, optional 15-second polling, single-session and batch historical replay. Historical fills are assumptions, not actual broker fills.
- **Market data:** all documented market-data API families: seven master files, eight quote filters, expiries, native option/futures chains, nine candle intervals and server-side native-batch WebSocket controls. Validated results can be downloaded as JSON. This explorer is read-only; broader data coverage does not enable futures paper orders.
- **Overview:** live mode reads broker funds/positions once and revalues them from the shared price cache. Missing values remain unavailable. Paper mode uses its separate virtual ledger. `PAPER_TRADING_ENABLED=false` hides only paper features, not research or other screens.
- **Strategies:** actual saved research in both modes, with search, market filters and dedicated cash/spread editors. No automatic strategy deployment is claimed.
- **Strategy library / Backtest studio:** versioned EMA, RSI and channel-breakout rules; validated user-provided daily OHLC CSV; next-open signals, explicit stop/target, fees and slippage. No generated-price fallback.
- **Option chain:** real contract metadata, shared streamed marks and contract detail drawers; selected legs preserve the complete in-memory spread draft.
- **Audit log:** bounded owner-event search, derived categories, event details and filtered safe CSV export.
- **Orders & trades / Live positions:** read-only app-managed OMS history is separate from explicit configure, arm, preview, submit, reconcile and halt controls. Supported real orders are bounded NSE EQ CNC and long NSE option NRML LIMIT/DAY orders; unsupported products fail closed.
- **Account & security:** per-user authentication, CSRF protection, MFA, recovery codes and session revocation.

Live execution requires server activation, the registered static-IP prerequisite, an authenticated Kotak session, app MFA, risk configuration, fresh reconciliation and explicit time-limited arming. Keep `LIVE_TRADING_ENABLED=false` and `KOTAK_STATIC_IP_CONFIRMED=false` while developing. The paper setting never grants live permission. Read [the live execution contract and limitations](docs/development-guide.md#kotak-live-execution-disabled-by-default) before considering activation.

## Small, extensible design

| Area                                                                       | Responsibility                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `backend/broker-data-access.ts`                                            | Read-only adapter contract and per-owner request guard                |
| `backend/kotak-market-data-client.ts`                                      | Kotak authentication, host/header handling and response normalization |
| `backend/kotak-market-data-contracts.ts` / `kotak-market-data-routes.ts`   | Bounded, authenticated market explorer contracts and routes           |
| `backend/kotak-market-data-stream.ts`                                      | Server-only WebSocket lifecycle and native-batch binary decoding      |
| `backend/instrument-master.ts`                                             | Current Kotak contract metadata, safe downloads and bounded search    |
| `backend/paper-trading-ledger.ts` / `paper-trading-routes.ts`              | Virtual ledger, fill rules and authenticated paper endpoints          |
| `backend/historical-strategy-simulator.ts` / `strategy-research-routes.ts` | Pure replay calculations and owner-scoped research APIs               |
| `backend/main.ts`                                                          | Dependency construction, account auth and route registration          |
| `backend/market-data-provider.ts` / `kotak-market-data-provider.ts`           | Replaceable data source, separate from execution and account access   |
| `backend/live/`                                                           | Durable OMS/risk engine, Kotak execution adapter and guarded routes   |
| `frontend/src/features/<screen>/`                                         | Dedicated screens, request hooks, models and presentation             |
| `frontend/src/components/` / `lib/`                                       | Reused UI and bounded shared utilities                               |
| `backend/database.ts` / `local-database.ts`                                | PostgreSQL migrations and local lifecycle                             |

To add a data source later, implement `MarketDataProvider` and register it at the composition root. To add an execution broker, separately implement `ExecutionBrokerAdapter`, account/auth binding, instrument resolution and contract tests. Register the UI account adapter rather than adding broker branches to screens. Existing wire contracts remain Kotak-specific at the adapter boundary; a new source is not a URL-only replacement. Never add an execution method to the read-only data interface or silently translate saved instrument tokens.

## Checks and boundaries

Start with the [detailed foundation review](docs/code-review-2026-09-18.md),
[complete file map](docs/repository-map.md), and [development guide](docs/development-guide.md).

```sh
make check
make build
npm run test:browser
```

`make check` runs lint, backend compilation/tests, frontend type-check/tests (both TS and MJS), and architecture checks. CI additionally runs the production build, dependency audits, browser smoke test and disposable container/backup checks. Browser tests start their own server on 3010. Tests use isolated PostgreSQL schemas and mocked broker transports, never the local application schema or a real broker account. On macOS they use installed Chrome; elsewhere install Playwright Chromium. Passing tests does not prove real broker connectivity or deployment readiness. Tests and documentation remain in Git but are excluded from production Docker images.

Current limitations: no automatic strategy execution; no futures paper execution; no naked paper option sales; no automatic expired-option settlement; no expired-contract history support. Kotak positions may omit untraded carry-forward exposure. Quote snapshots are not atomic multi-leg prices. Research polling stops on navigation, hidden tabs, edits or errors. Streaming is indicative and requires a login-provided approved `feedUrl`; its opaque exchange timestamps are not used for paper fill freshness. Stream reconnect is explicit; abandoned viewers expire after 45 seconds.

See [Kotak API coverage](docs/kotak-api-coverage.md) and [security boundaries](docs/security-review.md).

Private local state lives under `.runtime/`, including PostgreSQL settings and the MFA encryption key. Keep it out of Git. Production requires HTTPS, MFA for broker data, private database/API ports and separate encrypted backups. The offline SQLite importer is migration tooling only, not an application database.

## Deploy on a single AWS Lightsail server

Keep API, web, PostgreSQL, Caddy and backup service together initially. Use a Linux host
with Docker Engine/Compose, a domain and a static IPv4. Allow 80/443; restrict SSH to trusted
administration access. Do not expose 3000, 8000 or 5432. Check IPv6 rules too.

Clone your reviewed repository and copy `.env.example` to `.env`, then restrict it to mode 0600.
Configure:

```dotenv
APP_DOMAIN=algo.your-domain.example
POSTGRES_PASSWORD=RANDOM_DATABASE_ADMIN_PASSWORD
APP_DATABASE_PASSWORD=RANDOM_64_HEX_RUNTIME_PASSWORD
BACKUP_DATABASE_PASSWORD=DIFFERENT_RANDOM_64_HEX_BACKUP_PASSWORD
SETUP_TOKEN=RANDOM_INITIAL_SETUP_TOKEN_AT_LEAST_32_CHARACTERS
BROKER_ENCRYPTION_KEY=RANDOM_64_HEX_CREDENTIAL_KEY
BACKUP_ENCRYPTION_KEY=DIFFERENT_RANDOM_64_HEX_BACKUP_KEY
REGISTRATION_TOKEN=RANDOM_INVITATION_TOKEN_AT_LEAST_32_CHARACTERS
ALLOW_PUBLIC_REGISTRATION=false
```

Generate each value separately; the following prints a new 64-character random hex value:

```sh
sudo docker run --rm node:22-alpine node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep encryption keys outside the server in a password manager. Do not rotate them without a
re-encryption/recovery plan. Rotate the invitation token when access should change. Omitting it
closes additional registration unless open registration is explicitly enabled.

```sh
sudo make deploy
sudo make status
sudo make logs
```

The migration container uses database administrator credentials; the API uses a restricted
non-superuser role. Backups use a separate SELECT-only `nexus_backup` role; set the new
`BACKUP_DATABASE_PASSWORD` before deploying this revision. Migration grants read access to current
and future public-schema tables created by the migration owner. Caddy overwrites the trusted client-IP header used for throttling. The API
must remain private when `TRUST_EDGE_IP=true`. Only deploy one API:
multiple API replicas require shared request limits and a shared broker-session registry.

`/api/health` checks database access. `/api/ready` checks database schema readiness. Generated-price replay is retired: its public run route returns HTTP 410 and no worker starts locally or in Compose. Legacy regression helpers and stored rows are preserved, but never feed dashboard values.
Configure an external uptime alert against `/api/ready`, plus disk/memory/backup alerts. Docker
marks a hung process unhealthy but does not restart it merely because it is unhealthy.

The cloud database starts empty. This does not upload your local PostgreSQL data or credentials.
Validate HTTPS, MFA, two-account isolation, a replay, broker connectivity and restart recovery
before inviting anybody. Public/live-trading launch remains a separate release decision.

## Backups and restoration

The backup container creates an AES-GCM-encrypted PostgreSQL dump immediately and daily,
retaining local archives for fourteen days. Its health check fails if successful backups are old.
Local archives alone do **not** protect against losing the instance/disk.

For off-server copies configure `BACKUP_S3_URI=s3://your-private-bucket/nralgo` and a suitable
AWS identity. Prefer an instance role when supported; otherwise supply private, backup-only
AWS credentials. Block public bucket access, configure retention/versioning, and give the
uploader only the required object-write permissions. Upload failure fails the backup run.
No AWS resources, bucket or credentials are created by this repository.

To force a backup:

```sh
sudo docker compose exec -T backup node dist/backend/backup.js --once
```

Test restoration only into a **new disposable database**, never over the production database:

```sh
sudo docker compose exec -T backup ls /backups
sudo docker compose exec -T backup node dist/backend/backup.js --decrypt /backups/CHOSEN.dump.enc /backups/restore-check.dump
sudo docker compose exec -T db createdb -U nexus restore_check
sudo docker compose exec -T backup cat /backups/restore-check.dump | sudo docker compose exec -T db pg_restore -U nexus -d restore_check --exit-on-error --no-owner --no-acl
sudo docker compose exec -T db psql -U nexus -d restore_check -c 'SELECT count(*) FROM users;'
```

Decryption verifies integrity and refuses to overwrite an existing destination. Remove temporary
plaintext restore dumps once verified. Keep both encryption keys separate from the archives.
CI includes a disposable encrypted-backup restore test; actual server restoration must also pass.

For upgrades: back up, stop Caddy/web/API, update to a reviewed commit and run `make deploy`.
Schema migration rollback requires a matching backup and application revision. Never run
`docker compose down -v` on production: that deletes database, certificates and backup volumes.
