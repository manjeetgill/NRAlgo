# NRAlgo

Personal, paper-only trading MVP. **Next.js + TypeScript** UI, **Node.js + Express**
API/worker written in **TypeScript**, SQLite locally and PostgreSQL on **AWS Lightsail**. No Python required.

## Local development

Use Node 22.13+ in the Node 22 release line:

```sh
make install
make run
```

Open http://localhost:3000. `make run` opens the browser when ready; Ctrl+C stops
all services. Use `NEXUS_NO_BROWSER=1 make run` to skip browser opening.
The `tsx` development runner executes `run.ts` and backend `.ts` files. React
components remain `.tsx`. Strict type checking covers the backend and launcher.
Production containers compile to ignored `dist/` JavaScript and run with Node,
without TypeScript/tsx installed. `npm start` requires `npm run build:backend` first.
The `.mjs` regression tests intentionally exercise the compiled production code.
`make check` runs tests/typechecking; `make build` builds Next.js. Local SQLite is
stored in `.runtime/workspace.db`; Node 22.13 labels its SQLite API experimental.

## What stays in this repo

- `frontend/`: Next.js UI and its required configuration/lockfile.
- `backend/`: API, database/migration, worker, simulator and Breeze JS wrapper.
- `tests/`, `.github/`: regression tests and Docker/PostgreSQL/HTTPS smoke test.
- Root: one Dockerfile, Compose, Caddyfile, Makefile, launcher and npm lockfile.

Keep frontend/backend together: one feature, review and deployment can cover both.
Separate containers keep their processes isolated. There is no second repository
to maintain. Lockfiles and tests are intentional, not clutter.
`node_modules`, `.next`, `.runtime`, `.env` and backups are ignored local artifacts.
Dependencies are installed inside images, not uploaded from your Mac. Development
helpers, tests and agent metadata are excluded from Docker build context.

## Deploy to AWS Lightsail

### 1. Prepare the server

- Create a **Linux/Unix, OS-only Ubuntu 24.04 LTS** instance in **Mumbai** with
  public IPv4; 4 GB RAM is the suggested starting point. Do not choose a managed
  database, load balancer or Kubernetes for this MVP.
- Attach a Lightsail **static IPv4**. Point your domain's DNS A record to it.
  Register this server's outbound static IP with Breeze when connecting the broker.
- Allow inbound TCP **80/443** in Lightsail networking; restrict SSH **22** to your
  administration IP (or use Lightsail's browser SSH access). Keep **3000/8000/5432
  closed**. Review IPv6 firewall rules too if IPv6 is enabled.
- Enable AWS-account MFA and billing alerts.
- Install Git/Make (`sudo apt update && sudo apt install -y git make`) and install
  Docker Engine with the Compose plugin using the
  [official Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/).
  Verify `sudo docker info` and `sudo docker compose version`.

### 2. Get the reviewed code and configure secrets

First ensure the JavaScript migration has been committed/pushed and CI is green.
The following clone does **not** include unpushed local changes:

```sh
git clone https://github.com/manjeetgill/NRAlgo.git
cd NRAlgo
cp .env.example .env
chmod 600 .env
```

Edit `.env` on the server and set these three values:

```dotenv
APP_DOMAIN=algo.your-domain.com
POSTGRES_PASSWORD=YOUR_RANDOM_HEX_PASSWORD
SETUP_TOKEN=YOUR_DIFFERENT_RANDOM_HEX_TOKEN
```

Replace the placeholders. Generate each secret separately (no host Node install
needed; this runs Node inside a temporary container):

```sh
sudo docker run --rm node:22-alpine node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use the hostname only for APP_DOMAIN, no scheme/path. Compose sets production mode
and HTTPS origin automatically. Never commit `.env` or use `NEXT_PUBLIC_*` for
broker credentials. Local development needs no `.env`.

### 3. Start and verify

```sh
sudo make deploy
sudo make status
sudo make logs
```

Deployment builds both images, validates application configuration, migrates the
database and waits for API/web health. Caddy obtains/renews HTTPS certificates;
DNS must point here and ports 80/443 must be reachable. Only Caddy publishes ports.
Open your HTTPS domain and create the owner account with SETUP_TOKEN. Run a paper
replay. Verify `/api/health` returns `nexus-node` with `live_enabled: false`.

The cloud PostgreSQL database starts empty: local SQLite data is **not automatically
uploaded**. Keep the local backup; plan a separate data transfer if needed.

## Backups and updates

Create a private backup from the server repo directory:

```sh
mkdir -p backups
chmod 700 backups
(umask 077; sudo docker compose exec -T db pg_dump -U nexus -d nexus -Fc > "backups/nralgo-$(date +%Y%m%d-%H%M%S).dump")
```

Check success, copy to encrypted off-server storage, schedule daily backups with
retention, and test restoration into a **new disposable database**:

```sh
sudo docker compose exec -T db createdb -U nexus restore_check
sudo docker compose exec -T db pg_restore -U nexus -d restore_check --exit-on-error < backups/YOUR_BACKUP.dump
sudo docker compose exec -T db psql -U nexus -d restore_check -c 'SELECT count(*) FROM strategies;'
```

For updates: back up, `sudo docker compose stop caddy web api worker`, pull reviewed
code using `git pull --ff-only`, then `sudo make deploy`. Expect a maintenance window.
Keep the previous commit and backup; rollback must match the database schema.
Do not rotate POSTGRES_PASSWORD only in `.env`: update the database password too.

`sudo make stop` preserves data. **Never run `docker compose down -v` on a real
deployment**: it deletes database/certificate volumes. Stopping a cloud instance
does not necessarily stop storage/IP charges. Monitor disk space, failures and
security updates. Docker restart policies do not restart a merely unhealthy process.

## Migration and security boundaries

- Existing local tables, scrypt password hashes and results survive the Python-to-JS
  migration. Stop the old launcher first. `make migrate` applies numbered migrations
  tracked in `schema_migrations`. Future changes need new versions. The old Alembic
  database marker is harmless. New synthetic results differ because the RNG changed.
- One owner, hashed 8-hour sessions, HttpOnly/SameSite cookies, Secure in production,
  CSRF/origin validation and login throttling. No MFA or public multi-user support.
- Exactly one worker. Replays use synthetic prices and fictitious index units, not
  exchange contracts. Illustrative costs exclude taxes; results do not prove profit.
- Breeze JS SDK 1.0.31 has a data-only wrapper, not a connected broker UI/live engine.
  The SDK disables TLS at import: **only load it through `backend/breeze.ts`**, which
  restores verification synchronously. Patched Axios/CSV overrides and explicit
  `adm-zip` dependency are tested with mocks. Recheck safeguards on SDK updates.
  A clean dependency audit is not a complete SDK security review.
- No live orders, real market data, high availability or tamper-proof audit trail.
  Keep this personal and paper-only until those controls are implemented.

**Release gate:** local tests/build pass, but Docker is unavailable on the development
Mac. Container CI must pass before launch. Verify real-domain HTTPS, firewall,
backup restoration and broker login separately on the server. No AWS resources or
GitHub pushes are created by preparing these files.
