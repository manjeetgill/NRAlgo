# NRIAlgo

TypeScript trading-research workspace: Next.js frontend, Express API, a separate paper
worker, and PostgreSQL everywhere: local development, tests and AWS. Frontend and backend
stay in one repository. No SQLite driver is used by the running application.

**Current boundary:** users can connect their own ICICI Direct accounts and explore historical
candles/live quotes. The original EMA paper worker uses synthetic prices; the new Strategy lab
uses broker historical candles for scheduled cash/options basket research. A separate, explicitly enabled
ICICI live ticket supports small NSE cash limit orders. Do not treat a working build or mocked
tests as certification for public or unattended real-money trading.

## Run locally

Use Node 22.13+ in the Node 22 release line and PostgreSQL 17. On macOS:

```sh
brew install postgresql@17
make install
make run
```

The launcher builds the backend, starts a private PostgreSQL cluster on `127.0.0.1:55432`,
migrates the database, starts all three app processes and opens
[localhost](http://localhost:3000). Ctrl+C stops the app; `make db-stop` also stops the project
database. `make db-start` starts only the database. No Homebrew service or Docker is needed locally.
`NEXUS_NO_BROWSER=1 make run` skips
browser opening. `make check` runs regression tests/typechecking; `make build` builds production
artifacts. `npm run format` formats maintained source, not generated files.
`npm run test:browser` starts a disposable UI test after a build (Chrome on macOS;
`npx playwright install chromium` elsewhere). Tests use isolated PostgreSQL schemas and mocked
broker traffic, not your account data. CI supplies `TEST_DATABASE_URL`; locally the test helper
uses the private project cluster. `PG_BIN` can point to another PostgreSQL binary directory.

- The first account uses initial setup; additional users choose **Create another account**.
- Each account has its own strategies, jobs, pause state, audit events and broker credentials.
- Local registration is enabled by default. Set `ALLOW_PUBLIC_REGISTRATION=false` to close it.
- Existing single-owner data/passwords migrate to a private account without resetting them.
- Local data: `.runtime/postgres/`. Private database settings: `.runtime/postgres-access.json`.
  Local encryption key: `.runtime/broker.key` (mode 0600). Preserve it separately from database
  dumps; losing it requires re-entering broker credentials and recovering MFA.
- A TypeScript build is required before running the isolated Breeze SDK worker thread.

### Previous SQLite workspace

The legacy `.runtime/workspace.db` and its backups are retained as offline recovery files only.
For a not-yet-migrated schema-v3 workspace, stop the old app, run `make db-start`, then run:

```sh
node --import tsx backend/import-legacy-sqlite.ts /absolute/path/to/workspace.db
```

The one-time importer reads SQLite without modifying it and refuses a populated PostgreSQL
destination. It copies account/strategy/broker/MFA data atomically but deliberately invalidates
old login sessions. Sign in again with the same username/password. Preserve the original
`.runtime/broker.key`. Only this offline migration utility uses Node's built-in SQLite reader.

## Connect ICICI Direct

1. In **Account & security**, set up authenticator MFA and privately save the one-use recovery
   codes. MFA is required for cloud broker operations; local development permits it to be optional.
2. Register your own app in the [Breeze portal](https://api.icicidirect.com/apiuser/home).
   Use your app's URL plus `/breeze-callback` as the redirect, for example
   `http://localhost:3000/breeze-callback` locally if accepted by the portal, or
   `https://your-domain.example/breeze-callback` when deployed. Do not invent a static IP if
   the portal requires one: obtain and register the actual outbound address.
3. Open **Brokers**, enter your API key and follow **Open secure ICICI login**.
   Enter the ICICI password/OTP only on ICICI's website.
4. Copy the returned `API_Session` token from the callback page. Back in Brokers, provide your
   API key, API secret and that token, then choose **Connect & save securely**.
5. Request historical candles or subscribe to a live instrument. No quotes while the market is
   inactive is not evidence of a failed login. The UI reports waiting/stale/disconnected states.
6. When the broker session expires, log in to ICICI again and replace the session token.
   **Disconnect & forget** closes the SDK and deletes the saved encrypted credential record.

The callback is a manual handoff, not an automatic account-binding OAuth callback. It strips the
query from browser history, keeps the token only in component memory, and requires explicit
confirmation in the authenticated Brokers screen. Do not send callback URLs/tokens to analytics
or access logs. Broker sessions are not automatically renewed using stored ICICI passwords.

### Headers and required fields

The [official API reference](https://api.icicidirect.com/breezeapi/documents/index.html) distinguishes:

| Operation | Authentication |
| --- | --- |
| Initial customer-details exchange | JSON containing AppKey and the login token |
| Normal v1 requests | X-AppKey, X-SessionToken, X-Timestamp and X-Checksum |
| Historical-v2 | apikey and X-SessionToken |
| WebSocket quotes | SDK-managed socket authentication and instrument subscriptions |

The SDK generates headers server-side. The checksum combines UTC timestamp, exact JSON body
and secret using SHA-256. Keep server time synchronized; signed requests have a short clock
tolerance. The login token and exchanged API token are different values.

The broker documents 100 requests/minute and 5,000/day. Our lower app limits leave headroom;
usage from other applications still counts at the broker. Availability differs by segment/account.
Do not assume all SDK exchange constants represent enabled instruments for your account.

### Market-data boundaries

- Enter Breeze stock codes, not arbitrary display names. `RELIND`/`NSE`/Cash is a starting example.
- Derivatives require a matching derivative exchange, expiry, and appropriate right/strike.
  The server translates the date picker into historical/feed-specific expiry formats.
- This UI supports intraday windows up to one day and daily windows up to one year, capped
  at 1,000 returned candles. It does not silently download an unlimited history.
- One active live instrument per account; three simultaneous broker connections per server.
  Connections expire after ten minutes without use, app-session expiry, explicit removal or logout.
- SDK state is isolated in a worker thread per connected account, not shared across customers.
- The wrapper restores TLS verification after the SDK import and redacts SDK errors/logs.

## Account security

Passwords use asynchronous scrypt. Sessions use random HttpOnly/SameSite cookies and hashed
database tokens; production also sets Secure. Mutations require CSRF verification. Login limits
are source/username-specific so an unknown username cannot lock somebody else's account.

MFA setup requires the current password and confirmation from the authenticator. Codes cannot
be replayed; recovery codes are hashed and consumed once. Changing the password replaces all
sessions. **Sign out other devices** revokes other sessions and closes the broker connection.
There is no email/password-reset service yet: do not open general-public registration until
account recovery/support, privacy requirements and operational controls have been reviewed.

Secrets are encrypted using AES-256-GCM with account/purpose binding. The API never returns
stored secrets. Encryption keys belong in private server configuration, never `NEXT_PUBLIC_*`.
This protects database/backup contents, not a server compromised together with its keys.

## Strategy lab — historical simulator and cash/options builder

Open **Strategy lab** in the sidebar. This is an initial StockMock-style research workflow,
not a clone or a claim of equivalent exchange coverage. It uses the existing API, PostgreSQL
and ICICI connection: no new services, npm dependencies or paid charting subscription.

1. Connect/reconnect your account under **Brokers**. No credentials belong in the builder.
2. Choose a cash, long-straddle or bull-call-spread template. Cash supports one long leg;
   options support up to four explicit buy/sell contracts. Enter the real Breeze codes,
   expiry, strikes and **quantity in contract units (not lots)**. Template strikes are examples.
3. Set entry/exit times in IST, capital, assumed margin, basket stop/target, slippage and fees.
   Save the definition; editing creates an unsaved draft so old quotes cannot be reused.
4. In **Historical simulator**, choose a completed session and 1- or 5-minute candles.
   The server fetches every leg from ICICI, validates OHLC/session timestamps and rejects
   empty, gapped, duplicate, truncated or misaligned histories. Broker coverage, including
   expired options, must be available for your exact contracts; there is no synthetic fallback.
5. Rewind, play, step or scrub the saved replay. View basket marks, sampled drawdown and each
   simulated fill. Full-session summary metrics are explicitly separate from the replay cursor.
6. **Live data preview** offers manual REST quote snapshots or **Start basket stream** for
   up to four server-resolved instruments over an ICICI WebSocket. The browser polls only the
   local cache every 3 seconds, not ICICI REST. Each leg uses the exchange epoch timestamp;
   old last-trade times (60 seconds) or silent receipt times (30 seconds) invalidate its price.
   Same-underlying/same-expiry options can show an illustrative expiry payoff from bid/ask
   premiums; it is not a current mark-to-market pricing model or a bound on total possible loss.
7. A recent cash quote can pre-fill **Live trading**. This does not arm or place an order:
   existing MFA activation, fresh broker/risk checks and explicit review/confirmation still apply.
   **Options live execution is blocked.** No research endpoint can dispatch broker orders.

For easier contract entry, options builders include **Pick a contract from ICICI**. Enter the
underlying and an explicit expiry, load the call/put chain, filter strikes and choose a buy/sell
leg to replace or append. The endpoint costs two metered read-only requests. Returned strikes
may be incomplete; stale prices remain labeled and never become executable prices. This is
not an expiry-calendar or historical-chain service. Verify quantity/lot size and margin yourself.

Streaming reuses the existing isolated data worker: one feed per account, at most four marks
in memory and two coalesced worker messages per second. Starting a research basket replaces
the Brokers explorer feed. Socket loss/reconnect immediately clears all previous prices before
rejoining exact tokens. Closing/hiding the view requests a generation-specific stop; a vanished
browser expires after about 45 seconds without authenticated cache reads. An old tab cannot
stop a newer basket. **Stop research stream does not halt live orders**; use the separate live
kill control for that. No new database schema, dependency or paid service was added for feeds.

The pinned `breezeconnect` 1.0.31 option-chain method has an always-rejecting exchange condition
(`not NFO OR not BFO`). Our wrapper uses a fixed, read-only `GET optionchain` with the SDK's
existing signing/transport and strict NSE-options inputs. It does not modify `node_modules`
or expose arbitrary API methods. Offline tests cover the installed SDK defect, signing, wire
packet identities, timestamp regression, reconnect cleanup, lease expiry and account isolation.

Model `scheduled-basket-v1` performs one intraday round trip. Scheduled entries/exits fill at
the first available candle open at or after the chosen time. Stop/target decisions use completed
candle closes and execute at the next open (including gaps), never retrospectively within that
candle. All legs are assumed to fill together with adverse configured slippage and per-fill fees.
Taxes, depth/liquidity, partial fills, actual lot/tick validation, SPAN margin, early assignment,
multi-day scanning, Greeks, indicator rules and automatic strategy deployment are not implemented.
Short-option margin is a user-supplied research assumption; no premium credit grants buying power.
These results are not executable quotes, financial advice, or evidence of future profitability.

Definitions and immutable run snapshots are scoped to the signed-in user. The library is bounded
to 50 strategies and the latest 30 replays per user; deleting a research strategy also deletes its
replays, never live orders. Migration 6 adds only the two research tables and owner indexes.
The original paper worker/simulator and live order execution remain separate and unchanged by
this research workflow. Tests mock all broker traffic; real ICICI data still needs verification.

## ICICI live trading — separate from paper

Paper remains on the existing `backend/simulator.ts` and `backend/worker.ts` path. Neither
imports the live engine; no shared `live=true` switch can turn a paper replay into an order.
Open **Live trading**, or **Switch to live controls**, to access the separate real-money ticket.
Navigation alone does not enable orders. Paper strategies remain synthetic; there is no automatic
conversion of their EMA signals to live orders, and no live strategy scheduler is enabled.

1. Save your own API key, API secret and login `API_Session` under **Brokers**. Never commit them.
2. Enable app authenticator MFA under **Account & security** and save recovery codes privately.
3. Register the actual server's outbound static IP with ICICI. A checkbox is your acknowledgement,
   not a technical verification of that registration. Localhost needs an approved outbound IP too.
4. In **Live trading**, connect/verify ICICI. Start with a flat trading account and no existing
   same-day orders. Unmanaged positions/orders, unknown fields or inconsistent books halt activation.
5. Enter an allocation (₹100–₹5,000), current app password, a fresh authenticator/recovery code,
   and the exact confirmation phrase. Live permission lasts 15 minutes and belongs to that session.
6. Review a limit order, then explicitly confirm the real-money submission. Preview expires in
   two minutes. Repeated confirmation uses the same durable intent, not a new broker order.
7. **Switch to paper** or **Kill live submissions & cancel pending** revokes permission and
   requests cancellation of app-owned resting orders. It does **not** sell positions. Check ICICI
   directly if cancellation or submission is unresolved. Other page navigation does not halt live.

Initial scope: NSE cash, DAY LIMIT, whole-unit quantities, long-only purchases and reduce-only
exits of same-day app positions. New submissions are restricted to weekdays 09:20–15:15 IST;
stale quotes are rejected, but broker/exchange holiday and instrument eligibility still apply.
At most five outstanding orders and three new intents/minute; no market/AMO/derivatives/short
orders, selling old demat holdings, modification, or automatic position liquidation.

This API process runs live reconciliation every 45 seconds independently of the browser; a
submission additionally requires fresh books, session authorization and synchronous risk checks.
Use exactly one API process. Logout, MFA disable, credential changes, expiry and restart revoke
live authorization. Recovery may reconnect saved accounts to inspect/cancel app orders, never
to auto-enable submissions. No additional service or paid dependency was added.

Broker normalization is strict: funds, margin, order, trade and position books must agree.
The cash model conservatively uses allocated-minus-blocked capacity and adds outstanding BUY
holds back for cash-ledger reconciliation. Settlement/fee timing or an unfamiliar broker field
can halt the account; it is never silently treated as extra buying power. Actual account response
shapes, remark echoing, fills, cancellations and cash settlement behavior still require verification
with ICICI. Tests use a network-free broker double, not your credentials or real orders.

The `backend/live/` modules are an executable foundation tested using real PostgreSQL and a
network-free fake broker, not a claim that live trading is production ready:

- `contracts.ts`: broker-neutral limit orders, normalized books, cash, positions and health.
  Adapters must correlate client intent keys unambiguously and normalize order/trade evidence.
- `risk.ts`: atomic capital reservations, notional/position/loss/rate limits, repeated at dispatch.
  These conservative limits are **not** an exchange margin/SPAN or verified options-hedge model.
- `execution.ts`: owner-scoped durable intents, explicit state transitions, final DB-backed
  submission gate, active session probe, restart halt, serial reconciliation and cancel requests.
- `spread-policy.ts`: full buy-hedge fill before the sell leg, explicit slippage/deadline limits,
  and an `unwind_required` record when protection/exposure becomes uncertain or incomplete.
- `shadow.ts`: pure would-submit/risk-rejection planning from supplied snapshots. It has no
  OMS, SDK, database writer or order adapter. Live-market shadow ingestion is not wired yet.
- `icici-adapter.ts` / `icici-thread.ts`: per-account official SDK isolation, normalized cash
  books, request deadlines, retry-free execution, and the signed DELETE-body transport fix.
- `icici-routes.ts`: live activation, session-bound previews, confirmation, request budgets,
  background reconciliation and revocation. The UI never calls ICICI directly.

`SUBMITTING` is committed before broker I/O. A timeout or malformed acknowledgement becomes
`UNKNOWN`; an empty order book is **not** permission to resend. Reconciliation must establish
identity/outcome, and resumption is explicit. The broker's books are authoritative; unexplained
positions/cash, stale sessions, incomplete snapshots and loss-limit violations halt the account.
The last good baseline is retained on drift so repeated polls cannot silently accept it.

A kill latches the database gate and requests cancellation of resting orders. A cancel response
does not prove cancellation; later broker evidence must confirm it. Unreachable/late-accepting
brokers remain unresolved. Calls already in flight cannot be unsent. Positions are not silently
liquidated: the supported orphan policy records known fills and requires a human-approved unwind.
The UI/operator workflow to resolve that state still needs implementation.

Kotak is not implemented. ICICI execution is wired but has only mocked integration coverage;
no real-account verification was performed by the coding agent. Modify-order support is absent;
cancel-confirm-replace requires fresh risk approval. Broker details remain inside its adapter.

Additional live release gates include instrument/lot/tick validation, derivatives margin,
session/day rollover and book pagination, broker capability tests, durable alerts/operator recovery,
bounded audit retention, and a read-only market-fed shadow trial. No broker-specific authentication
behavior or order-status meaning is assumed to be interchangeable.
The current-day book reader does not archive/reset earlier sessions automatically: after trading,
cross-day reconciliation can remain halted until records and exposure are reviewed. Do not run
this release unattended or use it as a public trading service.

## Deploy on a single AWS Lightsail server

Keep API, worker, web, PostgreSQL, Caddy and backup service together initially. Use a Linux host
with Docker Engine/Compose, a domain and a static IPv4. Allow 80/443; restrict SSH to trusted
administration access. Do not expose 3000, 8000 or 5432. Check IPv6 rules too.

Clone your reviewed repository and copy `.env.example` to `.env`, then restrict it to mode 0600.
Configure:

```dotenv
APP_DOMAIN=algo.your-domain.example
POSTGRES_PASSWORD=RANDOM_DATABASE_ADMIN_PASSWORD
APP_DATABASE_PASSWORD=RANDOM_64_HEX_RUNTIME_PASSWORD
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

The migration container uses database administrator credentials; API/worker use a restricted
non-superuser role. Caddy overwrites the trusted client-IP header used for throttling. The API
must remain private when `TRUST_EDGE_IP=true`. Only deploy one API and one paper worker:
multiple API replicas require shared request limits and a shared broker-session registry.

`/api/health` checks database access. `/api/ready` additionally requires a fresh worker heartbeat.
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

For upgrades: back up, stop Caddy/web/API/worker, update to a reviewed commit and run `make deploy`.
Schema migration rollback requires a matching backup and application revision. Never run
`docker compose down -v` on production: that deletes database, certificates and backup volumes.

## Source map and comments

| File | Responsibility |
| --- | --- |
| `run.ts` | Start/stop the local stack and open the browser |
| `backend/main.ts` | HTTP routing, user authentication and tenant-scoped commands |
| `backend/database.ts` | Database pools, transactions, numbered migrations and audit retention |
| `backend/local-database.ts` | Private local PostgreSQL initialization and lifecycle |
| `backend/import-legacy-sqlite.ts` | Offline, one-time import; never part of the application runtime |
| `backend/security.ts` | Password hashing, request throttling and authenticated encryption |
| `backend/mfa.ts` | Authenticator enrollment, verification and one-use recovery |
| `backend/brokers.ts` | Per-user ICICI routes, quotas and SDK worker lifecycle |
| `backend/broker-thread.ts` | Isolated SDK execution and sanitized market-data messages |
| `backend/breeze.ts` | Data-only SDK wrapper, TLS safeguard and reconnect behavior |
| `backend/worker.ts` | Leased, recoverable synthetic-job processing |
| `backend/simulator.ts` | Deterministic synthetic strategy calculations |
| `backend/types.ts` | Shared row/result contracts, not runtime authorization |
| `backend/backup.ts` | Encrypted scheduled backups, optional S3 upload and decryption |
| `backend/live/` | Isolated, not-yet-connected live OMS/risk/shadow foundation |
| `frontend/src/app/page.tsx` | Login, registration, navigation and paper-workspace UI |
| `frontend/src/components/broker-panel.tsx` | Broker connection, data explorer and account security |
| `frontend/src/app/breeze-callback/page.tsx` | Explicit manual handoff of the ICICI login token |
| `tests/api.test.mjs` | Compiled-code security/reliability regression tests |
| `tests/browser.mjs` | Browser-level setup, registration, broker UI and MFA smoke test |
| `tests/postgres-fixture.mjs` | Isolated PostgreSQL schemas for tests, with scoped cleanup |
| `tests/live.test.mjs` | Live failure scenarios against a network-free fake broker |
| `.github/workflows/checks.yml` | Build, audits, container smoke tests and restore verification |

Source functions explain purpose, inputs/state boundaries and failure behavior. JSON files
cannot contain comments: `package.json` defines dependencies/scripts, `tsconfig.json` strict
compiler settings, and lockfiles exact dependency resolution. Do not hand-edit generated output,
framework-managed `next-env.d.ts`, dependency code or lockfile internals.

## Remaining release gates

Local tests use isolated PostgreSQL schemas and mocked broker traffic. Docker/backup CI,
real-domain HTTPS, off-server restoration and real ICICI login/data still require verification.
ICICI cash execution is available behind explicit user activation, but real-account execution,
settlement normalization and operational recovery have not been validated. An exchange-aware
derivatives risk engine and public support/recovery service are not implemented. Paper strategies
on the original worker do not consume broker candles; the separate Strategy lab does, with the
explicit simulation assumptions above. Options live execution and automatic deployment of
research strategies remain unavailable.
Do not claim those features or general-public production readiness based on these changes.
