# DigitalOcean deployment checklist

This is the production path for one amd64 Ubuntu Droplet in DigitalOcean
Bangalore (`blr1`). It deliberately does not provision infrastructure or place
orders. Keep live execution disabled until networking, recovery and broker
registration have been verified.

## 1. Publish a release

Push the reviewed `main` commit. GitHub Actions builds the five runtime/maintenance images,
runs the isolated recovery drill, pushes immutable images to GHCR and publishes
a `release-<commit>` artifact. Download its `release.env` only after the release
job passes and save it as `/opt/nraialgo/.env.release`.

If the GHCR packages are private, log the Droplet into `ghcr.io` with a token
that has read-only package access before running `make deploy`.

## 2. Prepare the Droplet

Install Docker Engine with the Compose plugin, Node.js 22, Git and iptables.
Clone the repository into a stable directory such as `/opt/nraialgo`. Assign a
Reserved IPv4 and configure it as the persistent outbound address before
blocking container metadata access or registering the address with a broker.

Point the production hostname's DNS A record at the public/Reserved IPv4. Attach
a DigitalOcean Cloud Firewall that permits TCP 80 and 443 publicly, permits TCP
22 only from operator addresses, and does not expose PostgreSQL or internal app
ports.

Create a private Space in `blr1`, disable public listing/access, and create a
dedicated Spaces key restricted to that Space. Configure versioning/lifecycle
retention separately.

## 3. Configure non-secret settings

```sh
cd /opt/nraialgo
cp deployment/digitalocean.env.example .env
chmod 600 .env .env.release
```

Fill every blank in `.env`. Do not put database passwords, encryption keys,
Spaces keys or broker credentials in it.

## 4. Export mounted secrets

Copy `deployment/secrets.example.json` to a protected path outside the Git
checkout, replace every angle-bracket placeholder with a unique generated value
and optionally add Zerodha credentials. Keep registration empty to disable
invites. Then create a new versioned secret directory:

```sh
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /etc/nraialgo
SECRETS_DIR=/etc/nraialgo/secrets-v1 \
  node scripts/host-operations.mjs export-secrets \
  --from-file /opt/nraialgo-secrets.json
```

Run the export as the same deployment operator that runs `make preflight` and
Docker Compose. The directory remains mode 0700 but is readable by the process
that must validate and mount its files.

Back up the broker and backup encryption keys separately. Remove the source JSON
from the Droplet after verifying the mounted files and the offline recovery copy.

## 5. Validate and deploy

```sh
make preflight
make deploy
make status
```

`make deploy` pulls only digest-pinned images, creates the stack, blocks all
containers from the DigitalOcean metadata endpoint, waits for service health
and checks API readiness. Caddy obtains and renews TLS automatically after DNS
and ports 80/443 are correct.

Confirm the operational alert receiver and install the boot-persistent monitor:

```sh
node --env-file=.env scripts/host-operations.mjs configure-alerts
sudo /usr/bin/node --env-file=.env scripts/host-operations.mjs install-monitor
```

## 6. Go-live gates

- Sign in through the public HTTPS hostname and complete the one-time setup.
- Generate the TradingView URL in the app and send a draft-only test alert.
- Confirm accepting the alert only prefills the guarded ticket and never submits.
- Confirm live trading starts off, rejects an incorrect/reused 2FA code, expires
  after five minutes and can always be disabled immediately without 2FA.
- Run an actual encrypted Spaces backup/restore into a separate staging database.
- Reboot the Droplet and verify services, firewall rules, TLS and outbound
  Reserved IPv4 persistence.
- Verify alert delivery during a controlled failed-health test.
- Register the verified outbound IP with the intended execution broker before changing
  `KOTAK_STATIC_IP_CONFIRMED` / `ZERODHA_STATIC_IP_CONFIRMED` or `LIVE_TRADING_ENABLED` to `true`.

Do not enable live execution merely because containers are healthy. Recovery,
broker reconciliation and the static outbound address are separate go-live
requirements.

Official references: [Reserved IP outbound routing](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/outbound-traffic/),
[Cloud Firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/)
and the [Spaces S3-compatible API](https://docs.digitalocean.com/reference/api/spaces/).

## NSE chart data on the server

The data directory is deliberately excluded from images and Git. Set an absolute
`HISTORICAL_ARCHIVE_DIRECTORY` in `.env`, create that specific directory with owner
UID/GID 1000 (the non-root container user), and copy the verified local archive there
or bootstrap it with `make sync-market-data`. Do not recursively change ownership
of a shared directory. The API mounts this archive read-only; only the maintenance
job has write access. Ensure at least several GiB free for download scratch space.

`make sync-market-data` runs the digest-pinned NSE updater once with 512 MiB and half
a CPU, without database/broker secrets. It downloads official reports, preserves
stable instrument IDs and atomically switches the publication only on success.
Schedule this command in the host's scheduler after exchange reports are published,
outside live execution hours; capture its exit status and alert on failure. No timer
is silently installed by the application. Bootstrap defaults to 90 days, then each
run overlaps the last seven days and catches up missed days. For an explicit range:

```sh
docker compose --env-file .env --env-file .env.release --profile maintenance \
  run --rm --no-deps market-data --from 2026-01-01 --to 2026-09-18
```

Old published generations are retained for recovery; monitor disk usage and archive
obsolete generations during a maintenance window with the API stopped. Never remove
the generation referenced by `nse/current.json`. A hard-killed sync can leave
`nse/sync.lock` and scratch files: first verify no maintenance container is running,
then remove only that stale lock/scratch, not the chart archive. PostgreSQL backups
do not include Parquet files: retain a separate verified archive copy or a documented
re-download procedure. Confirm a known stock and index show the latest available
session in Watchlists before declaring the deployment ready.

### F&O option-chain history

`make sync-option-data` is the containerized counterpart for stored option-chain
history: same image, same `HISTORICAL_ARCHIVE_DIRECTORY` volume (its own
`nse-options/` subdirectory), same 512 MiB / half-CPU bound, no database/broker
secrets. It downloads and normalizes official F&O bhavcopy reports, then atomically
publishes compact Parquet the same way as the cash/index sync. Schedule it in the
host's scheduler alongside `sync-market-data`, outside live execution hours; capture
its exit status and alert on failure. Defaults to the last seven days; for an
explicit backfill range:

```sh
docker compose --env-file .env --env-file .env.release --profile maintenance \
  run --rm --no-deps option-data --from 2021-01-01 --to 2021-12-31
```

This history is a fallback for off-market option-chain charts, not a requirement for
live trading: option-chain browsing while connected to a broker is unaffected if this
is never scheduled. The same recovery rules as the cash/index archive apply —
`nse-options/current.json` is the only generation never to remove, and a hard-killed
run can leave `nse-options/sync.lock` to clean up before retrying.
