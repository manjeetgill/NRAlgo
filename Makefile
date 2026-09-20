# Development shortcuts and explicit single-host deployment lifecycle commands.
COMPOSE = docker compose --env-file .env --env-file .env.release
.PHONY: run check install build migrate preflight deploy logs status stop db-start db-stop
db-start:
	node --env-file-if-exists=.env --import tsx backend/local-database.ts
db-stop:
	node --import tsx backend/local-database.ts --stop
run:
	npm run dev
check:
	npm run check
install:
	npm ci --registry=https://registry.npmjs.org
	npm ci --prefix frontend --registry=https://registry.npmjs.org
	npm run hooks:install
	python3 -m venv .runtime/python-venv
	.runtime/python-venv/bin/pip install --requirement calculation_engine/requirements.lock
build:
	npm run build
migrate:
	npm run migrate
preflight:
	npm run check:production
	docker info > /dev/null
	$(COMPOSE) config --quiet
deploy:
	$(MAKE) preflight
	$(COMPOSE) pull
	$(COMPOSE) create
	sudo /usr/bin/node --env-file=.env scripts/host-operations.mjs protect-metadata
	$(COMPOSE) up -d --no-build --pull never --wait --wait-timeout 240
	$(COMPOSE) exec -T api node -e "fetch('http://127.0.0.1:8000/api/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
logs:
	$(COMPOSE) logs --tail=100 -f
stop:
	$(COMPOSE) stop
status:
	$(COMPOSE) ps

# Builds are explicit and local; this target never deploys or contacts a real broker.
.PHONY: recovery-images recovery-check sync-market-data sync-option-data
recovery-images:
	docker build --target backend -t nraialgo-recovery-backend:local .
	docker build --target calculation -t nraialgo-recovery-calculation:local .
	docker build --target web -t nraialgo-recovery-web:local .
	docker build --target backup -t nraialgo-recovery-backup:local .
	docker build --target market-data -t nraialgo-recovery-market-data:local .
recovery-check:
	node scripts/staging-recovery.mjs
sync-market-data:
	$(MAKE) preflight
	$(COMPOSE) --profile maintenance run --rm --no-deps market-data
# Host-level F&O option-chain sync: downloads/normalizes via download_fno_historical.py
# (raw archives are cached and reused on rerun), then publishes compact Parquet via
# sync-option-eod-charts.mjs. Pass FNO_FROM/FNO_TO to control the date range; defaults
# to the last 7 days. Containerized recurring sync needs a persistent volume for
# .runtime/nse-fno (not yet wired into docker-compose.yml) — run this target on the
# host, or under `docker compose run --entrypoint`, until that volume exists.
FNO_FROM ?= $(shell date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)
FNO_TO ?= $(shell date -u +%Y-%m-%d)
FNO_OUTPUT ?= .runtime/nse-fno
sync-option-data:
	.runtime/python-venv/bin/python3 scripts/download_fno_historical.py \
		--from $(FNO_FROM) --to $(FNO_TO) --symbols ALL --legacy-provider native \
		--skip-unavailable --continue-invalid --output $(FNO_OUTPUT)
	node scripts/sync-option-eod-charts.mjs --source $(FNO_OUTPUT)/normalized
