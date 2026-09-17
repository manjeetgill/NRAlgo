# NRAlgo — Nexus Algo

My First Algo platform.

A localhost-first personal trading workspace: Next.js + React + TypeScript +
Tailwind, with a FastAPI backend and a separate Python paper replay worker.

## Start

Requires Python 3.11+ and Node 22. The development environment was verified on
Python 3.14. The dependencies are installed in `.venv` and `frontend/node_modules`.

```sh
make install  # first installation only
make run
```

`make run` opens http://localhost:3000 in your default browser once the frontend
and API are ready. Create your owner username/password (12+ characters).
To start without opening a browser, use `NEXUS_NO_BROWSER=1 make run`.
API documentation: http://127.0.0.1:8000/api/docs. Ctrl+C stops all three processes.
Run `make check` for tests and TypeScript; `make build` for the Next.js production build.

## Try the working flow

1. Create your owner account.
2. Create a strategy with ₹1,00,000 virtual capital and EMA periods 9/21.
3. Run replay. The API queues a job; the separate Python worker processes it.
4. View the equity curve, simulated fills, and activity events.
5. Pause all replays to cancel pending work and prevent new runs; resume to continue.
6. Refresh or restart: strategies, results, and account persist in `.runtime/workspace.db`.

SQLite keeps localhost free of database installation requirements. SQLAlchemy
uses the same models with PostgreSQL for Docker hosting. This is a deliberate
local simplification; the Docker configuration includes PostgreSQL.

## What is implemented

- Single owner setup, scrypt password hashing, 8-hour opaque sessions, HttpOnly
  cookies, CSRF validation, origin checks, and login attempt throttling.
- Validated strategy creation, durable job queue, one independent worker,
  pause/resume controls, deterministic paper replay, fill history, equity curves,
  and database-backed activity events.
- A responsive Next.js interface and an in-app explanation of the stack.
- Docker Compose definitions for one VPS, a Caddy HTTPS example, and an initial
  Alembic migration. API and database ports are not published by Compose.

## Honest boundaries

- The replay uses 240 **synthetic bars**, not historical or live market data.
  It trades simulated index units, not exchange-valid futures/options contracts.
  The example cost model is 0.05% slippage per fill plus ₹5 per order; taxes are
  omitted. The 2% loss threshold is a trigger, not a guarantee on realized loss.
- No broker is integrated. No broker secrets are collected. Live orders,
  options backtesting, multi-user tenancy, MFA, and continuous market strategies
  are future work. Do not use replay results to judge strategy profitability.
- Account authorization currently has one role: owner. Public registration is
  disabled after the owner is created. Local first-time setup is intended only
  for loopback access. Production first-time setup requires SETUP_TOKEN.
- Run exactly one worker. Crash recovery requeues unfinished replays; completed
  results are committed atomically. Large backtests need a more capable queue.
- Activity records are useful for development but are not a tamper-proof audit.
- The UI polls every three seconds. WebSockets can replace this when a real market
  feed exists; Redis and Celery are intentionally not required yet.
- The small UI button is an owned component using the shadcn composition pattern,
  not a claim that the full shadcn registry has been installed.

## One-VPS deployment later

No cloud resources have been created. Hosting is not needed for localhost.

On a Linux VPS with Docker Engine/Compose:

1. Create `.env` from `.env.example`. Set APP_ORIGIN to your HTTPS domain,
   SETUP_TOKEN to a random 32+ character string, and POSTGRES_PASSWORD to a random
   alphanumeric password. `python -c "import secrets; print(secrets.token_hex(32))"`
   generates a suitable value; generate a separate value for each secret.
2. Run `docker compose up -d --build`.
3. Install Caddy on the host, update `deploy/Caddyfile` with your domain, and point
   DNS at the server. Caddy forwards HTTPS requests to localhost:3000.
4. Set up PostgreSQL backups and test restoration before storing important data.

Compose runs an initial Alembic migration before starting API/worker. Local
development bootstraps tables directly. For a pre-existing local database made
by this exact schema, `alembic stamp 0001` adopts it; do not run stamp blindly on
another database. Future schema changes require new Alembic revisions.

All application services can share one small VPS. No Redis, Celery, Kubernetes,
Vercel plan, or managed database is required. Container deployment remains to be
verified on a Docker-enabled machine; this workspace is tested locally.

## Learning map

| Topic | Start here |
|---|---|
| React state, forms, typed API calls | `frontend/src/app/page.tsx` |
| Next.js API proxy | `frontend/next.config.ts` |
| Tailwind and responsive CSS | `frontend/src/app/globals.css` |
| API validation and authentication | `backend/main.py` |
| SQLAlchemy and data modeling | `backend/database.py` |
| Durable jobs and Python execution | `backend/worker.py` |
| Replay math and costs | `backend/simulator.py` |
| Backend integration tests | `tests/test_api.py` |

Build order after this MVP: broker market-data adapter → realistic instruments
and paper fills → stronger identity controls → broker sandbox → live execution.
