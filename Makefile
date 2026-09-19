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
.PHONY: recovery-images recovery-check
recovery-images:
	docker build --target backend -t nraialgo-recovery-backend:local .
	docker build --target calculation -t nraialgo-recovery-calculation:local .
	docker build --target web -t nraialgo-recovery-web:local .
	docker build --target backup -t nraialgo-recovery-backup:local .
recovery-check:
	node scripts/staging-recovery.mjs
