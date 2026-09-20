# DigitalOcean deployment checklist

This is the production path for one amd64 Ubuntu Droplet in DigitalOcean
Bangalore (`blr1`). It deliberately does not provision infrastructure or place
orders. Keep live execution disabled until networking, recovery and broker
registration have been verified.

## 1. Publish a release

Push the reviewed `main` commit. GitHub Actions builds the four runtime images,
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
- Run an actual encrypted Spaces backup/restore into a separate staging database.
- Reboot the Droplet and verify services, firewall rules, TLS and outbound
  Reserved IPv4 persistence.
- Verify alert delivery during a controlled failed-health test.
- Register the verified outbound IP with Kotak before changing
  `KOTAK_STATIC_IP_CONFIRMED` or `LIVE_TRADING_ENABLED` to `true`.

Do not enable live execution merely because containers are healthy. Recovery,
broker reconciliation and the static outbound address are separate go-live
requirements.

Official references: [Reserved IP outbound routing](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/outbound-traffic/),
[Cloud Firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/)
and the [Spaces S3-compatible API](https://docs.digitalocean.com/reference/api/spaces/).
