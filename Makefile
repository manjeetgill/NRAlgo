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
# Containerized F&O option-chain sync: same image and archive volume as market-data,
# a separate nse-options/ subdirectory, entrypoint overridden to sync-fno-charts.mjs
# (downloads/normalizes via download_fno_historical.py, then publishes compact Parquet
# via sync-option-eod-charts.mjs, in one process). Defaults to the last 7 days; pass
# FNO_FROM/FNO_TO for an explicit backfill range, e.g.
# `make sync-option-data FNO_FROM=2021-01-01 FNO_TO=2021-12-31`.
sync-option-data:
	$(MAKE) preflight
	$(COMPOSE) --profile maintenance run --rm --no-deps option-data \
		$(if $(FNO_FROM),--from $(FNO_FROM)) $(if $(FNO_TO),--to $(FNO_TO))
